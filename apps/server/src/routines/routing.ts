import type { RoutineDefinition, RoutineStepId } from "@t3tools/contracts";

/**
 * Pure successor resolution for the lean executor. A step with `on` routes by
 * verdict label (skipping `$end`); otherwise `next` is followed unconditionally.
 * Terminal steps return `[]`. Written to be extended by later tickets (joins,
 * fan-out, retries) without changing the executor.
 */
export const nextSteps = (
  definition: RoutineDefinition,
  stepId: RoutineStepId,
  verdictLabel: string,
): ReadonlyArray<RoutineStepId> => {
  const step = definition.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) return [];
  if (step.on !== undefined) {
    const target = step.on[verdictLabel];
    if (target === undefined || target === "$end") return [];
    return [target];
  }
  if (step.next !== undefined) return step.next;
  return [];
};
