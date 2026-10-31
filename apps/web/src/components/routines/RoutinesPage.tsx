import type { RoutineSummary } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";

import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { RoutineGraph } from "./RoutineGraph";

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

function RoutineCard({ summary }: { readonly summary: RoutineSummary }) {
  const valid = summary.issues.length === 0;
  const name = summary.definition?.name ?? summary.id;
  return (
    <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="truncate text-sm font-semibold text-foreground">{name}</h2>
          <span className="truncate font-mono text-xs text-muted-foreground">{summary.path}</span>
        </div>
        <Badge variant={valid ? "success" : "destructive"} size="sm" className="shrink-0">
          {valid ? "Valid" : "Invalid"}
        </Badge>
      </div>
      {valid ? null : <RoutineIssueList issues={summary.issues} />}
      {summary.definition === null ? null : <RoutineGraph definition={summary.definition} />}
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

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b px-5">
          <h1 className="text-base font-semibold">Routines</h1>
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
                  <RoutineCard key={summary.id} summary={summary} />
                ))}
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
