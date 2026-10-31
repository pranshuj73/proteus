import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import { useState, type ComponentProps } from "react";

import type {
  EnvironmentId,
  RoutineExecutionId,
  RoutineExecutionStatus,
  RoutineExecutionStep,
  RoutineStepRunStatus,
} from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
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

const EXECUTION_BADGE: Record<
  RoutineExecutionStatus,
  { readonly variant: BadgeVariant; readonly label: string }
> = {
  running: { variant: "info", label: "Running" },
  awaiting_review: { variant: "warning", label: "Awaiting review" },
  completed: { variant: "success", label: "Completed" },
  failed: { variant: "error", label: "Failed" },
  cancelled: { variant: "secondary", label: "Cancelled" },
};

function RoutineStepRow({
  step,
  environmentId,
}: {
  readonly step: RoutineExecutionStep;
  readonly environmentId: EnvironmentId;
}) {
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
      {step.threadId === null ? null : (
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId, threadId: step.threadId }}
          className="text-2xs text-foreground underline"
        >
          Open agent thread
        </Link>
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
  const [cancelling, setCancelling] = useState(false);
  const cancel = useAtomCommand(serverEnvironment.cancelRoutine, { label: "routine cancel" });
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

  const cancelRun = async () => {
    if (cancelling) return;
    setCancelling(true);
    const result = await cancel({ environmentId, input: { executionId } });
    setCancelling(false);
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not cancel routine",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-background p-3">
      <div className="flex items-center gap-2">
        <Badge variant={EXECUTION_BADGE[execution.status].variant} size="sm">
          {EXECUTION_BADGE[execution.status].label}
        </Badge>
        <span className="min-w-0 flex-1" />
        {execution.status === "running" ? (
          <Button
            size="compact"
            variant="outline"
            disabled={cancelling}
            onClick={() => void cancelRun()}
          >
            Cancel
          </Button>
        ) : null}
      </div>
      {execution.worktreePath === null && execution.branch === null ? null : (
        <div className="flex flex-col gap-0.5 text-2xs text-muted-foreground">
          {execution.worktreePath === null ? null : (
            <span className="break-all font-mono">Worktree: {execution.worktreePath}</span>
          )}
          {execution.branch === null ? null : (
            <span className="break-all font-mono">Branch: {execution.branch}</span>
          )}
        </div>
      )}
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
            <RoutineStepRow
              key={`${step.stepId}:${step.attempt}`}
              step={step}
              environmentId={environmentId}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
