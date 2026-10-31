import {
  CommandId,
  MessageId,
  type ModelSelection,
  type ProjectId,
  RoutineError,
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

interface RoutineAgentStepInput {
  readonly projectId: ProjectId;
  readonly workspaceStrategy: RoutineWorkspaceStrategy;
  readonly prompt: string;
  readonly modelSelection?: ModelSelection | undefined;
  readonly title: string;
  readonly timeoutMs?: number | undefined;
}

interface RoutineAgentStepResult {
  readonly threadId: ThreadId;
  readonly verdictText: string;
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
    readonly resolveDefaultModel: (
      projectId: ProjectId,
    ) => Effect.Effect<ModelSelection, RoutineError>;
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
      runtimeMode: "full-access",
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

    const run =
      launch.projection.runs.find((candidate) => candidate.userMessageId === messageId) ??
      launch.projection.runs.at(-1);

    const wait = yield* threadManagement
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

  return RoutineThreadRunner.of({ runAgentStep, resolveDefaultModel });
});

export const layer = Layer.effect(RoutineThreadRunner, make);
