import {
  type ModelSelection,
  type OrchestrationV2UserInputQuestion,
  type ProjectId,
  type ProviderUserInputAnswers,
  type RoutineCouncilRecord,
  type RoutineCouncilRecordsInput,
  type RoutineCouncilRecordsResult,
  type RoutineFeedBlock,
  type RoutineRegenerateSummaryInput,
  type RoutineRegenerateSummaryResult,
  type RoutineExecutionStep,
  type RoutineStep,
  type ThreadId,
  type RoutineExecution,
  RoutineError,
  RoutineExecutionId,
  type RoutineExecutionResult,
  type RoutineExecutionsResult,
  type RoutineApproveInput,
  type RoutineApproveResult,
  type RoutineCancelResult,
  type RoutineStartInput,
  type RoutineStartResult,
  type RoutineId,
  type RoutineStepId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ProjectService from "../project/ProjectService.ts";
import { RoutineGitProvisioner } from "./adapters/git.ts";
import { RoutineThreadRunner, type RoutineWorkspaceStrategy } from "./adapters/threads.ts";
import { ExecutionRepository, type ExecutionStepRecord } from "./ExecutionRepository.ts";
import { RoutineSkillInstaller, runSkillPreflight } from "./steps/preflight.ts";
import * as RoutineStore from "./RoutineStore.ts";
import { attemptLimit, nextSteps } from "./routing.ts";
import {
  buildCouncilPrompt,
  buildSummaryPrompt,
  DEFAULT_MAX_QUESTIONS_PER_STEP,
  flaggedHighlights,
  formatAnswer,
  parseCouncilReply,
} from "./steps/council.ts";
import {
  RoutineStepError,
  type RoutineStepContext,
  type RoutineStepRequirements,
  runStep,
} from "./steps/StepRunner.ts";

const RESTART_ERROR = "Interrupted by a server restart";
const COUNCIL_TIMEOUT_MS = 10 * 60 * 1000;
const SUMMARY_MAX_CHARS = 1500;
const EARLIER_DECISIONS_LIMIT = 20;
const EARLIER_OUTPUTS_LIMIT = 3;

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const causeMessage = (cause: Cause.Cause<unknown>, fallback: string): string => {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
};

export class Executor extends Context.Service<
  Executor,
  {
    readonly start: (input: RoutineStartInput) => Effect.Effect<RoutineStartResult, RoutineError>;
    readonly approve: (
      input: RoutineApproveInput,
    ) => Effect.Effect<RoutineApproveResult, RoutineError>;
    readonly approvedHashes: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyMap<string, string>, RoutineError>;
    readonly cancel: (id: RoutineExecutionId) => Effect.Effect<RoutineCancelResult, RoutineError>;
    readonly subscribeExecutions: (
      projectId: ProjectId,
    ) => Stream.Stream<RoutineExecutionsResult, RoutineError>;
    readonly subscribeExecution: (
      id: RoutineExecutionId,
    ) => Stream.Stream<RoutineExecutionResult, RoutineError>;
    readonly councilRecords: (
      input: RoutineCouncilRecordsInput,
    ) => Effect.Effect<RoutineCouncilRecordsResult, RoutineError>;
    readonly regenerateSummary: (
      input: RoutineRegenerateSummaryInput,
    ) => Effect.Effect<RoutineRegenerateSummaryResult, RoutineError>;
  }
>()("t3/routines/Executor") {}

const make = Effect.gen(function* () {
  const projectService = yield* ProjectService.ProjectService;
  const repository = yield* ExecutionRepository;
  const git = yield* RoutineGitProvisioner;
  const threads = yield* RoutineThreadRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const layerScope = yield* Effect.scope;
  // Step runners resolve their adapters from context; capture it so forked walks outlive the request.
  const skillInstaller = yield* RoutineSkillInstaller;
  const stepEnv = yield* Effect.context<RoutineStepRequirements>();
  // Subscribers only need the newest dirty signal; each one re-reads full state.
  const changesPubSub = yield* PubSub.sliding<void>(1);

  const runningFibers = new Map<RoutineExecutionId, Fiber.Fiber<void>>();
  // Council threads are not step rows, so cancel needs its own list to stop them.
  const councilThreads = new Map<RoutineExecutionId, Set<ThreadId>>();

  const notify = PubSub.publish(changesPubSub, undefined).pipe(Effect.asVoid);

  const persistExecution = (execution: RoutineExecution) =>
    repository.updateExecution(execution).pipe(
      Effect.tapError((error) => Effect.logWarning("Routine execution write failed", { error })),
      Effect.ignore,
      Effect.andThen(notify),
    );

  const persistStep = (step: ExecutionStepRecord) =>
    repository.upsertStep(step).pipe(
      Effect.tapError((error) => Effect.logWarning("Routine step write failed", { error })),
      Effect.ignore,
      Effect.andThen(notify),
    );

  const stepLabel = (step: RoutineStep) => step.title ?? step.id;

  /** Answers one step's thread questions through the council, recording each decision. */
  const councilFor = (
    execution: RoutineExecution,
    step: RoutineStep,
    attempt: number,
    workspaceStrategy: RoutineWorkspaceStrategy,
    author: ModelSelection,
  ) =>
    Effect.fn("Executor.council")(function* (
      threadId: ThreadId,
      question: {
        readonly requestId: string;
        readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
      },
    ): Effect.fn.Return<ProviderUserInputAnswers, RoutineStepError> {
      const toStepError = (cause: RoutineError) =>
        new RoutineStepError({ message: cause.message, cause });
      const { definition } = execution;
      const earlier = yield* repository
        .listCouncilRecords({ executionId: execution.id })
        .pipe(Effect.mapError(toStepError));
      const used = earlier.filter(
        (record) => record.stepId === step.id && record.attempt === attempt,
      ).length;
      const cap = definition.council?.maxQuestionsPerStep ?? DEFAULT_MAX_QUESTIONS_PER_STEP;
      if (used + question.questions.length > cap) {
        return yield* new RoutineStepError({
          message: `Council reached its limit of ${cap} questions for step "${step.id}"; a person needs to answer.`,
        });
      }
      const steps = yield* repository.listSteps(execution.id).pipe(Effect.mapError(toStepError));
      const council = yield* threads.resolveCouncilModel({ author, config: definition.council });
      const prompt = buildCouncilPrompt({
        routineName: definition.name,
        routineDescription: definition.description,
        brief: execution.brief,
        stepLabel: stepLabel(step),
        stepPurpose:
          step.kind === "agent" ? step.purpose : step.kind === "skill" ? `Skill ${step.skill}` : "",
        earlierDecisions: earlier.slice(-EARLIER_DECISIONS_LIMIT),
        earlierOutputs: steps
          .filter((row) => row.status === "done" && (row.outputExcerpt ?? "") !== "")
          .slice(-EARLIER_OUTPUTS_LIMIT)
          .map((row) => ({ stepId: row.stepId, excerpt: row.outputExcerpt ?? "" })),
        questions: question.questions,
      });
      const councilSet = councilThreads.get(execution.id) ?? new Set<ThreadId>();
      councilThreads.set(execution.id, councilSet);
      const result = yield* threads.runAgentStep({
        projectId: execution.projectId,
        workspaceStrategy,
        prompt,
        modelSelection: council.selection,
        title: `Council: ${stepLabel(step)}`,
        timeoutMs: COUNCIL_TIMEOUT_MS,
        runtimeMode: "approval-required",
        declineApprovals: true,
        onLaunched: (id) => Effect.sync(() => void councilSet.add(id)),
      });
      const reply = parseCouncilReply(result.verdictText, question.questions);
      if (reply === null) {
        return yield* new RoutineStepError({
          message: `Council gave no usable answer for step "${step.id}".`,
        });
      }
      const createdAt = yield* nowIso;
      for (const item of question.questions) {
        const unique = yield* crypto
          .randomUUIDv4()
          .pipe(
            Effect.mapError(
              (cause) => new RoutineStepError({ message: "Failed to create a record id.", cause }),
            ),
          );
        const record: RoutineCouncilRecord = {
          id: `routine-council:${unique}`,
          executionId: execution.id,
          stepId: step.id,
          attempt,
          threadId,
          requestId: question.requestId,
          question: item.question,
          answer: formatAnswer(reply.answers[item.id]),
          rationale: reply.rationale,
          confidence: reply.confidence,
          independent: council.independent,
          createdAt,
        };
        yield* repository.insertCouncilRecord(record).pipe(Effect.mapError(toStepError));
      }
      yield* notify;
      return reply.answers;
    });

  /** Writes the cached summary of a finished step's council decisions; no-op without any. */
  const summarizeStep = Effect.fn("Executor.summarizeStep")(function* (
    execution: RoutineExecution,
    step: RoutineExecutionStep,
  ) {
    if (execution.worktreePath === null || execution.branch === null) return null;
    const records = yield* repository.listCouncilRecords({
      executionId: execution.id,
      stepId: step.stepId,
      attempt: step.attempt,
    });
    if (records.length === 0) return null;
    const modelSelection = yield* threads.resolveDefaultModel(execution.projectId);
    const result = yield* threads
      .runAgentStep({
        projectId: execution.projectId,
        workspaceStrategy: {
          type: "existing_worktree",
          worktreePath: execution.worktreePath,
          branch: execution.branch,
        },
        prompt: buildSummaryPrompt({
          stepLabel: step.stepId,
          verdict: step.verdict,
          records,
        }),
        modelSelection,
        title: `Council summary: ${step.stepId}`,
        timeoutMs: COUNCIL_TIMEOUT_MS,
        runtimeMode: "approval-required",
        declineApprovals: true,
      })
      .pipe(Effect.mapError((cause) => new RoutineError({ message: cause.message, cause })));
    const summary = result.verdictText.trim().slice(0, SUMMARY_MAX_CHARS);
    if (summary === "") return null;
    yield* repository.upsertSummary({
      executionId: execution.id,
      stepId: step.stepId,
      attempt: step.attempt,
      summary,
      generatedAt: yield* nowIso,
    });
    yield* notify;
    return summary;
  });

  const runExecution = Effect.fn("Executor.runExecution")(
    function* (
      initial: RoutineExecution,
      workspaceStrategy: RoutineWorkspaceStrategy,
      modelSelection: ModelSelection | undefined,
    ) {
      const { definition } = initial;
      const stepContext: RoutineStepContext = {
        projectId: initial.projectId,
        brief: initial.brief,
        routineName: definition.name,
        workspaceStrategy,
        modelSelection,
      };

      let current: RoutineStepId | undefined = definition.start ?? definition.steps[0]?.id;
      const attempts = new Map<RoutineStepId, number>();
      while (current !== undefined) {
        const stepId: RoutineStepId = current;
        const step = definition.steps.find((candidate) => candidate.id === stepId);
        if (step === undefined) {
          const finishedAt = yield* nowIso;
          yield* persistExecution({
            ...initial,
            status: "failed",
            error: `Unknown step "${stepId}".`,
            updatedAt: finishedAt,
            finishedAt,
          });
          return;
        }

        const attempt = (attempts.get(step.id) ?? 0) + 1;
        const limit = attemptLimit(step);
        if (attempt > limit) {
          const finishedAt = yield* nowIso;
          yield* persistExecution({
            ...initial,
            status: "failed",
            error: `Step "${step.id}" exceeded its limit of ${limit} iterations.`,
            updatedAt: finishedAt,
            finishedAt,
          });
          return;
        }
        attempts.set(step.id, attempt);

        const startedAt = yield* nowIso;
        const running: ExecutionStepRecord = {
          executionId: initial.id,
          stepId: step.id,
          attempt,
          status: "running",
          verdict: null,
          outputExcerpt: null,
          threadId: null,
          error: null,
          startedAt,
          finishedAt: null,
        };
        yield* persistStep(running);

        const outcome = yield* Effect.exit(
          runStep(step, {
            ...stepContext,
            onThreadLaunched: (threadId) => persistStep({ ...running, threadId }),
            ...(modelSelection === undefined
              ? {}
              : {
                  answerQuestion: councilFor(
                    initial,
                    step,
                    attempt,
                    workspaceStrategy,
                    modelSelection,
                  ),
                }),
          }),
        );
        const finishedAt = yield* nowIso;
        const result = Exit.isSuccess(outcome) ? outcome.value : undefined;
        // A command's `fail` verdict only continues the walk when the step routes it explicitly.
        const error = Exit.isFailure(outcome)
          ? causeMessage(outcome.cause, "Step failed unexpectedly.")
          : step.kind === "command" &&
              outcome.value.verdict.label === "fail" &&
              step.on?.["fail"] === undefined
            ? `Command failed (${outcome.value.verdict.reason}).`
            : null;

        yield* persistStep({
          ...running,
          status: error === null ? "done" : "failed",
          verdict: result?.verdict ?? null,
          outputExcerpt: result?.outputExcerpt ?? null,
          threadId: result?.threadId ?? null,
          error,
          finishedAt,
        });
        if (step.kind === "agent" || step.kind === "skill") {
          const finished: ExecutionStepRecord = {
            ...running,
            status: error === null ? "done" : "failed",
            verdict: result?.verdict ?? null,
            finishedAt,
          };
          yield* summarizeStep(initial, finished).pipe(
            Effect.catch((cause) => Effect.logWarning("Council summary failed", { cause })),
            Effect.forkIn(layerScope),
          );
        }

        if (error !== null || result === undefined) {
          if (step.onError !== undefined) {
            current = step.onError;
            continue;
          }
          // The worktree is kept on failure so the user can inspect it.
          yield* persistExecution({
            ...initial,
            status: "failed",
            error: error ?? "Step produced no result.",
            updatedAt: finishedAt,
            finishedAt,
          });
          return;
        }
        const successors = nextSteps(definition, step.id, result.verdict.label);
        if (successors.length > 1) {
          // Fan-out/join is not implemented; refuse rather than drop branches.
          yield* persistExecution({
            ...initial,
            status: "failed",
            error: `Step "${step.id}" has multiple next steps; parallel fan-out is not supported yet.`,
            updatedAt: finishedAt,
            finishedAt,
          });
          return;
        }
        current = successors[0];
      }

      const finishedAt = yield* nowIso;
      yield* persistExecution({
        ...initial,
        status: "awaiting_review",
        updatedAt: finishedAt,
        finishedAt,
      });
    },
    (effect, initial) =>
      effect.pipe(
        // Cancellation interrupts the walk and persists its own status; do not overwrite it.
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) =>
            nowIso.pipe(
              Effect.flatMap((finishedAt) =>
                persistExecution({
                  ...initial,
                  status: "failed",
                  error: causeMessage(cause, "Execution failed unexpectedly."),
                  updatedAt: finishedAt,
                  finishedAt,
                }),
              ),
            ),
        ),
      ),
  );

  const loadRunnable = Effect.fn("Executor.loadRunnable")(function* (
    projectId: ProjectId,
    routineId: RoutineId,
  ) {
    const project = yield* projectService
      .getById(projectId)
      .pipe(
        Effect.mapError(
          (cause) => new RoutineError({ message: "Failed to resolve project for routine.", cause }),
        ),
      );
    if (Option.isNone(project)) {
      return yield* new RoutineError({ message: `Project ${projectId} not found.` });
    }
    const workspaceRoot = project.value.workspaceRoot;

    const summaries = yield* RoutineStore.list({ workspaceRoot, projectId }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new RoutineError({ message: "Failed to read routines.", cause })),
    );

    const summary = summaries.find((candidate) => candidate.id === routineId);
    if (summary === undefined || summary.definition === null || summary.hash === null) {
      return yield* new RoutineError({
        message: `Routine "${routineId}" was not found or could not be parsed.`,
        routineId,
      });
    }
    if (summary.issues.length > 0) {
      return yield* new RoutineError({
        message: `Routine "${routineId}" has ${summary.issues.length} validation issue(s).`,
        routineId,
      });
    }
    return { workspaceRoot, definition: summary.definition, hash: summary.hash };
  });

  const approve: Executor["Service"]["approve"] = Effect.fn("Executor.approve")(function* (input) {
    const { hash } = yield* loadRunnable(input.projectId, input.routineId);
    yield* repository.setApproval({
      projectId: input.projectId,
      routineId: input.routineId,
      hash,
      approvedAt: yield* nowIso,
    });
    return { routineId: input.routineId, approvedHash: hash };
  });

  const start: Executor["Service"]["start"] = Effect.fn("Executor.start")(function* (input) {
    const { workspaceRoot, definition, hash } = yield* loadRunnable(
      input.projectId,
      input.routineId,
    );
    const approvals = yield* repository.listApprovedHashes(input.projectId);
    if (approvals.get(input.routineId) !== hash) {
      return yield* new RoutineError({
        message: `Routine "${input.routineId}" must be approved before it can run.`,
        routineId: input.routineId,
      });
    }

    const needsModel = definition.steps.some(
      (step) => step.kind === "agent" || step.kind === "skill",
    );
    const modelSelection =
      input.modelSelection ??
      (needsModel ? yield* threads.resolveDefaultModel(input.projectId) : undefined);

    const unique = yield* crypto
      .randomUUIDv4()
      .pipe(
        Effect.mapError(
          (cause) => new RoutineError({ message: "Failed to create an execution id.", cause }),
        ),
      );
    const worktree = yield* git.provisionWorktree({
      workspaceRoot,
      baseRef: "HEAD",
      branch: `routine/${input.routineId}-${unique.slice(0, 8)}`,
    });
    yield* runSkillPreflight({
      worktreePath: worktree.worktreePath,
      definition,
      providers: modelSelection === undefined ? [] : [modelSelection.instanceId],
    }).pipe(
      Effect.provideService(RoutineSkillInstaller, skillInstaller),
      Effect.provideContext(stepEnv),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.mapError(
        (error) =>
          new RoutineError({
            message: `Skill preflight failed: ${error.message}`,
            routineId: input.routineId,
          }),
      ),
    );
    const createdAt = yield* nowIso;
    const execution: RoutineExecution = {
      id: RoutineExecutionId.make(`routine-execution:${unique}`),
      projectId: input.projectId,
      routineId: input.routineId,
      routineHash: hash,
      definition,
      brief: input.brief,
      status: "running",
      worktreePath: worktree.worktreePath,
      branch: worktree.branch,
      error: null,
      createdAt,
      updatedAt: createdAt,
      finishedAt: null,
    };

    yield* repository.insertExecution(execution);
    yield* notify;
    const fiber = yield* Effect.forkIn(
      runExecution(execution, { type: "existing_worktree", ...worktree }, modelSelection).pipe(
        Effect.provide(stepEnv),
        Effect.ensuring(Effect.sync(() => void runningFibers.delete(execution.id))),
      ),
      layerScope,
    );
    runningFibers.set(execution.id, fiber);
    return { execution };
  });

  const cancel: Executor["Service"]["cancel"] = Effect.fn("Executor.cancel")(function* (id) {
    const { execution, steps } = yield* readExecution(id);
    const fiber = runningFibers.get(id);
    if (execution.status !== "running" || fiber === undefined) {
      return yield* new RoutineError({ message: `Routine execution ${id} is not running.` });
    }
    yield* Fiber.interrupt(fiber);
    for (const step of steps) {
      if (step.status === "running" && step.threadId !== null) {
        yield* threads.stopThread({ projectId: execution.projectId, threadId: step.threadId }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Failed to stop routine agent thread", { error }),
          ),
          Effect.ignore,
        );
      }
    }
    for (const threadId of councilThreads.get(id) ?? []) {
      yield* threads.stopThread({ projectId: execution.projectId, threadId }).pipe(Effect.ignore);
    }
    councilThreads.delete(id);
    const finishedAt = yield* nowIso;
    for (const step of steps) {
      if (step.status === "running") {
        yield* persistStep({
          ...step,
          executionId: id,
          status: "failed",
          error: "Cancelled",
          finishedAt,
        });
      }
    }
    const cancelled: RoutineExecution = {
      ...execution,
      status: "cancelled",
      updatedAt: finishedAt,
      finishedAt,
    };
    yield* persistExecution(cancelled);
    return { execution: cancelled };
  });

  const readExecution = Effect.fn("Executor.readExecution")(function* (id: RoutineExecutionId) {
    const execution = yield* repository.getExecution(id);
    if (Option.isNone(execution)) {
      return yield* new RoutineError({ message: `Routine execution ${id} not found.` });
    }
    const steps = yield* repository.listSteps(id);
    const records = yield* repository.listCouncilRecords({ executionId: id });
    const summaries = yield* repository.listSummaries(id);
    // Newest first; a step that has not started has no row, so it has no block.
    const feed = steps
      .map((step): RoutineFeedBlock => {
        const own = records.filter(
          (record) => record.stepId === step.stepId && record.attempt === step.attempt,
        );
        return {
          stepId: step.stepId,
          attempt: step.attempt,
          stepStatus: step.status,
          verdict: step.verdict,
          summary: summaries.get(`${step.stepId}:${step.attempt}`) ?? null,
          recordCount: own.length,
          flagged: flaggedHighlights(own),
        };
      })
      .reverse();
    return { execution: execution.value, steps, feed };
  });

  const councilRecords: Executor["Service"]["councilRecords"] = Effect.fn(
    "Executor.councilRecords",
  )(function* (input) {
    return {
      records: yield* repository.listCouncilRecords({
        executionId: input.executionId,
        stepId: input.stepId,
        attempt: input.attempt,
      }),
    };
  });

  const regenerateSummary: Executor["Service"]["regenerateSummary"] = Effect.fn(
    "Executor.regenerateSummary",
  )(function* (input) {
    const { execution, steps } = yield* readExecution(input.executionId);
    const step = steps.find(
      (candidate) => candidate.stepId === input.stepId && candidate.attempt === input.attempt,
    );
    if (step === undefined || step.status === "running") {
      return yield* new RoutineError({ message: "That step has no finished run to summarize." });
    }
    return { summary: yield* summarizeStep(execution, step) };
  });

  const subscribeTo = <A>(read: Effect.Effect<A, RoutineError>) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading so changes landing mid-read still trigger a re-read.
        const subscription = yield* PubSub.subscribe(changesPubSub);
        return Stream.concat(
          Stream.fromEffect(read),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => read)),
        );
      }),
    );

  const subscribeExecutions: Executor["Service"]["subscribeExecutions"] = (projectId) =>
    subscribeTo(
      repository.listExecutions(projectId).pipe(Effect.map((executions) => ({ executions }))),
    );

  const subscribeExecution: Executor["Service"]["subscribeExecution"] = (id) =>
    subscribeTo(readExecution(id));

  // Fibers do not survive a restart; fail what was left running and keep its worktree.
  const interrupted = yield* repository.listRunning();
  for (const execution of interrupted) {
    const steps = yield* repository.listSteps(execution.id);
    const finishedAt = yield* nowIso;
    for (const step of steps) {
      if (step.status === "running") {
        yield* persistStep({
          ...step,
          executionId: execution.id,
          status: "failed",
          error: RESTART_ERROR,
          finishedAt,
        });
      }
    }
    yield* persistExecution({
      ...execution,
      status: "failed",
      error: RESTART_ERROR,
      updatedAt: finishedAt,
      finishedAt,
    });
  }

  return Executor.of({
    start,
    approve,
    approvedHashes: repository.listApprovedHashes,
    cancel,
    subscribeExecutions,
    subscribeExecution,
    councilRecords,
    regenerateSummary,
  });
});

export const layer = Layer.effect(Executor, make);
