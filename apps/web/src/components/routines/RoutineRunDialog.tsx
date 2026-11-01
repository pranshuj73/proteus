import type {
  EnvironmentId,
  ProjectId,
  RoutineExecutionId,
  RoutineId,
  RoutineSkillScope,
  RoutineSkillScopeRequired,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { PlayIcon } from "lucide-react";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";

const isSkillScopeRequired = (failure: unknown): failure is RoutineSkillScopeRequired =>
  typeof failure === "object" &&
  failure !== null &&
  "_tag" in failure &&
  failure._tag === "RoutineSkillScopeRequired";

export function RoutineRunDialog({
  environmentId,
  projectId,
  routineId,
  routineName,
  disabled,
  onStarted,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly routineId: RoutineId;
  readonly routineName: string;
  readonly disabled: boolean;
  readonly onStarted: (executionId: RoutineExecutionId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [scopeRequest, setScopeRequest] = useState<RoutineSkillScopeRequired | null>(null);
  const start = useAtomCommand(serverEnvironment.startRoutine, { label: "routine start" });

  const run = async (skillScope?: RoutineSkillScope) => {
    if (busy) return;
    setBusy(true);
    const result = await start({
      environmentId,
      input: {
        projectId,
        routineId,
        brief: brief.trim(),
        ...(skillScope === undefined ? {} : { skillScope }),
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setOpen(false);
      setBrief("");
      setScopeRequest(null);
      onStarted(result.value.execution.id);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      if (isSkillScopeRequired(failure)) {
        setScopeRequest(failure);
        return;
      }
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not start routine",
          description: String(failure),
        }),
      );
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        setOpen(next);
        if (!next) setScopeRequest(null);
      }}
    >
      <DialogTrigger
        render={
          <Button size="compact" variant="default" disabled={disabled}>
            <PlayIcon className="size-3.5" />
            Run
          </Button>
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Run {routineName}</DialogTitle>
          <DialogDescription>
            Starts the routine in a fresh worktree branch and runs its steps in order.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="routine-run-brief">Brief</Label>
              <Textarea
                id="routine-run-brief"
                value={brief}
                disabled={busy}
                placeholder="What should this run focus on? (optional)"
                onChange={(event) => setBrief(event.target.value)}
                rows={4}
              />
            </div>
            {scopeRequest === null ? null : (
              <p className="text-sm" role="status">
                Install {scopeRequest.missingSkills.join(", ")} for this project or globally?
              </p>
            )}
            <p className="text-2xs text-muted-foreground">
              Runs on the project's default model. Model overrides land in a later ticket.
            </p>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            Cancel
          </DialogClose>
          {scopeRequest === null ? (
            <Button type="button" disabled={busy} onClick={() => void run()}>
              {busy ? "Starting…" : "Run"}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy || !scopeRequest.canInstallGlobally}
                onClick={() => void run("global")}
              >
                Global
              </Button>
              <Button type="button" disabled={busy} onClick={() => void run("project")}>
                Project
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
