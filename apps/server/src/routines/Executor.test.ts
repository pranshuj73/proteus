import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2UserInputQuestion,
  type Project,
  ProjectId,
  ProviderInstanceId,
  type RoutineExecutionId,
  type RoutineId,
  type RoutineError,
  RoutineStepId,
  type ServerSettings as ServerSettingsValue,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { PlatformError } from "effect/PlatformError";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { RoutineGitProvisioner } from "./adapters/git.ts";
import { RoutineProcessRunner } from "./adapters/process.ts";
import { RoutineThreadRunner } from "./adapters/threads.ts";
import * as ExecutionRepository from "./ExecutionRepository.ts";
import { RoutineSkillInstaller } from "./steps/preflight.ts";
import { skillDrift } from "./skills.ts";
import { Executor, layer as executorLayer } from "./Executor.ts";

const projectId = ProjectId.make("routine-project");
// Branded ids are plain strings at runtime; the routine file basename is the id.
const routineId = "demo" as RoutineId;

const testExecutables = (routine: unknown) =>
  (
    routine as { readonly steps: ReadonlyArray<{ readonly argv?: ReadonlyArray<string> }> }
  ).steps.flatMap((step) => step.argv?.slice(0, 1) ?? []);

let treeCounter = 0;

interface Fakes {
  readonly routine: unknown;
  readonly exitCode?: number;
  readonly verdictText?: string;
  readonly verdictQueue?: Array<string>;
  readonly cleanWorktree?: boolean;
  readonly judgeText?: string;
  readonly stuck?: boolean;
  readonly autoResume?: boolean;
  readonly continued?: Array<string>;
  /** The agent step's thread asks this once; the answers it receives land in `answers`. */
  readonly question?: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  readonly answers?: Array<unknown>;
  readonly councilText?: string;
  readonly councilTokens?: number;
  readonly seen?: Array<string>;
  readonly gate?: Deferred.Deferred<void>;
  readonly stopped?: Array<string>;
  readonly pushed?: boolean;
  /** Commands (argv joined) that exit 1. */
  readonly failing?: ReadonlyArray<string>;
  readonly mergeConflict?: boolean;
  /** Every git invocation, as `cwd: args`. */
  readonly gitCalls?: Array<string>;
  readonly launched?: Deferred.Deferred<void>;
  readonly seed?: Effect.Effect<void, RoutineError, ExecutionRepository.ExecutionRepository>;
}

