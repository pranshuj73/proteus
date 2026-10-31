import type {
  EnvironmentId,
  RoutineControlInput,
  RoutineExecution,
  RoutineExecutionStep,
} from "@t3tools/contracts";
import { routineStepVerdictLabels } from "@t3tools/contracts";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

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

  const failed = steps.findLast((step) => step.status === "failed");
  const definition = execution.definition.steps.find((step) => step.id === failed?.stepId);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button size="compact" variant="ghost" onClick={() => send({ executionId, action: "retry" })}>
        Retry
      </Button>
      {failed === undefined || definition === undefined
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
