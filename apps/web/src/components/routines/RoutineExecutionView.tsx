import type { ComponentProps } from "react";

import type {
  EnvironmentId,
  RoutineExecutionId,
  RoutineExecutionStep,
  RoutineStepRunStatus,
} from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { RoutineGraph } from "./RoutineGraph";

type BadgeVariant = ComponentProps<typeof Badge>["variant"];

const STEP_BADGE: Record<
  RoutineStepRunStatus,
  { readonly variant: BadgeVariant; readonly label: string }
> = {
  pending: { variant: "secondary", label: "Pending" },
  running: { variant: "info", label: "Running" },
  done: { variant: "success", label: "Done" },
  failed: { variant: "error", label: "Failed" },
};

function RoutineStepRow({ step }: { readonly step: RoutineExecutionStep }) {
  const badge = STEP_BADGE[step.status];
  return (
    <li className="flex flex-col gap-1.5 rounded-md border bg-card p-2.5">
      <div className="flex items-center gap-2">
        <Badge variant={badge.variant} size="sm" className="shrink-0">
          {badge.label}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          {step.stepId}
        </span>
        {step.verdict === null ? null : (
          <Badge variant="outline" size="sm" className="shrink-0">
            {step.verdict.label}
          </Badge>
        )}
      </div>
      {step.verdict === null ? null : (
        <p className="text-2xs text-muted-foreground">{step.verdict.reason}</p>
      )}
      {step.outputExcerpt === null || step.outputExcerpt === "" ? null : (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border bg-muted/40 p-2 font-mono text-3xs text-foreground">
          {step.outputExcerpt}
        </pre>
      )}
      {step.error === null ? null : (
        <p className="text-2xs text-destructive-foreground">{step.error}</p>
      )}
    </li>
  );
}

export function RoutineExecutionView({
  environmentId,
  executionId,
}: {
  readonly environmentId: EnvironmentId;
  readonly executionId: RoutineExecutionId;
}) {
  const executionQuery = useEnvironmentQuery(
    serverEnvironment.routineExecution({ environmentId, input: { executionId } }),
  );

  if (executionQuery.error !== null) {
    return <p className="text-2xs text-destructive-foreground">{executionQuery.error}</p>;
  }
  if (executionQuery.data === null) {
    return <p className="text-2xs text-muted-foreground">Loading run…</p>;
  }

  const { execution, steps } = executionQuery.data;
  const stepStatus = new Map<string, RoutineStepRunStatus>();
  for (const step of steps) stepStatus.set(step.stepId, step.status);

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-background p-3">
      <RoutineGraph definition={execution.definition} stepStatus={stepStatus} />
      {execution.error === null ? null : (
        <p className="rounded-md border border-destructive/24 bg-destructive/4 p-2 text-2xs text-destructive-foreground dark:bg-destructive/8">
          {execution.error}
        </p>
      )}
      {steps.length === 0 ? (
        <p className="text-2xs text-muted-foreground">No steps have run yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {steps.map((step) => (
            <RoutineStepRow key={`${step.stepId}:${step.attempt}`} step={step} />
          ))}
        </ul>
      )}
    </div>
  );
}
