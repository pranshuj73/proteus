import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { ROUTINE_AUTHOR_INSTRUCTIONS } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { PlusIcon } from "lucide-react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { Button } from "../ui/button";

const NEW_ROUTINE_PROMPT = `${ROUTINE_AUTHOR_INSTRUCTIONS}

---
Describe the use case you want this routine to automate, then I will draft, validate, and save it:
`;

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
          prompt: NEW_ROUTINE_PROMPT,
        });
      }}
    >
      <PlusIcon className="size-3.5" />
      New routine
    </Button>
  );
}
