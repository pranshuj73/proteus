import {
  type ModelSelection,
  type ProviderUserInputAnswers,
  type ProjectId,
  type RoutineStep,
  type RoutineVerdict,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { RoutineGitProvisioner } from "../adapters/git.ts";
import type { RoutineProcessRunner } from "../adapters/process.ts";
import type {
  RoutineThreadQuestion,
  RoutineThreadRunner,
  RoutineWorkspaceStrategy,
} from "../adapters/threads.ts";
import { runAgentOrSkillStep } from "./agent.ts";
import { runActionStep } from "./action.ts";
import { runCommandStep } from "./command.ts";

/** A single step failed to execute; the executor turns this into a failed execution. */
export class RoutineStepError extends Schema.TaggedError<RoutineStepError>()("RoutineStepError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Everything a step runner needs that does not come from the step definition itself. */
export interface RoutineStepContext {
  readonly projectId: ProjectId;
  readonly brief: string;
  /** Default pull request title when a `pr.create` step has none. */
  readonly routineName?: string | undefined;
  readonly workspaceStrategy: RoutineWorkspaceStrategy;
  readonly modelSelection?: ModelSelection | undefined;
  /** The council: answers a step thread's user-input request so the run does not wait on a human. */
  readonly answerQuestion?:
    | ((
        threadId: ThreadId,
        question: RoutineThreadQuestion,
      ) => Effect.Effect<ProviderUserInputAnswers, RoutineStepError>)
    | undefined;
  readonly onThreadLaunched?: ((threadId: ThreadId) => Effect.Effect<void>) | undefined;
}

export interface RoutineStepOutcome {
  readonly verdict: RoutineVerdict;
  readonly outputExcerpt?: string | undefined;
  readonly threadId?: ThreadId | undefined;
}

export type RoutineStepRequirements =
  | RoutineProcessRunner
  | RoutineThreadRunner
  | RoutineGitProvisioner
  | Path.Path;

/** Kind-keyed registry: `command` runs a process, `agent`/`skill` run a thread. */
export const runStep = (
  step: RoutineStep,
  context: RoutineStepContext,
): Effect.Effect<RoutineStepOutcome, RoutineStepError, RoutineStepRequirements> => {
  switch (step.kind) {
    case "command":
      return runCommandStep(step, context);
    case "agent":
    case "skill":
      return runAgentOrSkillStep(step, context);
    case "action":
      return runActionStep(step, context);
  }
};
