import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { RoutineThreadRunner, layer } from "./threads.ts";

const threadId = ThreadId.make("step-thread");

const stepInput = {
  projectId: ProjectId.make("project"),
  workspaceStrategy: {
    type: "existing_worktree",
    worktreePath: "/worktrees/routine",
    branch: "routine/demo",
  },
  prompt: "Go",
  modelSelection: { instanceId: "codex", model: "default-model" },
  title: "Step",
  continueThreadId: threadId,
  onQuestion: () => Effect.die("An approval is not a question."),
} as unknown as Parameters<RoutineThreadRunner["Service"]["runAgentStep"]>[0];

const runnerLayer = (
  threads: Partial<ThreadManagementService.ThreadManagementService["Service"]>,
) =>
  layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          sendToThread: () => Effect.succeed({ run: { id: "run", userMessageId: null } } as never),
          ...threads,
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ServerSettings.ServerSettingsService)({}),
        Layer.succeed(ServerConfig, {} as never),
        Layer.mock(DocumentText.DocumentText)({}),
        NodeCrypto.layer,
        NodeServices.layer,
      ),
    ),
  );

it.effect("a pending approval is left for the step thread and the step keeps waiting", () =>
  Effect.gen(function* () {
    const rescanned = yield* Deferred.make<void>();
    const dispatched: Array<unknown> = [];
    let reads = 0;
    const runner = yield* RoutineThreadRunner.pipe(
      Effect.provide(
        runnerLayer({
          streamDomainEvents: Stream.make({ threadId } as never),
          dispatch: (command) =>
            Effect.sync(() => void dispatched.push(command)).pipe(Effect.as({} as never)),
          getThreadProjection: () =>
            Effect.gen(function* () {
              reads += 1;
              // A second scan begins only after the first handled the pending approval.
              if (reads === 2) yield* Deferred.succeed(rescanned, undefined);
              return {
                runtimeRequests: [{ id: "approval", kind: "command", status: "pending" }],
                turnItems: [],
                messages: [{ role: "assistant", text: "VERDICT: ok - done" }],
                providerThreads: [],
              } as never;
            }),
          waitForThread: () =>
            Deferred.await(rescanned).pipe(
              Effect.as({ threadId, run: null, timedOut: false } as never),
            ),
        }),
      ),
    );
    const result = yield* runner.runAgentStep(stepInput);
    assert.equal(result.verdictText, "VERDICT: ok - done");
    assert.deepEqual(dispatched, []);
  }),
);

it.effect("an unanswered request fails the step when its wait times out", () =>
  Effect.gen(function* () {
    const runner = yield* RoutineThreadRunner.pipe(
      Effect.provide(
        runnerLayer({
          waitForThread: () => Effect.succeed({ threadId, run: null, timedOut: true } as never),
        }),
      ),
    );
    const error = yield* runner
      .runAgentStep({ ...stepInput, onQuestion: undefined })
      .pipe(Effect.flip);
    assert.include(error.message, "did not finish before the step timeout");
  }),
);

it.effect("a blocked thread reports it, and the step timeout waits for the person", () =>
  Effect.gen(function* () {
    const reported = yield* Deferred.make<void>();
    const blocked: Array<string | null> = [];
    let pending = true;
    let waits = 0;
    const runner = yield* RoutineThreadRunner.pipe(
      Effect.provide(
        runnerLayer({
          streamDomainEvents: Stream.never,
          getThreadProjection: () =>
            Effect.sync(
              () =>
                ({
                  runtimeRequests: pending
                    ? [{ id: "approval", kind: "command", status: "pending" }]
                    : [],
                  turnItems: [],
                  messages: [{ role: "assistant", text: "VERDICT: ok - done" }],
                  providerThreads: [],
                }) as never,
            ),
          waitForThread: () =>
            Effect.gen(function* () {
              yield* Deferred.await(reported);
              waits += 1;
              if (waits === 2) pending = false;
              return { threadId, run: null, timedOut: waits === 1 } as never;
            }),
        }),
      ),
    );
    const result = yield* runner.runAgentStep({
      ...stepInput,
      onBlocked: (reason) =>
        Effect.sync(() => void blocked.push(reason)).pipe(
          Effect.andThen(Deferred.succeed(reported, undefined)),
          Effect.asVoid,
        ),
    });
    assert.equal(result.verdictText, "VERDICT: ok - done");
    assert.equal(waits, 2);
    assert.deepEqual(blocked, ["Waiting in the step thread: an approval is needed.", null]);
  }),
);
