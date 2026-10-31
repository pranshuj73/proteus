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
}

export type RoutineSaveOutput =
  | { readonly saved: true; readonly path: string }
  | { readonly saved: false; readonly issues: ReadonlyArray<RoutineValidationIssue> };

export class RoutineAuthoring extends Context.Service<
  RoutineAuthoring,
  {
    readonly validateDefinition: (
      input: RoutineValidateInput,
    ) => Effect.Effect<RoutineValidateOutput, RoutineError>;
    readonly saveDefinition: (
      input: RoutineSaveInput,
    ) => Effect.Effect<RoutineSaveOutput, RoutineError>;
  }
>()("t3/routines/RoutineAuthoring") {}

const make = Effect.gen(function* () {
  const projectService = yield* ProjectService.ProjectService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

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
    if (issues.length > 0) {
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
    return { saved: true, path: `.proteus/routines/${input.routineId}.json` };
  });

  return RoutineAuthoring.of({ validateDefinition, saveDefinition });
});

export const layer = Layer.effect(RoutineAuthoring, make);
