import type {
  EnvironmentId,
  RoutineControlInput,
  RoutineExecution,
  RoutineExecutionStep,
} from "@t3tools/contracts";
import { routineStepVerdictLabels } from "@t3tools/contracts";

import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function RoutineExecutionControls({
  execution,
  steps,
  environmentId,
}: {
  readonly execution: RoutineExecution;
  readonly steps: ReadonlyArray<RoutineExecutionStep>;
  readonly environmentId: EnvironmentId;
}) {
  const control = useAtomCommand(serverEnvironment.controlRoutine, { label: "routine control" });
  const send = (input: RoutineControlInput) => void control({ environmentId, input });
  const executionId = execution.id;
  const [note, setNote] = useState("");

  if (execution.status === "running") {
    return (
      <Button size="compact" variant="ghost" onClick={() => send({ executionId, action: "pause" })}>
        Pause
      </Button>
    );
  }
  if (execution.status === "paused" || execution.status === "interrupted") {
    return (
      <Button
        size="compact"
        variant="ghost"
        onClick={() => send({ executionId, action: "resume" })}
      >
        Resume
      </Button>
    );
  }
  if (execution.status !== "failed" && execution.status !== "needs_attention") return null;

  const asking = steps
    .filter((step) => step.status === "running")
    .map((row) => execution.definition.steps.find((step) => step.id === row.stepId))
    .find((step) => step?.kind === "human");
  if (execution.status === "needs_attention" && asking?.kind === "human") {
    return (
      <div className="flex flex-wrap items-center gap-1">
        <Input
          aria-label="Note for the routine"
          value={note}
          placeholder="Add a note (optional)"
          onChange={(event) => setNote(event.target.value)}
        />
        {asking.verdict.labels.map((label) => (
          <Button
            key={label}
            size="compact"
            variant="outline"
            onClick={() => {
              send({ executionId, action: "respond", stepId: asking.id, label, note });
              setNote("");
            }}
          >
            {label}
          </Button>
        ))}
      </div>
    );
  }

  // Conflicted branches finished their step, so the step comes from the merge error.
  const conflictStep = execution.error?.match(/^Merge conflict joining step "([^"]+)"/)?.[1];
  const conflicted = execution.definition.steps.find((step) => step.id === conflictStep);
  const failed = steps.findLast((step) => step.status === "failed");
  const definition = execution.definition.steps.find((step) => step.id === failed?.stepId);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button size="compact" variant="ghost" onClick={() => send({ executionId, action: "retry" })}>
        Retry
      </Button>
      {conflicted === undefined ? null : (
        <Button
          size="compact"
          variant="ghost"
          onClick={() =>
            send({
              executionId,
              action: "skip",
              stepId: conflicted.id,
              label: routineStepVerdictLabels(conflicted)[0] ?? "",
              reason: "Branch dropped in the Routines tab",
            })
          }
        >
          Drop {conflicted.title ?? conflicted.id} branch
        </Button>
      )}
      {conflicted !== undefined || failed === undefined || definition === undefined
        ? null
        : routineStepVerdictLabels(definition).map((label) => (
            <Button
              key={label}
              size="compact"
              variant="ghost"
              onClick={() =>
                send({
                  executionId,
                  action: "skip",
                  stepId: failed.stepId,
                  label,
                  reason: "Chosen in the Routines tab",
                })
              }
            >
              Skip as {label}
            </Button>
          ))}
      {execution.definition.steps.map((step) => (
        <Button
          key={step.id}
          size="compact"
          variant="ghost"
          onClick={() => send({ executionId, action: "restart", stepId: step.id })}
        >
          Restart from {step.title ?? step.id}
        </Button>
      ))}
    </div>
  );
}
