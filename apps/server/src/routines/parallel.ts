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

/** Commit a worktree stands on, after committing pending work as the step-start checkpoint. */
export const checkpoint = Effect.fn("RoutineParallel.checkpoint")(function* (cwd: string) {
  yield* commitAll(cwd, "Routine checkpoint");
  return (yield* git(cwd, ["rev-parse", "HEAD"])).output.trim();
});

/** True when the worktree moved past `head`, either by commits or uncommitted changes. */
export const movedSince = Effect.fn("RoutineParallel.movedSince")(function* (
  cwd: string,
  head: string,
) {
  const status = yield* git(cwd, ["status", "--porcelain"]);
  const current = yield* git(cwd, ["rev-parse", "HEAD"]);
  return status.output.trim() !== "" || current.output.trim() !== head;
});

export const restoreCheckpoint = Effect.fn("RoutineParallel.restoreCheckpoint")(function* (
  cwd: string,
  head: string,
) {
  yield* git(cwd, ["reset", "--hard", head]);
  yield* git(cwd, ["clean", "-fd"]);
});

/** What deleting a worktree would lose: uncommitted changes and commits on no remote. */
export const worktreeRisks = Effect.fn("RoutineParallel.worktreeRisks")(function* (cwd: string) {
  const status = yield* git(cwd, ["status", "--porcelain"]);
  const unpushed = yield* git(cwd, ["log", "--oneline", "HEAD", "--not", "--remotes"]);
  return [
    ...(status.output.trim() === "" ? [] : ["uncommitted changes"]),
    ...(unpushed.output.trim() === "" ? [] : ["unpushed commits"]),
  ];
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
