import { assert, it } from "@effect/vitest";
import { type RoutineActionStep, RoutineStepId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProjectId } from "@t3tools/contracts";

import { RoutineGitProvisioner } from "../adapters/git.ts";
import { runActionStep } from "./action.ts";

const step: RoutineActionStep = {
  id: RoutineStepId.make("open-pr"),
  kind: "action",
  action: "pr.create",
};

const context = (routineName?: string) => ({
  projectId: ProjectId.make("project-1"),
  brief: "Fix the flaky test",
  routineName,
  workspaceStrategy: {
    type: "existing_worktree" as const,
    worktreePath: "/worktrees/r",
    branch: "routine/r-1",
  },
});

it.effect("pr.create opens a draft from the execution branch and reports the URL", () => {
  const seen: Array<unknown> = [];
  const layer = Layer.mock(RoutineGitProvisioner)({
    createDraftPullRequest: (input) =>
      Effect.sync(() => void seen.push(input)).pipe(
        Effect.as({ url: "https://example.test/pr/1" }),
      ),
  });
  return Effect.gen(function* () {
    const outcome = yield* runActionStep(step, context("Nightly fix"));
    assert.strictEqual(outcome.verdict.label, "created");
    assert.strictEqual(outcome.outputExcerpt, "https://example.test/pr/1");
    assert.deepStrictEqual(seen, [
      {
        cwd: "/worktrees/r",
        branch: "routine/r-1",
        title: "Nightly fix",
        body: "Fix the flaky test",
      },
    ]);
  }).pipe(Effect.provide(layer));
});
