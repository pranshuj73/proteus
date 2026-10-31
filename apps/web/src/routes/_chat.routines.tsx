import type { EnvironmentId, ProjectId, RoutineExecutionId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { RoutinesPage } from "../components/routines/RoutinesPage";

export interface RoutinesSearch {
  readonly projectId?: ProjectId;
  readonly environmentId?: EnvironmentId;
  readonly executionId?: RoutineExecutionId;
}

export const Route = createFileRoute("/_chat/routines")({
  validateSearch: (raw: Record<string, unknown>): RoutinesSearch => ({
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(typeof raw.executionId === "string" && raw.executionId
      ? { executionId: raw.executionId as RoutineExecutionId }
      : {}),
  }),
  component: RoutinesPage,
});
