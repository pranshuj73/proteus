import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { RoutinesPage } from "../components/routines/RoutinesPage";

export interface RoutinesSearch {
  readonly projectId?: ProjectId;
  readonly environmentId?: EnvironmentId;
}

export const Route = createFileRoute("/_chat/routines")({
  validateSearch: (raw: Record<string, unknown>): RoutinesSearch => ({
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
  }),
  component: RoutinesPage,
});
