import {
  type ModelSelection,
  type ProjectId,
  type RoutineStep,
  type RoutineVerdict,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { RoutineProcessRunner } from "../adapters/process.ts";
import type { RoutineThreadRunner, RoutineWorkspaceStrategy } from "../adapters/threads.ts";
import { runAgentOrSkillStep } from "./agent.ts";
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
  readonly workspaceStrategy: RoutineWorkspaceStrategy;
  readonly modelSelection?: ModelSelection | undefined;
}

export interface RoutineStepOutcome {
  readonly verdict: RoutineVerdict;
  readonly outputExcerpt?: string | undefined;
  readonly threadId?: ThreadId | undefined;
}

export type RoutineStepRequirements = RoutineProcessRunner | RoutineThreadRunner | Path.Path;

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
      return Effect.fail(
        new RoutineStepError({
          message: `Action steps are not supported by the lean executor (step "${step.id}").`,
        }),
      );
  }
};
