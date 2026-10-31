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
import * as ProjectService from "../project/ProjectService.ts";
import { RoutineGitProvisioner } from "./adapters/git.ts";
import { RoutineProcessRunner } from "./adapters/process.ts";
import { RoutineThreadRunner } from "./adapters/threads.ts";
import * as ExecutionRepository from "./ExecutionRepository.ts";
import { RoutineSkillInstaller } from "./steps/preflight.ts";
import { Executor, layer as executorLayer } from "./Executor.ts";

const projectId = ProjectId.make("routine-project");
// Branded ids are plain strings at runtime; the routine file basename is the id.
const routineId = "demo" as RoutineId;

interface Fakes {
  readonly routine: unknown;
  readonly exitCode?: number;
  readonly verdictText?: string;
  /** The agent step's thread asks this once; the answers it receives land in `answers`. */
  readonly question?: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  readonly answers?: Array<unknown>;
  readonly councilText?: string;
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
                  return {
                    code: args[0] === "merge" && fakes.mergeConflict === true ? 1 : 0,
                    output:
                      args[0] === "status" ? "M file" : args[0] === "diff" ? "src/a.ts\n" : "",
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
            }) =>
              Effect.gen(function* () {
                if (title.startsWith("Council summary")) {
                  return { threadId: ThreadId.make("summary-thread"), verdictText: "- chose X" };
                }
                if (title.startsWith("Council:")) {
                  return {
                    threadId: ThreadId.make("council-thread"),
                    verdictText: fakes.councilText ?? "",
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
                  verdictText: fakes.verdictText ?? "",
                };
              }),
            resolveDefaultModel: () =>
              Effect.succeed({
                instanceId: ProviderInstanceId.make("codex"),
                model: "default-model",
              }),
          }),
          Layer.mock(RoutineSkillInstaller)({}),
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
                .approve({ projectId: input.projectId, routineId: input.routineId })
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
        assert.equal(settled.execution.status, "failed");
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
      assert.deepEqual(gitCalls, []);
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

it.effect("a merge conflict fails the execution naming the branch and files", () => {
  const gitCalls: Array<string> = [];
  return withExecutor({ gitCalls, mergeConflict: true, routine: fanOut(false) }, (executor) =>
    Effect.gen(function* () {
      const { execution } = yield* executor.start({ projectId, routineId, brief: "" });
      const settled = yield* awaitSettled(executor, execution.id);
      assert.equal(settled.execution.status, "failed");
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

        const approval = yield* raw.approve({ projectId, routineId });
        const approvals = yield* raw.approvals(projectId);
        assert.equal(approvals.get(routineId)?.hash, approval.approvedHash);
        assert.equal(approvals.get(routineId)?.definition?.name, "demo");

        const { execution } = yield* raw.start(input);
        assert.equal(execution.routineHash, approval.approvedHash);
        yield* awaitSettled(executor, execution.id);
      }),
  ),
);

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
        yield* raw.approve({ projectId, routineId });
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
