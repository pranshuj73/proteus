import type { RoutineDefinition, RoutineStep } from "@t3tools/contracts";

export interface RoutineGraphDiff {
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  /** Steps present in both whose fields differ, with the names of those fields. */
  readonly changed: ReadonlyArray<{ readonly id: string; readonly fields: ReadonlyArray<string> }>;
  /** Routine-level fields (name, start, council) that differ. */
  readonly routineFields: ReadonlyArray<string>;
}

const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);

const changedFields = (before: RoutineStep, after: RoutineStep): string[] => {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => differs(Reflect.get(before, key), Reflect.get(after, key)))
    .toSorted();
};

/** Compares a routine against its last approved version, step by step. */
export function diffRoutineDefinitions(
  approved: RoutineDefinition,
  current: RoutineDefinition,
): RoutineGraphDiff {
  const before = new Map(approved.steps.map((step) => [step.id as string, step]));
  const after = new Map(current.steps.map((step) => [step.id as string, step]));
  const changed: Array<{ id: string; fields: string[] }> = [];
  for (const [id, step] of after) {
    const previous = before.get(id);
    if (previous === undefined) continue;
    const fields = changedFields(previous, step);
    if (fields.length > 0) changed.push({ id, fields });
  }
  const { steps: _approvedSteps, ...approvedRest } = approved;
  const { steps: _currentSteps, ...currentRest } = current;
  return {
    added: [...after.keys()].filter((id) => !before.has(id)),
    removed: [...before.keys()].filter((id) => !after.has(id)),
    changed,
    routineFields: [...new Set([...Object.keys(approvedRest), ...Object.keys(currentRest)])]
      .filter((key) => differs(Reflect.get(approvedRest, key), Reflect.get(currentRest, key)))
      .toSorted(),
  };
}

export const isEmptyRoutineDiff = (diff: RoutineGraphDiff): boolean =>
  diff.added.length === 0 &&
  diff.removed.length === 0 &&
  diff.changed.length === 0 &&
  diff.routineFields.length === 0;
