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
  const git = yield* RoutineGitProvisioner;
  if (step.action === "pr.create") {
    const branch = context.workspaceStrategy.branch;
    const pr = yield* git
      .createDraftPullRequest({
        cwd: context.workspaceStrategy.worktreePath,
        branch,
        title: step.title ?? context.routineName ?? step.id,
        body: context.brief,
      })
      .pipe(Effect.mapError((cause) => new RoutineStepError({ message: cause.message, cause })));
    return {
      verdict: { label: "created", reason: "draft pull request opened" },
      outputExcerpt: pr.url ?? `Opened a draft pull request for ${branch}`,
    } satisfies RoutineStepOutcome;
  }
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
    verdict: { label: "created", reason: "pushed" },
    outputExcerpt: `Pushed ${result.branch ?? context.workspaceStrategy.branch}`,
  } satisfies RoutineStepOutcome;
});
