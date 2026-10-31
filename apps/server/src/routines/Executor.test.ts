import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type Project,
  ProjectId,
  ProviderInstanceId,
  type RoutineExecutionId,
  type RoutineId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { RoutineGitProvisioner } from "./adapters/git.ts";
import { RoutineProcessRunner } from "./adapters/process.ts";
import { RoutineThreadRunner } from "./adapters/threads.ts";
import * as ExecutionRepository from "./ExecutionRepository.ts";
import { Executor, layer as executorLayer } from "./Executor.ts";

const projectId = ProjectId.make("routine-project");
// Branded ids are plain strings at runtime; the routine file basename is the id.
const routineId = "demo" as RoutineId;

interface Fakes {
  readonly routine: unknown;
  readonly exitCode?: number;
  readonly verdictText?: string;
  readonly seen?: Array<string>;
  readonly gate?: Deferred.Deferred<void>;
}

const withExecutor = <A, E>(
  fakes: Fakes,
  body: (executor: Executor["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-routine-exec-" });
    const directory = path.join(root, ".proteus", "routines");
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(directory, `${routineId}.json`),
      JSON.stringify(fakes.routine),
    );

    const layer = executorLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ExecutionRepository.layer,
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeedSome({ workspaceRoot: root } as Project),
          }),
          Layer.mock(RoutineGitProvisioner)({
            provisionWorktree: ({ branch }) =>
              Effect.succeed({ worktreePath: "/worktrees/routine", branch }),
          }),
          Layer.mock(RoutineProcessRunner)({
            run: ({ cwd }) =>
              Effect.sync(() => void fakes.seen?.push(cwd)).pipe(
                Effect.as({
                  code: fakes.exitCode ?? 0,
                  output: "command output",
                  timedOut: false,
                }),
              ),
          }),
          Layer.mock(RoutineThreadRunner)({
            runAgentStep: ({ prompt, modelSelection, workspaceStrategy }) =>
              (fakes.gate === undefined ? Effect.void : Deferred.await(fakes.gate)).pipe(
                Effect.andThen(
                  Effect.sync(
                    () =>
                      void fakes.seen?.push(
                        prompt,
                        modelSelection?.model ?? "",
                        workspaceStrategy.worktreePath,
                      ),
                  ),
                ),
                Effect.as({
                  threadId: ThreadId.make("routine-thread"),
                  verdictText: fakes.verdictText ?? "",
                }),
              ),
            resolveDefaultModel: () =>
              Effect.succeed({
                instanceId: ProviderInstanceId.make("codex"),
                model: "default-model",
              }),
          }),
          NodeCrypto.layer,
        ),
      ),
    );
    return yield* Executor.pipe(Effect.flatMap(body), Effect.provide(layer));
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(SqlitePersistence.layerMemory, NodeServices.layer)),
  );

