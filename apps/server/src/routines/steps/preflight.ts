import { type RoutineDefinition, RoutineError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { RoutineProcessRunner } from "../adapters/process.ts";
import {
  hashSkillFolder,
  isLinkHealthy,
  linkSkill,
  providerSkillDirs,
  readLock,
  referencedSkills,
  SKILLS_DIR,
  SKILLS_LOCK,
} from "../skills.ts";

/** Seam over `npx skills add`; tests supply a fake so nothing touches the network. */
export class RoutineSkillInstaller extends Context.Service<
  RoutineSkillInstaller,
  {
    readonly install: (input: {
      readonly cwd: string;
      readonly source: string;
      readonly name: string;
    }) => Effect.Effect<void, RoutineError>;
  }
>()("t3/routines/steps/preflight/RoutineSkillInstaller") {}

export interface SkillPreflightInput {
  /** Execution worktree; installs land here and are committed on its branch. */
  readonly worktreePath: string;
  readonly definition: RoutineDefinition;
  /** Provider driver kinds used by the routine's steps and council. */
  readonly providers: ReadonlyArray<string>;
}

const fail = (message: string) => new RoutineError({ message });

/**
 * Verifies every referenced skill against skills-lock.json, installing missing ones, linking them
 * into provider directories and committing project installs. Any drift aborts the start.
 * Returns the folder hash per skill so approval can pin them.
 */
export const runSkillPreflight = Effect.fn("RoutineSkills.preflight")(function* (
  input: SkillPreflightInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const refs = referencedSkills(input.definition);
  const hashes = new Map<string, string>();
  if (refs.length === 0) return hashes;

  const pins = yield* readLock(input.worktreePath);
  const installer = yield* RoutineSkillInstaller;
  const process = yield* RoutineProcessRunner;
  const linkDirs = providerSkillDirs(input.providers);
  let installedAny = false;

  for (const ref of refs) {
    const pin = pins.get(ref.name);
    if (ref.source !== undefined && pin === undefined) {
      return yield* fail(`Skill "${ref.name}" is not pinned in ${SKILLS_LOCK}.`);
    }
    if (ref.source !== undefined && pin?.source !== undefined && pin.source !== ref.source) {
      return yield* fail(`Skill "${ref.name}" is locked to ${pin.source}, not ${ref.source}.`);
    }
    const dir = path.join(input.worktreePath, SKILLS_DIR, ref.name);
    if (!(yield* fs.exists(path.join(dir, "SKILL.md")))) {
      if (ref.source === undefined) {
        return yield* fail(`Local skill "${ref.name}" is missing from ${SKILLS_DIR}.`);
      }
      yield* installer.install({ cwd: input.worktreePath, source: ref.source, name: ref.name });
      installedAny = true;
      if (!(yield* fs.exists(path.join(dir, "SKILL.md")))) {
        return yield* fail(
          `Installing skill "${ref.name}" did not produce ${SKILLS_DIR}/${ref.name}.`,
        );
      }
    }
    const hash = yield* hashSkillFolder(dir).pipe(
      Effect.mapError(
        (cause) => new RoutineError({ message: `Cannot hash skill "${ref.name}".`, cause }),
      ),
    );
    if (pin?.hash !== undefined && pin.hash !== hash) {
      return yield* fail(`Skill "${ref.name}" does not match its locked hash.`);
    }
    hashes.set(ref.name, hash);
    for (const providerDir of linkDirs) {
      yield* linkSkill({ workspaceRoot: input.worktreePath, providerDir, name: ref.name }).pipe(
        Effect.mapError(
          (cause) => new RoutineError({ message: `Cannot link skill "${ref.name}".`, cause }),
        ),
      );
      if (!(yield* isLinkHealthy(input.worktreePath, providerDir, ref.name))) {
        return yield* fail(`Skill "${ref.name}" has a broken link in ${providerDir}.`);
      }
    }
  }

  if (installedAny) {
    const run = (argv: ReadonlyArray<string>) =>
      process
        .run({ argv, cwd: input.worktreePath, maxOutputBytes: 4000 })
        .pipe(Effect.mapError((cause) => new RoutineError({ message: cause.message, cause })));
    const candidates = [SKILLS_DIR, SKILLS_LOCK, ...linkDirs];
    const present: Array<string> = [];
    for (const candidate of candidates) {
      if (yield* fs.exists(path.join(input.worktreePath, candidate))) present.push(candidate);
    }
    yield* run(["git", "add", "-A", "--", ...present]);
    const commit = yield* run(["git", "commit", "-m", "chore: install skills", "--allow-empty"]);
    if (commit.code !== 0)
      return yield* fail(`Committing installed skills failed: ${commit.output}`);
  }
  return hashes;
});

/** Installs through `npx skills add` in the execution worktree. */
export const installerLayer = Layer.effect(
  RoutineSkillInstaller,
  Effect.gen(function* () {
    const processRunner = yield* RoutineProcessRunner;
    return RoutineSkillInstaller.of({
      install: Effect.fn("RoutineSkills.install")(function* (input) {
        const result = yield* processRunner
          .run({
            argv: ["npx", "--yes", "skills", "add", input.source, "--skill", input.name, "-y"],
            cwd: input.cwd,
            timeoutMs: 120_000,
            maxOutputBytes: 4000,
          })
          .pipe(Effect.mapError((cause) => new RoutineError({ message: cause.message, cause })));
        if (result.code !== 0 || result.timedOut) {
          return yield* new RoutineError({
            message: `Installing skill "${input.name}" from ${input.source} failed: ${result.output}`,
          });
        }
      }),
    });
  }),
);
