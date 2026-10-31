import { type RoutineActionStep } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { RoutineGitProvisioner } from "../adapters/git.ts";
import {
  RoutineStepError,
  type RoutineStepContext,
  type RoutineStepOutcome,
} from "./StepRunner.ts";

/** Runs a built-in action against the execution worktree. */
export const runActionStep = Effect.fn("RoutineSteps.runActionStep")(function* (
  step: RoutineActionStep,
  context: RoutineStepContext,
) {
  if (step.action === "pr.create") {
    // No source-control provider can open a draft yet, and PRs from routines must be drafts.
    return yield* new RoutineStepError({
      message: `Action "pr.create" is not supported yet (step "${step.id}").`,
    });
  }
  const git = yield* RoutineGitProvisioner;
  const result = yield* git
    .pushBranch({
      cwd: context.workspaceStrategy.worktreePath,
      actionId: `routine-push:${context.workspaceStrategy.branch}`,
    })
    .pipe(Effect.mapError((cause) => new RoutineStepError({ message: cause.message, cause })));
  if (!result.pushed) {
    return yield* new RoutineStepError({
      message: `Nothing to push from ${context.workspaceStrategy.branch}; commit changes first (step "${step.id}").`,
    });
  }
  return {
    verdict: { label: "pass", reason: "pushed" },
    outputExcerpt: `Pushed ${result.branch ?? context.workspaceStrategy.branch}`,
  } satisfies RoutineStepOutcome;
});
