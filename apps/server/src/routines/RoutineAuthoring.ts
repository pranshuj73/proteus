import {
  type ProjectId,
  type RoutineDefinition,
  type RoutineId,
  type RoutineValidationIssue,
  RoutineError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectService from "../project/ProjectService.ts";
import { RoutineProcessRunner } from "./adapters/process.ts";
import {
  type InstalledSkill,
  listInstalledSkills,
  parseSkillSearch,
  readLock,
  type SkillCandidate,
} from "./skills.ts";
import { canonicalRoutineText, writeCanonical } from "./RoutineStore.ts";
import { validateRoutine } from "./RoutineValidator.ts";

export interface RoutineValidateInput {
  readonly projectId: ProjectId;
  readonly definition: RoutineDefinition;
}

export interface RoutineValidateOutput {
  readonly issues: ReadonlyArray<RoutineValidationIssue>;
  readonly canonicalText: string;
}

export interface RoutineSaveInput {
  readonly projectId: ProjectId;
  readonly routineId: RoutineId;
  readonly definition: RoutineDefinition;
  /** Keeps a draft that still fails validation; it shows as invalid and cannot be approved. */
  readonly saveInvalid?: boolean | undefined;
}

export type RoutineSaveOutput =
  | {
      readonly saved: true;
      readonly path: string;
      readonly issues?: ReadonlyArray<RoutineValidationIssue>;
    }
  | { readonly saved: false; readonly issues: ReadonlyArray<RoutineValidationIssue> };

export interface RoutineSkillsInput {
  readonly projectId: ProjectId;
  /** When set, also runs `npx skills find` after the installed catalog. Read-only; installs nothing. */
  readonly query?: string | undefined;
}

export interface RoutineSkillsOutput {
  readonly installed: ReadonlyArray<InstalledSkill>;
  /** Null when the search did not run or failed. */
  readonly found: ReadonlyArray<SkillCandidate> | null;
  /** CLI text, only when it returned output this version cannot parse. */
  readonly foundRaw: string | null;
}

export class RoutineAuthoring extends Context.Service<
  RoutineAuthoring,
  {
    readonly validateDefinition: (
      input: RoutineValidateInput,
    ) => Effect.Effect<RoutineValidateOutput, RoutineError>;
    readonly saveDefinition: (
      input: RoutineSaveInput,
    ) => Effect.Effect<RoutineSaveOutput, RoutineError>;
    readonly listSkills: (
      input: RoutineSkillsInput,
    ) => Effect.Effect<RoutineSkillsOutput, RoutineError>;
  }
>()("t3/routines/RoutineAuthoring") {}

const make = Effect.gen(function* () {
  const projectService = yield* ProjectService.ProjectService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* RoutineProcessRunner;

  const resolveWorkspaceRoot = Effect.fn("RoutineAuthoring.resolveWorkspaceRoot")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectService
      .getById(projectId)
      .pipe(
        Effect.mapError(
          (cause) =>
            new RoutineError({ message: "Failed to resolve project for routines.", cause }),
        ),
      );
    if (Option.isNone(project)) {
      return yield* new RoutineError({ message: `Project ${projectId} not found.` });
    }
    return project.value.workspaceRoot;
  });

  const validateDefinition: RoutineAuthoring["Service"]["validateDefinition"] = Effect.fn(
    "RoutineAuthoring.validateDefinition",
  )(function* (input) {
    return {
      issues: validateRoutine(input.definition),
      canonicalText: canonicalRoutineText(input.definition),
    };
  });

  const saveDefinition: RoutineAuthoring["Service"]["saveDefinition"] = Effect.fn(
    "RoutineAuthoring.saveDefinition",
  )(function* (input) {
    const issues = validateRoutine(input.definition);
    if (issues.length > 0 && input.saveInvalid !== true) {
      return { saved: false, issues };
    }
    const workspaceRoot = yield* resolveWorkspaceRoot(input.projectId);
    yield* writeCanonical({
      workspaceRoot,
      definition: input.definition,
      id: input.routineId,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new RoutineError({ message: "Failed to write routine.", cause })),
    );
    return {
      saved: true,
      path: `.proteus/routines/${input.routineId}.json`,
      ...(issues.length > 0 ? { issues } : {}),
    };
  });

  const listSkills: RoutineAuthoring["Service"]["listSkills"] = Effect.fn(
    "RoutineAuthoring.listSkills",
  )(function* (input) {
    const workspaceRoot = yield* resolveWorkspaceRoot(input.projectId);
    const installed = yield* listInstalledSkills(workspaceRoot).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const query = input.query?.trim();
    if (query === undefined || query.length === 0)
      return { installed, found: null, foundRaw: null };
    const output = yield* processRunner
      .run({
        argv: ["npx", "--yes", "skills", "find", query],
        cwd: workspaceRoot,
        timeoutMs: 30_000,
        maxOutputBytes: 8000,
      })
      .pipe(
        Effect.map((result) => result.output.trim()),
        Effect.orElseSucceed(() => null),
      );
    if (output === null) return { installed, found: null, foundRaw: null };
    const pins = yield* readLock(workspaceRoot).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const found = parseSkillSearch(output, {
      installedNames: new Set(installed.map((skill) => skill.name)),
      lockedSources: new Set(
        [...pins.values()].flatMap((pin) => (pin.source === undefined ? [] : [pin.source])),
      ),
    });
    return { installed, found, foundRaw: found.length === 0 ? output : null };
  });

  return RoutineAuthoring.of({ validateDefinition, saveDefinition, listSkills });
});

export const layer = Layer.effect(RoutineAuthoring, make);
