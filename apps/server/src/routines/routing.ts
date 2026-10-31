import type { RoutineDefinition, RoutineStep, RoutineStepId } from "@t3tools/contracts";

/**
 * Pure successor resolution for the lean executor. A step with `on` routes by
 * verdict label (skipping `$end`); otherwise `next` is followed unconditionally.
 * Terminal steps return `[]`; several ids fan out in parallel.
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

export const DEFAULT_MAX_ITERATIONS = 10;

/** Most times a step may run in one execution; loops are bounded by the target's `maxIterations`. */
export const attemptLimit = (step: RoutineStep): number =>
  step.maxIterations ?? DEFAULT_MAX_ITERATIONS;

/**
 * Splits steps reached into those that run now and those still waiting. A step
 * with `join` runs only once every joined step has succeeded; the rest wait.
 */
export const resolveReady = (
  definition: RoutineDefinition,
  reached: ReadonlyArray<RoutineStepId>,
  done: ReadonlySet<RoutineStepId>,
): {
  readonly ready: ReadonlyArray<RoutineStepId>;
  readonly waiting: ReadonlyArray<RoutineStepId>;
} => {
  const ready: RoutineStepId[] = [];
  const waiting: RoutineStepId[] = [];
  for (const id of new Set(reached)) {
    const join = definition.steps.find((candidate) => candidate.id === id)?.join;
    (join === undefined || join.every((dependency) => done.has(dependency)) ? ready : waiting).push(
      id,
    );
  }
  return { ready, waiting };
};
