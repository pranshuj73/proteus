import type { EnvironmentId, ProjectId, RoutineExecutionId, RoutineId } from "@t3tools/contracts";
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
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function RoutineRunDialog({
  environmentId,
  projectId,
  routineId,
  routineName,
  installsSkills,
  disabled,
  onStarted,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly routineId: RoutineId;
  readonly routineName: string;
  /** The routine references remote skills that preflight may install. */
  readonly installsSkills: boolean;
  readonly disabled: boolean;
  readonly onStarted: (executionId: RoutineExecutionId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [installGlobally, setInstallGlobally] = useState(false);
  const start = useAtomCommand(serverEnvironment.startRoutine, { label: "routine start" });

  const run = async () => {
    if (busy) return;
    setBusy(true);
    const result = await start({
      environmentId,
      input: {
        projectId,
        routineId,
        brief: brief.trim(),
        skillScope: installGlobally ? "global" : "project",
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setOpen(false);
      setBrief("");
      onStarted(result.value.execution.id);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not start routine",
          description: String(squashAtomCommandFailure(result)),
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
            {installsSkills ? (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="routine-run-global-skills"
                  checked={installGlobally}
                  disabled={busy}
                  onCheckedChange={(checked) => setInstallGlobally(checked === true)}
                />
                <Label htmlFor="routine-run-global-skills">
                  Install missing skills globally instead of in this project
                </Label>
              </div>
            ) : null}
            <p className="text-2xs text-muted-foreground">
              Runs on the project's default model. Model overrides land in a later ticket.
            </p>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            Cancel
          </DialogClose>
          <Button type="button" disabled={busy} onClick={() => void run()}>
            {busy ? "Starting…" : "Run"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
