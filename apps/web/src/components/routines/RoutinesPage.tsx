import type {
  EnvironmentId,
  ProjectId,
  RoutineDefinition,
  RoutineExecutionId,
  RoutineSummary,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";

import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { RoutineGraph } from "./RoutineGraph";
import { diffRoutineDefinitions, isEmptyRoutineDiff } from "./routineGraphDiff";
import { NewRoutineButton } from "./NewRoutineButton";
import { RoutineExecutionsList } from "./RoutineExecutionsList";
import { RoutineRunDialog } from "./RoutineRunDialog";

function RoutineIssueList({ issues }: { readonly issues: RoutineSummary["issues"] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {issues.map((issue) => (
        <li
          key={`${issue.code}:${issue.path}:${issue.message}`}
          className="flex flex-col gap-0.5 rounded-md border border-destructive/24 bg-destructive/4 p-2 text-xs dark:bg-destructive/8"
        >
          <span className="flex items-center gap-2">
            <Badge variant="error" size="sm">
              {issue.code}
            </Badge>
            <span className="truncate font-mono text-3xs text-muted-foreground">{issue.path}</span>
          </span>
          <span className="text-foreground">{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}

function RoutineDiffSummary({
  approved,
  current,
}: {
  readonly approved: RoutineDefinition;
  readonly current: RoutineDefinition;
}) {
  const diff = diffRoutineDefinitions(approved, current);
  if (isEmptyRoutineDiff(diff)) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border p-2 text-xs">
      <span className="font-medium text-foreground">Changes since the approved version</span>
      <ul className="flex flex-col gap-1">
        {diff.added.map((id) => (
          <li key={`added:${id}`} className="flex items-center gap-2">
            <Badge variant="success" size="sm">
              added
            </Badge>
            <span className="font-mono">{id}</span>
          </li>
        ))}
        {diff.removed.map((id) => (
          <li key={`removed:${id}`} className="flex items-center gap-2">
            <Badge variant="error" size="sm">
              removed
            </Badge>
            <span className="font-mono">{id}</span>
          </li>
        ))}
        {diff.changed.map((entry) => (
          <li key={`changed:${entry.id}`} className="flex items-center gap-2">
            <Badge variant="warning" size="sm">
              changed
            </Badge>
            <span className="font-mono">{entry.id}</span>
            <span className="text-muted-foreground">{entry.fields.join(", ")}</span>
          </li>
        ))}
        {diff.routineFields.map((field) => (
          <li key={`routine:${field}`} className="flex items-center gap-2">
            <Badge variant="warning" size="sm">
              changed
            </Badge>
            <span className="text-muted-foreground">routine {field}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RoutineApproveButton({
  environmentId,
  projectId,
  routineId,
  onApproved,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly routineId: RoutineSummary["id"];
  readonly onApproved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const approve = useAtomCommand(serverEnvironment.approveRoutine, { label: "routine approve" });
  const run = async () => {
    if (busy) return;
    setBusy(true);
    const result = await approve({ environmentId, input: { projectId, routineId } });
    setBusy(false);
    if (result._tag === "Success") {
      onApproved();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not approve routine",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  return (
    <Button size="compact" variant="outline" disabled={busy} onClick={() => void run()}>
      {busy ? "Approving…" : "Approve"}
    </Button>
  );
}

function RoutineCard({
  summary,
  environmentId,
  projectId,
  selectedExecutionId,
  onSelectExecution,
  onApproved,
}: {
  readonly summary: RoutineSummary;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly selectedExecutionId: RoutineExecutionId | null;
  readonly onSelectExecution: (executionId: RoutineExecutionId) => void;
  readonly onApproved: () => void;
}) {
  const valid = summary.issues.length === 0;
  const name = summary.definition?.name ?? summary.id;
  return (
    <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="truncate text-sm font-semibold text-foreground">{name}</h2>
          <span className="truncate font-mono text-xs text-muted-foreground">{summary.path}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={valid ? "success" : "destructive"} size="sm">
            {valid ? "Valid" : "Invalid"}
          </Badge>
          {valid && !summary.approved ? (
            <RoutineApproveButton
              environmentId={environmentId}
              projectId={projectId}
              routineId={summary.id}
              onApproved={onApproved}
            />
          ) : null}
          <RoutineRunDialog
            environmentId={environmentId}
            projectId={projectId}
            routineId={summary.id}
            routineName={name}
            disabled={!valid || !summary.approved}
            onStarted={onSelectExecution}
          />
        </div>
      </div>
      {valid ? null : <RoutineIssueList issues={summary.issues} />}
      {valid &&
      !summary.approved &&
      summary.definition !== null &&
      summary.approvedDefinition != null ? (
        <RoutineDiffSummary approved={summary.approvedDefinition} current={summary.definition} />
      ) : null}
      {summary.definition === null ? null : <RoutineGraph definition={summary.definition} />}
      <RoutineExecutionsList
        environmentId={environmentId}
        projectId={projectId}
        routineId={summary.id}
        selectedExecutionId={selectedExecutionId}
        onSelect={onSelectExecution}
      />
    </section>
  );
}

export function RoutinesPage() {
  const projects = useProjects();
  const search = useSearch({ from: "/_chat/routines" });
  const navigate = useNavigate();

  const selected =
    projects.find((project) => project.id === search.projectId) ?? projects[0] ?? null;
  const routinesQuery = useEnvironmentQuery(
    selected === null
      ? null
      : serverEnvironment.routinesList({
          environmentId: selected.environmentId,
          input: { projectId: selected.id },
        }),
  );
  const routines = routinesQuery.data?.routines ?? [];
  const selectExecution = (executionId: RoutineExecutionId) => {
    if (selected === null) return;
    void navigate({
      to: "/routines",
      search: { projectId: selected.id, environmentId: selected.environmentId, executionId },
    });
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b px-5">
          <h1 className="text-base font-semibold">Routines</h1>
          <div className="flex items-center gap-2">
            {selected === null ? null : (
              <NewRoutineButton environmentId={selected.environmentId} projectId={selected.id} />
            )}
            {projects.length === 0 ? null : (
              <Select
                value={selected?.id ?? ""}
                onValueChange={(projectId) => {
                  const next = projects.find((project) => project.id === projectId);
                  if (next === undefined) return;
                  void navigate({
                    to: "/routines",
                    search: { projectId: next.id, environmentId: next.environmentId },
                  });
                }}
              >
                <SelectTrigger size="sm" aria-label="Project">
                  <SelectValue placeholder="Select a project">{selected?.title}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={`${project.environmentId}:${project.id}`} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          </div>
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Connect a project to view its routines.
              </p>
            ) : selected === null ? (
              <p className="text-sm text-muted-foreground">
                Select a project to view its routines.
              </p>
            ) : routinesQuery.error !== null ? (
              <p className="text-sm text-destructive-foreground">{routinesQuery.error}</p>
            ) : routinesQuery.data === null && routinesQuery.isPending ? (
              <p className="text-sm text-muted-foreground">Loading routines…</p>
            ) : routines.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No routines found. Add <code className="font-mono">.proteus/routines/*.json</code>{" "}
                files to {selected.title}.
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                {routines.map((summary) => (
                  <RoutineCard
                    key={summary.id}
                    summary={summary}
                    environmentId={selected.environmentId}
                    projectId={selected.id}
                    selectedExecutionId={search.executionId ?? null}
                    onSelectExecution={selectExecution}
                    onApproved={routinesQuery.refresh}
                  />
                ))}
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
