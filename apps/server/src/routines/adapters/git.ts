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
    /** Pushes the worktree's current branch; `pushed` is false when it was already up to date. */
    readonly pushBranch: (input: {
      readonly cwd: string;
      readonly actionId: string;
    }) => Effect.Effect<{ readonly pushed: boolean; readonly branch: string | null }, RoutineError>;
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

  const pushBranch: RoutineGitProvisioner["Service"]["pushBranch"] = Effect.fn(
    "RoutineGitProvisioner.pushBranch",
  )(function* (input) {
    const result = yield* git
      .runStackedAction({ actionId: input.actionId, cwd: input.cwd, action: "push" })
      .pipe(
        Effect.mapError(
          (cause) => new RoutineError({ message: "Failed to push the routine branch.", cause }),
        ),
      );
    return { pushed: result.push.status === "pushed", branch: result.push.branch ?? null };
  });

  return RoutineGitProvisioner.of({ provisionWorktree, pushBranch });
});

export const layer = Layer.effect(RoutineGitProvisioner, make);
