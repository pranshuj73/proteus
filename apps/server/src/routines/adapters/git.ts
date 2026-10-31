import { RoutineError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitWorkflow from "../../git/GitWorkflowService.ts";

interface RoutineWorktreeInput {
  readonly workspaceRoot: string;
  readonly baseRef: string;
  readonly branch: string;
}

interface RoutineWorktree {
  readonly worktreePath: string;
  readonly branch: string;
}

/** Confines worktree provisioning behind one routine-facing seam over the shared Git workflow. */
export class RoutineGitProvisioner extends Context.Service<
  RoutineGitProvisioner,
  {
    readonly provisionWorktree: (
      input: RoutineWorktreeInput,
    ) => Effect.Effect<RoutineWorktree, RoutineError>;
  }
>()("t3/routines/adapters/git/RoutineGitProvisioner") {}

const make = Effect.gen(function* () {
  const git = yield* GitWorkflow.GitWorkflowService;

  const provisionWorktree: RoutineGitProvisioner["Service"]["provisionWorktree"] = Effect.fn(
    "RoutineGitProvisioner.provisionWorktree",
  )(function* (input) {
    const result = yield* git
      .createWorktree({
        cwd: input.workspaceRoot,
        refName: input.baseRef,
        newRefName: input.branch,
        baseRefName: input.baseRef,
        path: null,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new RoutineError({ message: "Failed to provision the routine worktree.", cause }),
        ),
      );
    return { worktreePath: result.worktree.path, branch: result.worktree.refName };
  });

  return RoutineGitProvisioner.of({ provisionWorktree });
});

export const layer = Layer.effect(RoutineGitProvisioner, make);
