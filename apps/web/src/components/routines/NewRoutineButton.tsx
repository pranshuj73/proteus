import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { routineEditPrompt, routineNewPrompt } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { PlusIcon } from "lucide-react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { Button } from "../ui/button";

export function EditRoutineButton({
  environmentId,
  projectId,
  path,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly path: string;
}) {
  const handleNewThread = useNewThreadHandler();
  return (
    <Button
      size="compact"
      variant="ghost"
      onClick={() => {
        void handleNewThread(scopeProjectRef(environmentId, projectId), {
          prompt: routineEditPrompt(path),
        });
      }}
    >
      Edit
    </Button>
  );
}

export function NewRoutineButton({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const handleNewThread = useNewThreadHandler();
  return (
    <Button
      size="compact"
      variant="default"
      onClick={() => {
        void handleNewThread(scopeProjectRef(environmentId, projectId), {
          prompt: routineNewPrompt(),
        });
      }}
    >
      <PlusIcon className="size-3.5" />
      New routine
    </Button>
  );
}
