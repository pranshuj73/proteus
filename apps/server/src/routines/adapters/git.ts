import { RoutineError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";

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
    /** Opens a draft pull request for the pushed branch and returns its URL. */
    readonly createDraftPullRequest: (input: {
      readonly cwd: string;
      readonly branch: string;
      readonly title: string;
      readonly body: string;
    }) => Effect.Effect<{ readonly url: string | null }, RoutineError>;
  }
>()("t3/routines/adapters/git/RoutineGitProvisioner") {}

const make = Effect.gen(function* () {
  const git = yield* GitWorkflow.GitWorkflowService;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const fileSystem = yield* FileSystem.FileSystem;

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

  const createDraftPullRequest: RoutineGitProvisioner["Service"]["createDraftPullRequest"] =
    Effect.fn("RoutineGitProvisioner.createDraftPullRequest")(
      function* (input) {
        const provider = yield* sourceControl.resolve({ cwd: input.cwd });
        const baseRefName = (yield* provider.getDefaultBranch({ cwd: input.cwd })) ?? "main";
        const bodyFile = yield* fileSystem.makeTempFile({ prefix: "t3-routine-pr-" });
        const created = yield* Effect.gen(function* () {
          yield* fileSystem.writeFileString(bodyFile, input.body);
          yield* provider.createChangeRequest({
            cwd: input.cwd,
            baseRefName,
            headSelector: input.branch,
            title: input.title,
            bodyFile,
            draft: true,
          });
          return yield* provider.listChangeRequests({
            cwd: input.cwd,
            headSelector: input.branch,
            state: "open",
            limit: 1,
          });
        }).pipe(Effect.ensuring(fileSystem.remove(bodyFile).pipe(Effect.ignore)));
        return { url: created[0]?.url ?? null };
      },
      Effect.mapError(
        (cause) => new RoutineError({ message: "Failed to open the draft pull request.", cause }),
      ),
    );

  return RoutineGitProvisioner.of({ provisionWorktree, pushBranch, createDraftPullRequest });
});

export const layer = Layer.effect(RoutineGitProvisioner, make);
