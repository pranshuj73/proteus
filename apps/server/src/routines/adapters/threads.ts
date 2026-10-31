import {
  CommandId,
  MessageId,
  type ModelSelection,
  type ProjectId,
  type OrchestrationV2UserInputQuestion,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type ProviderInstanceId,
  type RoutineCouncilConfig,
  RoutineError,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { RoutineStepError } from "../steps/StepRunner.ts";

/** Every step of an execution shares the one worktree provisioned at start. */
export interface RoutineWorkspaceStrategy {
  readonly type: "existing_worktree";
  readonly worktreePath: string;
  readonly branch: string;
}

/** A user-input request a step thread is blocked on. */
export interface RoutineThreadQuestion {
  readonly requestId: string;
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
}

interface RoutineAgentStepInput {
  readonly projectId: ProjectId;
  readonly workspaceStrategy: RoutineWorkspaceStrategy;
  readonly prompt: string;
  readonly modelSelection?: ModelSelection | undefined;
  readonly title: string;
  readonly timeoutMs?: number | undefined;
  /** Runs once the thread exists, so a cancel can stop it before the step finishes. */
  /** Defaults to full access; the council runs without it. */
  readonly runtimeMode?: RuntimeMode | undefined;
  /** Answers a pending user-input request; failing it stops the thread and the step. */
  readonly onQuestion?:
    | ((
        threadId: ThreadId,
        question: RoutineThreadQuestion,
      ) => Effect.Effect<ProviderUserInputAnswers, RoutineStepError>)
    | undefined;
  /** Declines every approval request the thread raises instead of waiting on a human. */
  readonly declineApprovals?: boolean | undefined;
  readonly onLaunched?: ((threadId: ThreadId) => Effect.Effect<void>) | undefined;
}

interface RoutineAgentStepResult {
  readonly threadId: ThreadId;
  readonly verdictText: string;
}

/** Council model and whether it differs from the step author's model. */
export interface RoutineCouncilModel {
  readonly selection: ModelSelection;
  readonly independent: boolean;
}

const isRoutineError = Schema.is(RoutineError);
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

/** Confines every orchestration-v2 launch/await dependency behind one routine-facing seam. */
export class RoutineThreadRunner extends Context.Service<
  RoutineThreadRunner,
  {
    readonly runAgentStep: (
      input: RoutineAgentStepInput,
    ) => Effect.Effect<RoutineAgentStepResult, RoutineStepError>;
    readonly stopThread: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<void, RoutineStepError>;
    readonly resolveDefaultModel: (
      projectId: ProjectId,
    ) => Effect.Effect<ModelSelection, RoutineError>;
    /** Config wins; otherwise any available model other than the author's, else the author's. */
    readonly resolveCouncilModel: (input: {
      readonly author: ModelSelection;
      readonly config: RoutineCouncilConfig | undefined;
    }) => Effect.Effect<RoutineCouncilModel>;
  }
>()("t3/routines/adapters/threads/RoutineThreadRunner") {}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const projects = yield* ProjectService.ProjectService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  // launchThread resolves its launch/attachment services from context; the step runs in a forked walk.
  const launchContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof ThreadMessageIntake.launchThread>>>();

  const respond = Effect.fn("RoutineThreadRunner.respond")(function* (
    threadId: ThreadId,
    requestId: string,
    response: { readonly answers: ProviderUserInputAnswers } | { readonly decision: "decline" },
  ) {
    const unique = yield* crypto
      .randomUUIDv4()
      .pipe(
        Effect.mapError(
          (cause) => new RoutineStepError({ message: "Failed to create a command id.", cause }),
        ),
      );
    yield* threadManagement
      .dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make(`routine-respond:${unique}`),
        threadId,
        requestId: RuntimeRequestId.make(requestId),
        ...response,
      })
      .pipe(
        Effect.mapError(
          (cause) => new RoutineStepError({ message: "Failed to answer a thread request.", cause }),
        ),
      );
  });

  /** Never completes on its own: answers pending requests until the caller interrupts it. */
  const watchRequests = (
    input: RoutineAgentStepInput,
    threadId: ThreadId,
  ): Effect.Effect<never, RoutineStepError> => {
    const handled = new Set<string>();
    const scan = Effect.gen(function* () {
      const projection = yield* threadManagement
        .getThreadProjection(threadId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new RoutineStepError({ message: "Failed to read agent thread requests.", cause }),
          ),
        );
      for (const request of projection.runtimeRequests) {
        if (request.status !== "pending" || handled.has(request.id)) continue;
        if (request.kind === "user_input") {
          const item = projection.turnItems.find(
            (candidate) =>
              candidate.type === "user_input_request" && candidate.requestId === request.id,
          );
          if (input.onQuestion === undefined || item?.type !== "user_input_request") continue;
          handled.add(request.id);
          const answers = yield* input.onQuestion(threadId, {
            requestId: request.id,
            questions: item.questions,
          });
          yield* respond(threadId, request.id, { answers });
        } else if (input.declineApprovals === true && request.kind !== "auth_refresh") {
          handled.add(request.id);
          yield* respond(threadId, request.id, { decision: "decline" });
        }
      }
    });
    return Stream.merge(
      Stream.make(undefined),
      threadManagement.streamDomainEvents.pipe(
        Stream.filter(
          (event) => event.threadId === threadId && event.type === "runtime-request.updated",
        ),
        Stream.map(() => undefined),
        Stream.mapError(
          (cause) =>
            new RoutineStepError({ message: "Failed to watch agent thread requests.", cause }),
        ),
      ),
    ).pipe(
      Stream.mapEffect(() => scan),
      Stream.runDrain,
      Effect.andThen(Effect.never),
    );
  };

  const runAgentStep: RoutineThreadRunner["Service"]["runAgentStep"] = Effect.fn(
    "RoutineThreadRunner.runAgentStep",
  )(function* (input) {
    if (input.modelSelection === undefined) {
      return yield* new RoutineStepError({
        message: "An agent step needs a model selection to launch a thread.",
      });
    }
    const unique = yield* crypto
      .randomUUIDv4()
      .pipe(
        Effect.mapError(
          (cause) => new RoutineStepError({ message: "Failed to create a thread id.", cause }),
        ),
      );
    const commandId = CommandId.make(`routine-run:${unique}`);
    const threadId = ThreadId.make(`routine-run:${unique}`);
    const messageId = MessageId.make(`routine-run:${unique}`);
    const modelSelection = input.modelSelection;

    const launch = yield* ThreadMessageIntake.launchThread({
      commandId,
      threadId,
      projectId: input.projectId,
      title: input.title,
      modelSelection,
      runtimeMode: input.runtimeMode ?? "full-access",
      interactionMode: "default",
      workspaceStrategy: input.workspaceStrategy,
      initialMessage: { messageId, text: input.prompt, attachments: [] },
      createdBy: "agent",
      creationSource: "server",
    }).pipe(
      Effect.provide(launchContext),
      Effect.mapError(
        (cause) =>
          new RoutineStepError({
            message: `Failed to launch agent thread: ${cause.message}`,
            cause,
          }),
      ),
    );

    if (input.onLaunched !== undefined) yield* input.onLaunched(threadId);

    const run =
      launch.projection.runs.find((candidate) => candidate.userMessageId === messageId) ??
      launch.projection.runs.at(-1);

    const waitForRun = threadManagement
      .waitForThread({
        projectId: input.projectId,
        threadId,
        ...(run === undefined ? {} : { runId: run.id }),
        timeoutMs: input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new RoutineStepError({
              message: `Failed to await agent thread: ${cause.message}`,
              cause,
            }),
        ),
      );
    const watching = input.onQuestion !== undefined || input.declineApprovals === true;
    const wait = watching
      ? yield* Effect.raceFirst(waitForRun, watchRequests(input, threadId)).pipe(
          Effect.tapError(() =>
            Effect.ignore(stopThread({ projectId: input.projectId, threadId })),
          ),
        )
      : yield* waitForRun;
    if (wait.timedOut) {
      return yield* new RoutineStepError({
        message: `Agent thread ${threadId} did not finish before the step timeout.`,
      });
    }

    const projection = yield* threadManagement.getThreadProjection(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new RoutineStepError({
            message: `Failed to read agent thread: ${cause.message}`,
            cause,
          }),
      ),
    );
    const lastAssistant = [...projection.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    return { threadId, verdictText: lastAssistant?.text ?? "" };
  });

  const stopThread: RoutineThreadRunner["Service"]["stopThread"] = Effect.fn(
    "RoutineThreadRunner.stopThread",
  )(function* (input) {
    const unique = yield* crypto
      .randomUUIDv4()
      .pipe(
        Effect.mapError(
          (cause) => new RoutineStepError({ message: "Failed to create a command id.", cause }),
        ),
      );
    yield* threadManagement
      .interruptThread({
        projectId: input.projectId,
        threadId: input.threadId,
        commandId: CommandId.make(`routine-stop:${unique}`),
        reason: "Routine execution cancelled",
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new RoutineStepError({
              message: `Failed to stop agent thread: ${cause.message}`,
              cause,
            }),
        ),
      );
  });

  const resolveDefaultModel: RoutineThreadRunner["Service"]["resolveDefaultModel"] = Effect.fn(
    "RoutineThreadRunner.resolveDefaultModel",
  )(
    function* (projectId) {
      const settings = yield* serverSettings.getSettings;
      const project = yield* projects.getById(projectId);
      const defaults = resolveProjectSettings(
        settings,
        projectId,
        Option.getOrUndefined(project),
      ).settings;
      const selection = resolveNewThreadModelSelection({
        defaultSelection: defaults.defaultModelSelection,
        fallbackSelection: defaults.fallbackModelSelection,
        providers: yield* providerRegistry.getProviders,
        settings: defaults,
        projectId,
        now: DateTime.toEpochMillis(yield* DateTime.now),
      }).selection;
      if (selection === null || selection === undefined) {
        return yield* new RoutineError({
          message: "Set a default model for this project to run agent steps.",
        });
      }
      return selection;
    },
    Effect.mapError((cause) =>
      isRoutineError(cause)
        ? cause
        : new RoutineError({ message: "Failed to resolve the default model.", cause }),
    ),
  );

  const resolveCouncilModel: RoutineThreadRunner["Service"]["resolveCouncilModel"] = Effect.fn(
    "RoutineThreadRunner.resolveCouncilModel",
  )(function* ({ author, config }) {
    if (config?.model !== undefined || config?.provider !== undefined) {
      const selection: ModelSelection = {
        instanceId: (config.provider ?? author.instanceId) as ProviderInstanceId,
        model: config.model ?? author.model,
      };
      return {
        selection,
        independent: selection.instanceId !== author.instanceId || selection.model !== author.model,
      };
    }
    const providers = yield* providerRegistry.getProviders.pipe(Effect.orElseSucceed(() => []));
    for (const provider of providers) {
      if (!provider.enabled || !provider.installed || provider.availability === "unavailable") {
        continue;
      }
      const model = provider.models.find(
        (candidate) =>
          !(provider.instanceId === author.instanceId && candidate.slug === author.model),
      );
      if (model !== undefined) {
        return {
          selection: { instanceId: provider.instanceId, model: model.slug },
          independent: true,
        };
      }
    }
    return { selection: author, independent: false };
  });

  return RoutineThreadRunner.of({
    runAgentStep,
    stopThread,
    resolveDefaultModel,
    resolveCouncilModel,
  });
});

export const layer = Layer.effect(RoutineThreadRunner, make);
