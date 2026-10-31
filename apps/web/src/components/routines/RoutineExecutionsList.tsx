import type { ComponentProps } from "react";

import type {
  EnvironmentId,
  ProjectId,
  RoutineExecutionId,
  RoutineExecutionStatus,
  RoutineId,
} from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { RelativeTime } from "../RelativeTime";
import { Badge } from "../ui/badge";
import { RoutineExecutionView } from "./RoutineExecutionView";

type BadgeVariant = ComponentProps<typeof Badge>["variant"];

const STATUS_BADGE: Record<
  RoutineExecutionStatus,
  { readonly variant: BadgeVariant; readonly label: string }
> = {
  running: { variant: "info", label: "Running" },
  awaiting_review: { variant: "warning", label: "Awaiting review" },
  completed: { variant: "success", label: "Completed" },
  failed: { variant: "error", label: "Failed" },
};

export function RoutineExecutionsList({
  environmentId,
  projectId,
  routineId,
  selectedExecutionId,
  onSelect,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly routineId: RoutineId;
  readonly selectedExecutionId: RoutineExecutionId | null;
  readonly onSelect: (executionId: RoutineExecutionId) => void;
}) {
  const executionsQuery = useEnvironmentQuery(
    serverEnvironment.routineExecutions({ environmentId, input: { projectId } }),
  );
  const executions = (executionsQuery.data?.executions ?? []).filter(
    (execution) => execution.routineId === routineId,
  );
  const selectedBelongsHere = executions.some((execution) => execution.id === selectedExecutionId);

  if (executionsQuery.error !== null) {
    return <p className="text-2xs text-destructive-foreground">{executionsQuery.error}</p>;
  }
  if (executions.length === 0) {
    return <p className="text-2xs text-muted-foreground">No runs yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1.5">
        {executions.map((execution) => {
          const badge = STATUS_BADGE[execution.status];
          const selected = execution.id === selectedExecutionId;
          return (
            <li key={execution.id}>
              <button
                type="button"
                onClick={() => onSelect(execution.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left",
                  selected ? "border-ring bg-accent/50" : "bg-card hover:bg-accent/30",
                )}
              >
                <Badge variant={badge.variant} size="sm" className="shrink-0">
                  {badge.label}
                </Badge>
                <span className="min-w-0 flex-1 truncate font-mono text-3xs text-muted-foreground">
                  {execution.branch ?? "No branch"}
                </span>
                <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">
                  <RelativeTime timestamp={execution.createdAt} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {selectedExecutionId !== null && selectedBelongsHere ? (
        <RoutineExecutionView environmentId={environmentId} executionId={selectedExecutionId} />
      ) : null}
    </div>
  );
}