const withExecutor = <A, E>(
  fakes: Fakes,
  body: (
    executor: Executor["Service"],
    raw: Executor["Service"],
    rewrite: (routine: unknown) => Effect.Effect<void, PlatformError>,
  ) => Effect.Effect<A, E>,
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

    if (fakes.seed !== undefined) {
      yield* fakes.seed.pipe(Effect.provide(ExecutionRepository.layer));
    }

    const layer = executorLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ExecutionRepository.layer,
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeedSome({ workspaceRoot: root } as Project),
          }),
          Layer.mock(RoutineGitProvisioner)({
            provisionWorktree: ({ branch }) =>
              Effect.succeed({
                worktreePath: branch.includes("--") ? `/worktrees/${branch}` : "/worktrees/routine",
                branch,
              }),
            removeWorktree: ({ worktreePath }) =>
              Effect.sync(() => void fakes.gitCalls?.push(`remove ${worktreePath}`)),
            createDraftPullRequest: ({ title }) =>
              Effect.sync(() => void fakes.seen?.push(`pr:${title}`)).pipe(
                Effect.as({ url: "https://example.test/pull/1" }),
              ),
            pushBranch: ({ cwd }) =>
              Effect.sync(() => void fakes.seen?.push(`push:${cwd}`)).pipe(
                Effect.as({ pushed: fakes.pushed ?? true, branch: "routine/pushed" }),
              ),
          }),
          Layer.mock(RoutineProcessRunner)({
            run: ({ cwd, argv }) =>
              Effect.sync(() => {
                if (argv[0] === "git") {
                  const args = argv.slice(5);
                  fakes.gitCalls?.push(`${cwd}: ${args.join(" ")}`);
                  if (args[1]?.endsWith("^{tree}")) {
                    treeCounter += 1;
                    return {
                      code: 0,
                      output: fakes.stuck === true ? "same" : String(treeCounter),
                      timedOut: false,
                    };
                  }
                  return {
                    code: args[0] === "merge" && fakes.mergeConflict === true ? 1 : 0,
                    output:
                      args[0] === "status" && fakes.cleanWorktree !== true
                        ? "M file"
                        : args[0] === "diff"
                          ? "src/a.ts\n"
                          : "",
                    timedOut: false,
                  };
                }
                fakes.seen?.push(`${argv.join(" ")} @ ${cwd}`);
                return {
                  code: fakes.failing?.includes(argv.join(" ")) ? 1 : (fakes.exitCode ?? 0),
                  output: "command output",
                  timedOut: false,
                };
              }),
          }),
          Layer.mock(RoutineThreadRunner)({
            stopThread: ({ threadId }) => Effect.sync(() => void fakes.stopped?.push(threadId)),
            resolveCouncilModel: ({ author }) =>
              Effect.succeed({ selection: author, independent: false }),
            runAgentStep: ({
              prompt,
              modelSelection,
              workspaceStrategy,
              onLaunched,
              onQuestion,
              title,
              continueThreadId,
            }) =>
              Effect.gen(function* () {
                fakes.continued?.push(continueThreadId ?? "");
                if (title.startsWith("Resolve merge") || title.startsWith("Judge merge")) {
                  return {
                    threadId: ThreadId.make(title),
                    verdictText: fakes.judgeText ?? "",
                    contextTokens: null,
                  };
                }
                if (title.startsWith("Council summary")) {
                  return {
                    threadId: ThreadId.make("summary-thread"),
                    verdictText: "- chose X",
                    contextTokens: null,
                  };
                }
                if (title.startsWith("Council:")) {
                  return {
                    threadId: ThreadId.make("council-thread"),
                    verdictText: fakes.councilText ?? "",
                    contextTokens: fakes.councilTokens ?? null,
                  };
                }
                if (fakes.question !== undefined && onQuestion !== undefined) {
                  fakes.answers?.push(
                    yield* onQuestion(ThreadId.make("routine-thread"), {
                      requestId: "request-1",
                      questions: fakes.question,
                    }),
                  );
                }
                if (onLaunched !== undefined) yield* onLaunched(ThreadId.make("routine-thread"));
                if (fakes.launched !== undefined)
                  yield* Deferred.succeed(fakes.launched, undefined);
                if (fakes.gate !== undefined) yield* Deferred.await(fakes.gate);
                fakes.seen?.push(
                  prompt,
                  modelSelection?.model ?? "",
                  workspaceStrategy.worktreePath,
                );
                return {
                  threadId: ThreadId.make("routine-thread"),
                  verdictText: fakes.verdictQueue?.shift() ?? fakes.verdictText ?? "",
                  contextTokens: null,
                };
              }),
            resolveDefaultModel: () =>
              Effect.succeed({
                instanceId: ProviderInstanceId.make("codex"),
                model: "default-model",
              }),
          }),
          Layer.mock(RoutineSkillInstaller)({}),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              continueThreadsAfterServerUpdate: fakes.autoResume === true,
            } as ServerSettingsValue),
          }),
          NodeCrypto.layer,
        ),
      ),
    );
    return yield* Executor.pipe(
      Effect.flatMap((raw) =>
        body(
          // Most cases are not about approval, so their start approves the routine first.
          {
            ...raw,
            start: (input) =>
              raw
                .approve({
                  projectId: input.projectId,
                  routineId: input.routineId,
                  allowExecutables: testExecutables(fakes.routine),
                })
                .pipe(Effect.andThen(raw.start(input))),
          },
          raw,
          (routine) =>
            fileSystem.writeFileString(
              path.join(directory, `${routineId}.json`),
              JSON.stringify(routine),
            ),
        ),
      ),
      Effect.provide(layer),
    );
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
        assert.deepEqual(commandSeen, [
          "make @ /worktrees/routine",
          "make test @ /worktrees/routine",
        ]);
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

it.effect(
  "an invalid verdict re-prompts on the same thread and earlier outputs reach inputs",
  () => {
    const seen: Array<string> = [];
    return withExecutor(
      {
        seen,
        verdictQueue: ["no verdict here", "VERDICT: approved - fine"],
        routine: {
          version: 1,
          name: "demo",
          steps: [
            { id: "build", kind: "command", argv: ["make"], next: ["review"] },
            {
              id: "review",
              kind: "agent",
              purpose: "Review the build",
              inputs: ["build"],
              verdict: { labels: ["approved", "changes"] },
            },
          ],
        },
      },
      (executor) =>
        Effect.gen(function* () {
          const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
          const settled = yield* awaitSettled(executor, execution.id);
          assert.equal(settled.execution.status, "awaiting_review");
          assert.equal(settled.steps.at(-1)?.verdict?.label, "approved");
          const prompts = seen.filter((entry) => entry.includes("VERDICT:"));
          assert.include(prompts[0] ?? "", "command output");
          assert.include(prompts[1] ?? "", "no valid verdict");
        }),
    );
  },
);

