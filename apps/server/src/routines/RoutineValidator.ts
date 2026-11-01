import {
  type RoutineDefinition,
  type RoutineStep,
  type RoutineStepId,
  type RoutineValidationIssue,
  routineStepVerdictLabels,
} from "@t3tools/contracts";

const SKILL_REF_PATTERN = /^(?:[\w.-]+\/[\w.-]+@[\w.-]+|[\w.-]+)$/;

/**
 * Pure structural validation of a decoded routine. Decode-time failures
 * (`invalid-json`, `schema`, `invalid-routine-id`) are produced by the store.
 */
export function validateRoutine(def: RoutineDefinition): RoutineValidationIssue[] {
  const issues: RoutineValidationIssue[] = [];
  const steps = def.steps;
  const push = (code: string, message: string, path: string, stepId?: RoutineStepId): void => {
    issues.push({ code, message, path, ...(stepId === undefined ? {} : { stepId }) });
  };

  const indexById = new Map<string, number>();
  steps.forEach((step, index) => {
    if (!indexById.has(step.id)) indexById.set(step.id, index);
  });

  const successors = (step: RoutineStep): ReadonlyArray<string> => [
    ...(step.next ?? []),
    ...Object.values(step.on ?? {}).filter((target) => target !== "$end"),
    ...(step.onError === undefined ? [] : [step.onError]),
  ];

  /** Every step reachable from `from` by at least one transition. */
  const reachableFrom = (from: ReadonlyArray<string>): Set<string> => {
    const found = new Set<string>();
    const queue = [...from];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (found.has(id)) continue;
      found.add(id);
      const step = steps[indexById.get(id) ?? -1];
      if (step !== undefined) queue.push(...successors(step));
    }
    return found;
  };

  const checkBackEdge = (
    target: string,
    path: string,
    source: RoutineStep,
    sourceIndex: number,
  ) => {
    const targetIndex = indexById.get(target);
    if (targetIndex === undefined || targetIndex > sourceIndex) return;
    if (steps[targetIndex]?.maxIterations === undefined) {
      push(
        "loop-without-bound",
        `Transition to "${target}" is a back-edge, but "${target}" declares no maxIterations.`,
        path,
        source.id,
      );
    }
  };

  const seen = new Set<string>();
  steps.forEach((step, i) => {
    if (seen.has(step.id)) {
      push("duplicate-step-id", `Duplicate step id "${step.id}".`, `steps[${i}].id`, step.id);
    } else {
      seen.add(step.id);
    }

    if (step.kind === "skill" || step.kind === "agent" || step.kind === "human") {
      const labelSeen = new Set<string>();
      step.verdict.labels.forEach((label) => {
        if (labelSeen.has(label)) {
          push(
            "duplicate-label",
            `Duplicate verdict label "${label}".`,
            `steps[${i}].verdict.labels`,
            step.id,
          );
        } else {
          labelSeen.add(label);
        }
      });
    }

    if (step.kind === "skill" && !SKILL_REF_PATTERN.test(step.skill)) {
      push(
        "invalid-skill-ref",
        `Invalid skill reference "${step.skill}".`,
        `steps[${i}].skill`,
        step.id,
      );
    }

    if (step.next !== undefined && step.on !== undefined) {
      push("next-and-on", `Step declares both next and on.`, `steps[${i}]`, step.id);
    }

    step.inputs?.forEach((ref, j) => {
      if (!indexById.has(ref)) {
        push("unknown-step-ref", `Unknown step "${ref}".`, `steps[${i}].inputs[${j}]`, step.id);
      } else if (
        indexById.get(ref)! >= i &&
        !reachableFrom(successors(steps[indexById.get(ref)!]!)).has(step.id)
      ) {
        push(
          "input-not-earlier",
          `Input "${ref}" is not declared before this step and no loop leads from it to this step.`,
          `steps[${i}].inputs[${j}]`,
          step.id,
        );
      }
    });

    step.next?.forEach((ref, j) => {
      if (!indexById.has(ref)) {
        push("unknown-step-ref", `Unknown step "${ref}".`, `steps[${i}].next[${j}]`, step.id);
      } else {
        checkBackEdge(ref, `steps[${i}].next[${j}]`, step, i);
      }
    });

    if (step.on !== undefined) {
      const labels = routineStepVerdictLabels(step);
      const labelSet = new Set(labels);
      for (const key of Object.keys(step.on)) {
        if (!labelSet.has(key)) {
          push(
            "unknown-label",
            `Unknown verdict label "${key}".`,
            `steps[${i}].on.${key}`,
            step.id,
          );
        }
      }
      for (const label of labels) {
        if (!(label in step.on)) {
          push(
            "missing-transition",
            `Verdict label "${label}" has no transition.`,
            `steps[${i}].on.${label}`,
            step.id,
          );
        }
      }
      for (const [label, target] of Object.entries(step.on)) {
        if (target === "$end") continue;
        if (!indexById.has(target)) {
          push("unknown-step-ref", `Unknown step "${target}".`, `steps[${i}].on.${label}`, step.id);
        } else {
          checkBackEdge(target, `steps[${i}].on.${label}`, step, i);
        }
      }
    }

    if (step.onError !== undefined) {
      if (!indexById.has(step.onError)) {
        push("unknown-step-ref", `Unknown step "${step.onError}".`, `steps[${i}].onError`, step.id);
      } else {
        checkBackEdge(step.onError, `steps[${i}].onError`, step, i);
      }
    }

    step.join?.forEach((ref, j) => {
      if (!indexById.has(ref)) {
        push("unknown-step-ref", `Unknown step "${ref}".`, `steps[${i}].join[${j}]`, step.id);
      }
    });
  });

  const startId = def.start ?? steps[0]?.id ?? "";
  if (def.start !== undefined && !indexById.has(def.start)) {
    push("unknown-step-ref", `Unknown start step "${def.start}".`, "start");
  }

  const reachable = indexById.has(startId) ? reachableFrom([startId]) : new Set<string>();
  steps.forEach((step, i) => {
    if (!reachable.has(step.id)) {
      push(
        "unreachable-step",
        `Step "${step.id}" is not reachable from start.`,
        `steps[${i}]`,
        step.id,
      );
    }
  });

  return issues;
}