const awaitSettled = (executor: Executor["Service"], executionId: RoutineExecutionId) =>
  executor.subscribeExecution(executionId).pipe(
    Stream.filter((snapshot) => snapshot.execution.status !== "running"),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.effect("a linear command routine finishes awaiting review with pass verdicts", () =>
  withExecutor(
    {
      seen: commandSeen,
      routine: {
        version: 1,
        name: "demo",
        steps: [
          { id: "build", kind: "command", argv: ["make"], next: ["test"] },
          { id: "test", kind: "command", argv: ["make", "test"] },
        ],
      },
    },
    (executor) =>
      Effect.gen(function* () {
        const { execution } = yield* executor.start({ projectId, routineId, brief: "ship it" });
        assert.equal(execution.status, "running");
        assert.match(execution.branch ?? "", /^routine\/demo-[0-9a-f]{8}$/);

        const settled = yield* awaitSettled(executor, execution.id);
        assert.equal(settled.execution.status, "awaiting_review");
        assert.deepEqual(commandSeen, ["/worktrees/routine", "/worktrees/routine"]);
        assert.deepEqual(
          settled.steps.map((step) => [step.stepId, step.status, step.verdict?.label]),
          [
            ["build", "done", "pass"],
            ["test", "done", "pass"],
          ],
        );

        const listed = yield* executor.subscribeExecutions(projectId).pipe(Stream.runHead);
        assert.deepEqual(
          Option.getOrThrow(listed).executions.map((entry) => entry.id),
          [execution.id],
        );
      }),
  ),
);

it.effect("a failing command without onError fails the execution", () =>
  withExecutor(
    {
      exitCode: 2,
      routine: {
        version: 1,
        name: "demo",
        steps: [
          { id: "build", kind: "command", argv: ["make"], next: ["test"] },
          { id: "test", kind: "command", argv: ["make", "test"] },
        ],
      },
    },
    (executor) =>
      Effect.gen(function* () {
        const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
        const settled = yield* awaitSettled(executor, execution.id);
        assert.equal(settled.execution.status, "failed");
        assert.include(settled.execution.error ?? "", "exit 2");
        assert.deepEqual(
          settled.steps.map((step) => [step.stepId, step.status, step.verdict?.label]),
          [["build", "failed", "fail"]],
        );
      }),
  ),
);

const agentSeen: Array<string> = [];
const commandSeen: Array<string> = [];

it.effect("an agent step records the parsed VERDICT line", () =>
  withExecutor(
    {
      seen: agentSeen,
      verdictText: "Reviewed the diff.\nVERDICT: changes - missing tests",
      routine: {
        version: 1,
        name: "demo",
        steps: [
          {
            id: "review",
            kind: "agent",
            purpose: "Review the change",
            verdict: { labels: ["approved", "changes"] },
          },
        ],
      },
    },
    (executor) =>
      Effect.gen(function* () {
        const { execution } = yield* executor.start({ projectId, routineId, brief: "fix login" });
        assert.equal(execution.worktreePath, "/worktrees/routine");
        const settled = yield* awaitSettled(executor, execution.id);
        assert.equal(settled.execution.status, "awaiting_review");
        assert.include(agentSeen[0] ?? "", "fix login");
        assert.deepEqual(agentSeen.slice(1), ["default-model", "/worktrees/routine"]);
        const [step] = settled.steps;
        assert.deepEqual(step?.verdict, { label: "changes", reason: "missing tests" });
        assert.equal(step?.threadId, ThreadId.make("routine-thread"));
      }),
  ),
);

it.effect("an agent step with no valid verdict fails the step and execution", () =>
  withExecutor(
    {
      verdictText: "All good, no verdict line.",
      routine: {
        version: 1,
        name: "demo",
        steps: [
          {
            id: "review",
            kind: "agent",
            purpose: "Review the change",
            verdict: { labels: ["approved", "changes"] },
          },
        ],
      },
    },
    (executor) =>
      Effect.gen(function* () {
        const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
        const settled = yield* awaitSettled(executor, execution.id);
        assert.equal(settled.execution.status, "failed");
        assert.include(settled.steps[0]?.error ?? "", "approved, changes");
      }),
  ),
);

it.effect("cancelling a running execution ends it cancelled", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    return yield* withExecutor(
      {
        gate,
        routine: {
          version: 1,
          name: "demo",
          steps: [{ id: "review", kind: "agent", purpose: "Review", verdict: { labels: ["ok"] } }],
        },
      },
      (executor) =>
        Effect.gen(function* () {
          const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
          const cancelled = yield* executor.cancel(execution.id);
          assert.equal(cancelled.execution.status, "cancelled");
          const settled = yield* awaitSettled(executor, execution.id);
          assert.equal(settled.execution.status, "cancelled");
          assert.notEqual(settled.execution.finishedAt, null);
          const again = yield* executor.cancel(execution.id).pipe(Effect.flip);
          assert.equal(again._tag, "RoutineError");
        }),
    );
  }),
);

it.effect("starting an invalid routine fails with RoutineError", () =>
  withExecutor(
    {
      routine: {
        version: 1,
        name: "demo",
        steps: [{ id: "build", kind: "command", argv: ["make"], next: ["missing"] }],
      },
    },
    (executor) =>
      Effect.gen(function* () {
        const error = yield* executor.start({ projectId, routineId, brief: "" }).pipe(Effect.flip);
        assert.equal(error._tag, "RoutineError");
        assert.equal(error.routineId, routineId);
      }),
  ),
);