it.effect(
  "mark complete needs confirmation before discarding work, then removes the worktree",
  () => {
    const gitCalls: Array<string> = [];
    return withExecutor(
      {
        gitCalls,
        routine: {
          version: 1,
          name: "demo",
          steps: [{ id: "build", kind: "command", argv: ["make"] }],
        },
      },
      (executor) =>
        Effect.gen(function* () {
          const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
          yield* awaitSettled(executor, execution.id);
          const blocked = yield* Effect.flip(executor.complete({ executionId: execution.id }));
          assert.include(blocked.message, "uncommitted changes");
          const { execution: done } = yield* executor.complete({
            executionId: execution.id,
            discardWork: true,
          });
          assert.equal(done.status, "completed");
          assert.include(gitCalls, "remove /worktrees/routine");
        }),
    );
  },
);

const restartCalls: Array<string> = [];

it.effect(
  "pause holds after the current step and restart reruns it; removing an executable pauses",
  () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const launched = yield* Deferred.make<void>();
      return yield* withExecutor(
        {
          gate,
          launched,
          gitCalls: restartCalls,
          routine: {
            version: 1,
            name: "demo",
            steps: [
              {
                id: "review",
                kind: "agent",
                purpose: "Review",
                verdict: { labels: ["ok"] },
                next: ["build"],
              },
              { id: "build", kind: "command", argv: ["make"] },
            ],
          },
        },
        (executor, raw) =>
          Effect.gen(function* () {
            const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
            const executionId = execution.id;
            yield* Deferred.await(launched);
            yield* raw.control({ executionId, action: "pause" });
            yield* Deferred.succeed(gate, undefined);
            const paused = yield* awaitSettled(executor, executionId);
            assert.equal(paused.execution.status, "paused");
            assert.deepEqual(
              paused.steps.map((step) => step.stepId),
              ["review"],
            );

            yield* raw.control({
              executionId,
              action: "restart",
              stepId: RoutineStepId.make("review"),
            });
            const finished = yield* executor.subscribeExecution(executionId).pipe(
              Stream.filter((snapshot) => snapshot.execution.status === "awaiting_review"),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );
            assert.deepEqual(
              finished.steps.map((step) => `${step.stepId}:${step.attempt}`),
              ["build:1", "review:1", "review:2"],
            );
            assert.isTrue(restartCalls.some((call) => call.includes("reset --hard")));

            yield* raw.removeExecutable({ projectId, executable: "make" });
            const second = yield* raw
              .approve({ projectId, routineId, allowExecutables: ["make"] })
              .pipe(Effect.andThen(raw.start({ projectId, routineId, brief: "" })));
            yield* raw.removeExecutable({ projectId, executable: "make" });
            const held = yield* awaitSettled(executor, second.execution.id);
            assert.include(held.execution.error ?? "", "make");
          }),
      );
    }),
);

