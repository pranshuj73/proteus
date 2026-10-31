import {
  type ModelSelection,
  type ProjectId,
  type RoutineExecution,
  RoutineError,
  RoutineExecutionId,
  type RoutineExecutionResult,
  type RoutineExecutionsResult,
  type RoutineCancelResult,
  type RoutineStartInput,
  type RoutineStartResult,
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
import * as RoutineStore from "./RoutineStore.ts";
import { nextSteps } from "./routing.ts";
import {
  type RoutineStepContext,
  type RoutineStepRequirements,
  runStep,
} from "./steps/StepRunner.ts";

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const causeMessage = (cause: Cause.Cause<unknown>, fallback: string): string => {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
};

export class Executor extends Context.Service<
  Executor,
  {
    readonly start: (input: RoutineStartInput) => Effect.Effect<RoutineStartResult, RoutineError>;
    readonly cancel: (id: RoutineExecutionId) => Effect.Effect<RoutineCancelResult, RoutineError>;
    readonly subscribeExecutions: (
      projectId: ProjectId,
    ) => Stream.Stream<RoutineExecutionsResult, RoutineError>;
    readonly subscribeExecution: (
      id: RoutineExecutionId,
    ) => Stream.Stream<RoutineExecutionResult, RoutineError>;
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
  const stepEnv = yield* Effect.context<RoutineStepRequirements>();
  // Subscribers only need the newest dirty signal; each one re-reads full state.
  const changesPubSub = yield* PubSub.sliding<void>(1);

  const runningFibers = new Map<RoutineExecutionId, Fiber.Fiber<void>>();

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
        workspaceStrategy,
        modelSelection,
      };

      let current: RoutineStepId | undefined = definition.start ?? definition.steps[0]?.id;
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

        const startedAt = yield* nowIso;
        const running: ExecutionStepRecord = {
          executionId: initial.id,
          stepId: step.id,
          attempt: 1,
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
        current = nextSteps(definition, step.id, result.verdict.label)[0];
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

  const start: Executor["Service"]["start"] = Effect.fn("Executor.start")(function* (input) {
    const project = yield* projectService
      .getById(input.projectId)
      .pipe(
        Effect.mapError(
          (cause) => new RoutineError({ message: "Failed to resolve project for routine.", cause }),
        ),
      );
    if (Option.isNone(project)) {
      return yield* new RoutineError({ message: `Project ${input.projectId} not found.` });
    }
    const workspaceRoot = project.value.workspaceRoot;

    const summaries = yield* RoutineStore.list({ workspaceRoot, projectId: input.projectId }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new RoutineError({ message: "Failed to read routines.", cause })),
    );

    const summary = summaries.find((candidate) => candidate.id === input.routineId);
    if (summary === undefined || summary.definition === null || summary.hash === null) {
      return yield* new RoutineError({
        message: `Routine "${input.routineId}" was not found or could not be parsed.`,
        routineId: input.routineId,
      });
    }
    if (summary.issues.length > 0) {
      return yield* new RoutineError({
        message: `Routine "${input.routineId}" has ${summary.issues.length} validation issue(s).`,
        routineId: input.routineId,
      });
    }

    const needsModel = summary.definition.steps.some(
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
    const createdAt = yield* nowIso;
    const execution: RoutineExecution = {
      id: RoutineExecutionId.make(`routine-execution:${unique}`),
      projectId: input.projectId,
      routineId: input.routineId,
      routineHash: summary.hash,
      definition: summary.definition,
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
    return { execution: execution.value, steps };
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

  return Executor.of({ start, cancel, subscribeExecutions, subscribeExecution });
});

export const layer = Layer.effect(Executor, make);
