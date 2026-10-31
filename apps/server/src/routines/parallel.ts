import * as Effect from "effect/Effect";

import { RoutineProcessRunner } from "./adapters/process.ts";

const MAX_OUTPUT_BYTES = 4096;
const IDENTITY = ["-c", "user.name=Proteus", "-c", "user.email=routines@proteus.local"];

export type MergeResult =
  | { readonly merged: true }
  | { readonly merged: false; readonly files: ReadonlyArray<string> };

// A git failure here is unrecoverable for the execution, so it surfaces as a defect the walk reports.
const git = (cwd: string, args: ReadonlyArray<string>) =>
  RoutineProcessRunner.use((runner) =>
    runner.run({ argv: ["git", ...IDENTITY, ...args], cwd, maxOutputBytes: MAX_OUTPUT_BYTES }),
  ).pipe(Effect.orDie);

/** Commits everything in the worktree so a branch can be forked from or merged with its state. */
export const commitAll = Effect.fn("RoutineParallel.commitAll")(function* (
  cwd: string,
  message: string,
) {
  const status = yield* git(cwd, ["status", "--porcelain"]);
  if (status.output.trim() === "") return;
  yield* git(cwd, ["add", "-A"]);
  yield* git(cwd, ["commit", "-m", message]);
});

/** Merges a branch into the worktree's; a conflict is aborted and reported by file. */
export const mergeBranch = Effect.fn("RoutineParallel.mergeBranch")(function* (
  cwd: string,
  branch: string,
): Effect.fn.Return<MergeResult, never, RoutineProcessRunner> {
  const merge = yield* git(cwd, ["merge", "--no-ff", "--no-edit", branch]);
  if (merge.code === 0) return { merged: true };
  const conflicted = yield* git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  yield* git(cwd, ["merge", "--abort"]);
  return {
    merged: false,
    files: conflicted.output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  };
});
