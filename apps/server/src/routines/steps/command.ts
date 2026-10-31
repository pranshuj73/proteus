import { type RoutineCommandStep, type RoutineVerdict } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { RoutineProcessRunner } from "../adapters/process.ts";
import type { RoutineStepContext, RoutineStepOutcome } from "./StepRunner.ts";

const DEFAULT_MAX_OUTPUT_BYTES = 16384;

/** Runs the step's argv in the execution worktree; pass/fail follows the exit code. */
export const runCommandStep = Effect.fn("RoutineSteps.runCommandStep")(function* (
  step: RoutineCommandStep,
  context: RoutineStepContext,
) {
  const path = yield* Path.Path;
  const runner = yield* RoutineProcessRunner;
  const base = context.workspaceStrategy.worktreePath;
  const cwd = step.cwd === undefined ? base : path.join(base, step.cwd);
  const maxOutputBytes = step.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const passExitCodes = step.passExitCodes ?? [0];

  const result = yield* runner.run({
    argv: step.argv,
    cwd,
    maxOutputBytes,
    ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
  });

  const passed = !result.timedOut && result.code !== null && passExitCodes.includes(result.code);
  const verdict: RoutineVerdict = result.timedOut
    ? { label: "fail", reason: "timed out" }
    : passed
      ? { label: "pass", reason: `exit ${result.code}` }
      : { label: "fail", reason: `exit ${result.code ?? "unknown"}` };

  return { verdict, outputExcerpt: result.output } satisfies RoutineStepOutcome;
});