it.effect("retry, skip and pause steer a parked execution", () => {
  const failing = ["make"];
  return withExecutor(
    {
      failing,
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
        const executionId = execution.id;
        yield* awaitSettled(executor, executionId);

        failing.length = 0;
        failing.push("make test");
        yield* executor.control({ executionId, action: "retry" });
        const second = yield* executor.subscribeExecution(executionId).pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.execution.status === "failed" &&
              snapshot.steps.some((step) => step.stepId === "test"),
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        assert.equal(second.steps.findLast((step) => step.status === "failed")?.stepId, "test");

        yield* executor.control({
          executionId,
          action: "skip",
          stepId: RoutineStepId.make("test"),
          label: "pass",
          reason: "known flake",
        });
        const finished = yield* executor.subscribeExecution(executionId).pipe(
          Stream.filter((snapshot) => snapshot.execution.status === "awaiting_review"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        assert.include(finished.steps.at(-1)?.verdict?.reason ?? "", "known flake");
      }),
  );
});

it.effect("a loop repeating its verdict with no file changes stops early", () =>
  withExecutor(
    {
      stuck: true,
      verdictText: "VERDICT: retry - still broken",
      routine: {
        version: 1,
        name: "demo",
        steps: [
          {
            id: "fix",
            kind: "agent",
            purpose: "Fix it",
            maxIterations: 5,
            verdict: { labels: ["retry", "done"] },
            on: { retry: "fix", done: "$end" },
          },
        ],
      },
    },
    (executor) =>
      Effect.gen(function* () {
        const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
        const settled = yield* awaitSettled(executor, execution.id);
        assert.equal(settled.execution.status, "needs_attention");
        assert.include(settled.execution.error ?? "", "made no progress");
        assert.equal(settled.steps.length, 2);
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
        assert.equal(settled.steps[0]?.threadId, ThreadId.make("routine-thread"));
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

it.effect("cancelling stops the running step's agent thread", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const launched = yield* Deferred.make<void>();
    const stopped: Array<string> = [];
    return yield* withExecutor(
      {
        gate,
        launched,
        stopped,
        routine: {
          version: 1,
          name: "demo",
          steps: [{ id: "review", kind: "agent", purpose: "Review", verdict: { labels: ["ok"] } }],
        },
      },
      (executor) =>
        Effect.gen(function* () {
          const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
          yield* Deferred.await(launched);
          yield* executor.cancel(execution.id);
          assert.deepEqual(stopped, ["routine-thread"]);
        }),
    );
  }),
);

it.effect("git.push and pr.create run from the execution worktree", () =>
  Effect.gen(function* () {
    const seen: Array<string> = [];
    return yield* withExecutor(
      {
        seen,
        routine: {
          version: 1,
          name: "demo",
          steps: [
            { id: "push", kind: "action", action: "git.push", next: ["pr"] },
            { id: "pr", kind: "action", action: "pr.create", draft: true },
          ],
        },
      },
      (executor) =>
        Effect.gen(function* () {
          const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
          const settled = yield* awaitSettled(executor, execution.id);
          assert.deepEqual(seen, ["push:/worktrees/routine", "pr:demo"]);
          assert.equal(
            settled.steps.find((step) => step.stepId === "push")?.verdict?.label,
            "created",
          );
          assert.equal(settled.execution.status, "awaiting_review");
          assert.equal(
            settled.steps.find((step) => step.stepId === "pr")?.outputExcerpt,
            "https://example.test/pull/1",
          );
        }),
    );
  }),
);

it.effect("git.push with nothing to push fails the step", () =>
  withExecutor(
    {
      pushed: false,
      routine: {
        version: 1,
        name: "demo",
        steps: [{ id: "push", kind: "action", action: "git.push" }],
      },
    },
    (executor) =>
      Effect.gen(function* () {
        const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
        const settled = yield* awaitSettled(executor, execution.id);
        assert.equal(settled.execution.status, "failed");
        assert.include(settled.steps[0]?.error ?? "", "Nothing to push");
      }),
  ),
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

it.effect("a verdict loop retries with increasing attempts until maxIterations fails it", () =>
  withExecutor(
    {
      exitCode: 1,
      routine: {
        version: 1,
        name: "demo",
        steps: [
          {
            id: "build",
            kind: "command",
            argv: ["make"],
            maxIterations: 3,
            on: { pass: "$end", fail: "build" },
          },
        ],
      },
    },
    (executor) =>
      Effect.gen(function* () {
        const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
        const settled = yield* awaitSettled(executor, execution.id);
        assert.equal(settled.execution.status, "needs_attention");
        assert.include(settled.execution.error ?? "", 'Step "build" exceeded its limit of 3');
        assert.deepEqual(settled.steps.map((step) => [step.stepId, step.attempt]).sort(), [
          ["build", 1],
          ["build", 2],
          ["build", 3],
        ]);
      }),
  ),
);

const fanOut = (
  readOnly: boolean,
  extra: Record<string, unknown> = {},
  branchB: Record<string, unknown> = {},
) => ({
  version: 1,
  name: "demo",
  steps: [
    { id: "build", kind: "command", argv: ["make"], next: ["a", "b"], onError: "recover" },
    { id: "a", kind: "command", argv: ["a"], readOnly, next: ["ship"], ...extra },
    { id: "b", kind: "command", argv: ["b"], readOnly, next: ["ship"], ...branchB },
    { id: "ship", kind: "command", argv: ["ship"], join: ["a", "b"] },
    { id: "recover", kind: "command", argv: ["recover"] },
  ],
});

it.effect("read-only branches share the worktree and the join runs after both", () => {
  const seen: Array<string> = [];
  const gitCalls: Array<string> = [];
  return withExecutor({ seen, gitCalls, routine: fanOut(true) }, (executor) =>
    Effect.gen(function* () {
      const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
      const settled = yield* awaitSettled(executor, execution.id);
      assert.equal(settled.execution.status, "awaiting_review");
      assert.deepEqual(
        gitCalls.filter((call) => call.includes("merge")),
        [],
      );
      assert.equal(seen.at(-1), "ship @ /worktrees/routine");
      assert.sameMembers(seen.slice(1, 3), ["a @ /worktrees/routine", "b @ /worktrees/routine"]);
      assert.deepEqual(settled.steps.map((step) => step.stepId).sort(), [
        "a",
        "b",
        "build",
        "ship",
      ]);
    }),
  );
});

it.effect("write branches get their own worktrees and merge back in step order", () => {
  const seen: Array<string> = [];
  const gitCalls: Array<string> = [];
  return withExecutor({ seen, gitCalls, routine: fanOut(false) }, (executor) =>
    Effect.gen(function* () {
      const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
      const settled = yield* awaitSettled(executor, execution.id);
      assert.equal(settled.execution.status, "awaiting_review");
      const prefix = `/worktrees/${execution.branch}`;
      assert.sameMembers(seen.slice(1, 3), [`a @ ${prefix}--a-1`, `b @ ${prefix}--b-1`]);
      assert.equal(seen.at(-1), "ship @ /worktrees/routine");
      const merges = gitCalls.filter((call) => call.includes(": merge "));
      assert.deepEqual(merges, [
        `/worktrees/routine: merge --no-ff --no-edit ${execution.branch}--a-1`,
        `/worktrees/routine: merge --no-ff --no-edit ${execution.branch}--b-1`,
      ]);
      assert.equal(gitCalls.filter((call) => call.startsWith("remove ")).length, 2);
    }),
  );
});

it.effect("an approved agent resolution completes a conflicted merge and is recorded", () =>
  withExecutor(
    {
      mergeConflict: true,
      judgeText: "VERDICT: approved - both sides kept",
      routine: fanOut(false),
    },
    (executor) =>
      Effect.gen(function* () {
        const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
        const settled = yield* awaitSettled(executor, execution.id);
        assert.equal(settled.execution.error, null);
        const flagged = settled.feed.flatMap((block) => block.recordCount);
        assert.isTrue(flagged.some((count) => count > 0));
      }),
  ),
);

it.effect("a rejected merge conflict pauses for a person naming the branch and files", () => {
  const gitCalls: Array<string> = [];
  return withExecutor({ gitCalls, mergeConflict: true, routine: fanOut(false) }, (executor) =>
    Effect.gen(function* () {
      const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
      const settled = yield* awaitSettled(executor, execution.id);
      assert.equal(settled.execution.status, "needs_attention");
      assert.include(settled.execution.error ?? "", 'Merge conflict joining step "a"');
      assert.include(settled.execution.error ?? "", "src/a.ts");
      assert.isTrue(gitCalls.some((call) => call.endsWith(": merge --abort")));
      assert.isFalse(settled.steps.some((step) => step.stepId === "ship"));
    }),
  );
});

it.effect("a join does not run when a branch failed, deferring to its onError route", () => {
  const seen: Array<string> = [];
  return withExecutor(
    { seen, failing: ["a"], routine: fanOut(true, { onError: "recover" }) },
    (executor) =>
      Effect.gen(function* () {
        const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
        const settled = yield* awaitSettled(executor, execution.id);
        assert.equal(settled.execution.status, "failed");
        assert.include(settled.execution.error ?? "", 'Join step "ship" never ran');
        assert.isTrue(seen.some((call) => call.startsWith("recover ")));
        assert.isFalse(seen.some((call) => call.startsWith("ship ")));
      }),
  );
});

it.effect("a routine must be approved at its current hash before it can run", () =>
  withExecutor(
    {
      routine: {
        version: 1,
        name: "demo",
        steps: [{ id: "build", kind: "command", argv: ["make"] }],
      },
    },
    (executor, raw) =>
      Effect.gen(function* () {
        const input = { projectId, routineId, brief: "" };
        const refused = yield* raw.start(input).pipe(Effect.flip);
        assert.include(refused.message, "must be approved");

        const approval = yield* raw.approve({
          projectId,
          routineId,
          allowExecutables: ["make", "echo", "true", "pnpm", "npm", "node", "git"],
        });
        const approvals = yield* raw.approvals(projectId);
        assert.equal(approvals.get(routineId)?.hash, approval.approvedHash);
        assert.equal(approvals.get(routineId)?.definition?.name, "demo");

        const { execution } = yield* raw.start(input);
        assert.equal(execution.routineHash, approval.approvedHash);
        yield* awaitSettled(executor, execution.id);
      }),
  ),
);

it.effect("the allowlist gates approval and start, and revoke blocks the next run", () =>
  withExecutor(
    {
      routine: {
        version: 1,
        name: "demo",
        steps: [{ id: "build", kind: "command", argv: ["make"] }],
      },
    },
    (_, raw) =>
      Effect.gen(function* () {
        const input = { projectId, routineId, brief: "" };
        const needsAllow = yield* raw.approve({ projectId, routineId }).pipe(Effect.flip);
        assert.include(needsAllow.message, "make");
        yield* raw.approve({ projectId, routineId, allowExecutables: ["make"] });

        yield* raw.removeExecutable({ projectId, executable: "make" });
        const blocked = yield* raw.start(input).pipe(Effect.flip);
        assert.include(blocked.message, "outside the allowlist");

        yield* raw.approve({ projectId, routineId, allowExecutables: ["make"] });
        yield* raw.revoke({ projectId, routineId });
        const revoked = yield* raw.start(input).pipe(Effect.flip);
        assert.include(revoked.message, "must be approved");
      }),
  ),
);

it.effect("a failed skill preflight removes the worktree", () => {
  const gitCalls: Array<string> = [];
  return withExecutor(
    {
      gitCalls,
      routine: {
        version: 1,
        name: "demo",
        steps: [{ id: "s", kind: "skill", skill: "local", verdict: { labels: ["ok"] } }],
      },
    },
    (executor) =>
      Effect.gen(function* () {
        const failed = yield* executor.start({ projectId, routineId, brief: "" }).pipe(Effect.flip);
        assert.include(failed.message, "preflight");
        assert.include(gitCalls, "remove /worktrees/routine");
      }),
  );
});

it("skill drift flags only changed approved skills", () => {
  assert.deepEqual(
    skillDrift(
      { a: "1", b: "2", c: "3" },
      new Map([
        ["a", "1"],
        ["b", "x"],
      ]),
    ),
    ["b"],
  );
});

it.effect("an edited routine needs re-approval", () =>
  withExecutor(
    {
      routine: {
        version: 1,
        name: "demo",
        steps: [{ id: "build", kind: "command", argv: ["make"] }],
      },
    },
    (_executor, raw, rewrite) =>
      Effect.gen(function* () {
        yield* raw.approve({
          projectId,
          routineId,
          allowExecutables: ["make", "echo", "true", "pnpm", "npm", "node", "git"],
        });
        yield* rewrite({
          version: 1,
          name: "demo",
          steps: [{ id: "build", kind: "command", argv: ["make", "all"] }],
        });
        const refused = yield* raw.start({ projectId, routineId, brief: "" }).pipe(Effect.flip);
        assert.include(refused.message, "must be approved");
      }),
  ),
);

const resumeRoutine = {
  version: 1 as const,
  name: "demo",
  steps: [
    {
      id: RoutineStepId.make("build"),
      kind: "command" as const,
      argv: ["make"],
      next: [RoutineStepId.make("review")],
    },
    {
      id: RoutineStepId.make("review"),
      kind: "agent" as const,
      purpose: "Review",
      verdict: { labels: ["ok"] },
    },
  ],
};
const resumeId = "routine-execution:resume" as RoutineExecutionId;

const seedInterrupted = (runningStep: "build" | "review") =>
  Effect.gen(function* () {
    const repository = yield* ExecutionRepository.ExecutionRepository;
    const at = "2026-01-01T00:00:00.000Z";
    const row = {
      executionId: resumeId,
      attempt: 1,
      outputExcerpt: null,
      error: null,
      startedAt: at,
    };
    yield* repository.setApproval({
      projectId,
      routineId,
      hash: "hash",
      definition: resumeRoutine,
      approvedAt: at,
    });
    yield* repository.addAllowlist({ projectId, executable: "make", addedAt: at });
    yield* repository.insertExecution({
      id: resumeId,
      projectId,
      routineId,
      routineHash: "hash",
      definition: resumeRoutine,
      brief: "",
      status: "running",
      worktreePath: "/worktrees/kept",
      branch: "routine/kept",
      error: null,
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
    });
    yield* repository.upsertStep({
      ...row,
      stepId: RoutineStepId.make("build"),
      status: runningStep === "build" ? "running" : "done",
      verdict: runningStep === "build" ? null : { label: "pass", reason: "ok" },
      threadId: null,
      finishedAt: runningStep === "build" ? null : at,
    });
    if (runningStep === "review") {
      yield* repository.upsertStep({
        ...row,
        stepId: RoutineStepId.make("review"),
        status: "running",
        verdict: null,
        threadId: ThreadId.make("old-thread"),
        finishedAt: null,
      });
    }
    yield* repository.saveFrontier(resumeId, {
      ready: [RoutineStepId.make(runningStep)],
      waiting: [],
      attempts: runningStep === "build" ? {} : { build: 1 },
      head: "",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default-model" },
    });
  });

it.effect.each([
  { clean: true, thread: "old-thread" },
  { clean: false, thread: "" },
])("an interrupted execution resumes from its frontier (clean $clean)", ({ clean, thread }) => {
  const gitCalls: Array<string> = [];
  const continued: Array<string> = [];
  return withExecutor(
    {
      gitCalls,
      continued,
      cleanWorktree: clean,
      routine: resumeRoutine,
      seed: seedInterrupted("review"),
    },
    (executor, raw) =>
      Effect.gen(function* () {
        const before = yield* executor
          .subscribeExecution(resumeId)
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
        assert.equal(before.execution.status, "interrupted");

        yield* raw.control({ executionId: resumeId, action: "resume" });
        const finished = yield* executor.subscribeExecution(resumeId).pipe(
          Stream.filter((snapshot) => snapshot.execution.status === "awaiting_review"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        assert.deepEqual(continued, [thread]);
        assert.equal(
          gitCalls.some((call) => call.includes("reset --hard")),
          !clean,
        );
        assert.equal(finished.steps.filter((step) => step.stepId === "build").length, 1);
      }),
  );
});

it.effect("auto-resume continues agent steps but holds interrupted command steps", () =>
  Effect.gen(function* () {
    yield* withExecutor(
      {
        autoResume: true,
        cleanWorktree: true,
        routine: resumeRoutine,
        seed: seedInterrupted("review"),
      },
      (executor) =>
        executor.subscribeExecution(resumeId).pipe(
          Stream.filter((snapshot) => snapshot.execution.status === "awaiting_review"),
          Stream.runHead,
        ),
    );
    yield* withExecutor(
      { autoResume: true, routine: resumeRoutine, seed: seedInterrupted("build") },
      (executor) =>
        Effect.gen(function* () {
          const held = yield* executor
            .subscribeExecution(resumeId)
            .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
          assert.equal(held.execution.status, "interrupted");
          assert.include(held.execution.error ?? "", "may still be running");
        }),
    );
  }),
);

it.effect("an action step commits pending step output before pushing", () => {
  const gitCalls: Array<string> = [];
  return withExecutor(
    {
      gitCalls,
      routine: {
        version: 1,
        name: "demo",
        steps: [{ id: "push", kind: "action", action: "git.push" }],
      },
    },
    (executor) =>
      Effect.gen(function* () {
        const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
        yield* awaitSettled(executor, execution.id);
        assert.isTrue(gitCalls.some((call) => call.includes("commit -m Routine step output")));
      }),
  );
});

it.effect("executions left running by a restart are failed and keep their worktree", () => {
  const seededId = "routine-execution:seeded" as RoutineExecutionId;
  return withExecutor(
    {
      routine: {
        version: 1,
        name: "demo",
        steps: [{ id: "build", kind: "command", argv: ["make"] }],
      },
      seed: Effect.gen(function* () {
        const repository = yield* ExecutionRepository.ExecutionRepository;
        const at = "2026-01-01T00:00:00.000Z";
        yield* repository.insertExecution({
          id: seededId,
          projectId,
          routineId,
          routineHash: "hash",
          definition: {
            version: 1,
            name: "demo",
            steps: [{ id: RoutineStepId.make("build"), kind: "command", argv: ["make"] }],
          },
          brief: "",
          status: "running",
          worktreePath: "/worktrees/kept",
          branch: "routine/kept",
          error: null,
          createdAt: at,
          updatedAt: at,
          finishedAt: null,
        });
        yield* repository.upsertStep({
          executionId: seededId,
          stepId: RoutineStepId.make("build"),
          attempt: 1,
          status: "running",
          verdict: null,
          outputExcerpt: null,
          threadId: null,
          error: null,
          startedAt: at,
          finishedAt: null,
        });
      }),
    },
    (executor) =>
      Effect.gen(function* () {
        const snapshot = yield* executor
          .subscribeExecution(seededId)
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
        assert.equal(snapshot.execution.status, "failed");
        assert.equal(snapshot.execution.error, "Interrupted by a server restart");
        assert.equal(snapshot.execution.worktreePath, "/worktrees/kept");
        assert.equal(snapshot.steps[0]?.status, "failed");
        assert.equal(snapshot.steps[0]?.error, "Interrupted by a server restart");
      }),
  );
});

const askRoutine = {
  version: 1,
  name: "demo",
  council: { maxQuestionsPerStep: 1 },
  steps: [{ id: "review", kind: "agent", purpose: "Review", verdict: { labels: ["ok"] } }],
};
const question: OrchestrationV2UserInputQuestion = {
  id: "scope",
  header: "Scope",
  question: "Which scope?",
  options: [{ label: "narrow", description: "Only the diff" }],
};

it.effect("the council answers an agent question, records it, and caches a feed summary", () => {
  const answers: Array<unknown> = [];
  return withExecutor(
    {
      routine: askRoutine,
      verdictText: "VERDICT: ok - fine",
      question: [question],
      answers,
      councilText:
        'Thinking.\nCOUNCIL: {"answers":{"scope":"narrow"},"rationale":"Smallest change","confidence":"low"}',
    },
    (executor) =>
      Effect.gen(function* () {
        const { execution } = yield* executor.start({ projectId, routineId, brief: "ship it" });
        yield* awaitSettled(executor, execution.id);
        assert.deepEqual(answers, [{ scope: "narrow" }]);

        const { records } = yield* executor.councilRecords({
          executionId: execution.id,
          stepId: RoutineStepId.make("review"),
          attempt: 1,
        });
        assert.deepEqual(
          records.map((record) => [
            record.question,
            record.answer,
            record.confidence,
            record.independent,
          ]),
          [["Which scope?", "narrow", "low", false]],
        );

        const withSummary = yield* executor.subscribeExecution(execution.id).pipe(
          Stream.filter((snapshot) => snapshot.feed[0]?.summary != null),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        const block = withSummary.feed[0];
        assert.equal(block?.summary, "- chose X");
        assert.equal(block?.recordCount, 1);
        assert.deepEqual(
          block?.flagged.map((entry) => entry.answer),
          ["narrow"],
        );
      }),
  );
});

it.effect("a question beyond the per-step cap fails the step instead of waiting", () =>
  withExecutor(
    {
      routine: askRoutine,
      verdictText: "VERDICT: ok - fine",
      question: [question, { ...question, id: "depth" }],
      answers: [],
      councilText: "no reply line",
    },
    (executor) =>
      Effect.gen(function* () {
        const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
        const settled = yield* awaitSettled(executor, execution.id);
        assert.equal(settled.execution.status, "failed");
        assert.match(settled.execution.error ?? "", /limit of 1 questions/);
        assert.deepEqual(
          settled.feed.map((block) => block.recordCount),
          [0],
        );
      }),
  ),
);

const twoAskRoutine = {
  ...askRoutine,
  steps: [
    { id: "one", kind: "agent", purpose: "One", next: ["two"], verdict: { labels: ["ok"] } },
    { id: "two", kind: "agent", purpose: "Two", verdict: { labels: ["ok"] } },
  ],
};
const councilReply =
  'COUNCIL: {"answers":{"scope":"narrow"},"rationale":"Smallest","confidence":"high"}';

it.effect("later questions continue the execution's one council thread", () => {
  const continued: Array<string> = [];
  return withExecutor(
    {
      routine: twoAskRoutine,
      verdictText: "VERDICT: ok - fine",
      question: [question],
      answers: [],
      continued,
      councilText: councilReply,
    },
    (executor) =>
      Effect.gen(function* () {
        const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
        const settled = yield* awaitSettled(executor, execution.id);
        assert.equal(settled.execution.status, "awaiting_review");
        assert.isTrue(continued.includes("council-thread"));
      }),
  );
});

it.effect("a council thread over its token cap stops the step", () =>
  withExecutor(
    {
      routine: { ...twoAskRoutine, council: { maxQuestionsPerStep: 1, maxTokens: 100 } },
      verdictText: "VERDICT: ok - fine",
      question: [question],
      answers: [],
      councilText: councilReply,
      councilTokens: 100,
    },
    (executor) =>
      Effect.gen(function* () {
        const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
        const settled = yield* awaitSettled(executor, execution.id);
        assert.match(settled.execution.error ?? "", /limit of 100 tokens/);
      }),
  ),
);

it.effect("a human step waits for a response, which routes the walk and becomes output", () =>
  withExecutor(
    {
      routine: {
        version: 1,
        name: "demo",
        steps: [
          {
            id: "ask",
            kind: "human",
            prompt: "Ship it?",
            verdict: { labels: ["yes", "no"] },
            on: { yes: "build", no: "$end" },
          },
          { id: "build", kind: "command", argv: ["make"], inputs: ["ask"] },
        ],
      },
    },
    (executor) =>
      Effect.gen(function* () {
        const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
        const executionId = execution.id;
        const waiting = yield* executor.subscribeExecution(executionId).pipe(
          Stream.filter((snapshot) => snapshot.execution.status === "needs_attention"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        assert.match(waiting.execution.error ?? "", /Ship it\?/);
        const retry = yield* Effect.flip(executor.control({ executionId, action: "retry" }));
        assert.match(retry.message, /Respond to the waiting step/);
        const wrong = yield* Effect.flip(
          executor.control({
            executionId,
            action: "respond",
            stepId: RoutineStepId.make("ask"),
            label: "maybe",
            note: "",
          }),
        );
        assert.match(wrong.message, /not a verdict/);
        yield* executor.control({
          executionId,
          action: "respond",
          stepId: RoutineStepId.make("ask"),
          label: "yes",
          note: "Looks good",
        });
        const settled = yield* executor.subscribeExecution(executionId).pipe(
          Stream.filter((snapshot) => snapshot.execution.status === "awaiting_review"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        const ask = settled.steps.find((step) => step.stepId === "ask");
        assert.equal(ask?.verdict?.label, "yes");
        assert.equal(ask?.outputExcerpt, "Looks good");
        assert.isTrue(settled.steps.some((step) => step.stepId === "build"));
      }),
  ),
);

it.effect("an unparseable council reply fails the step", () =>
  withExecutor(
    {
      routine: { ...askRoutine, council: undefined },
      verdictText: "VERDICT: ok - fine",
      question: [question],
      answers: [],
      councilText: "I am not sure.",
    },
    (executor) =>
      Effect.gen(function* () {
        const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
        const settled = yield* awaitSettled(executor, execution.id);
        assert.equal(settled.execution.status, "failed");
        assert.match(settled.execution.error ?? "", /no usable answer/);
      }),
  ),
);
