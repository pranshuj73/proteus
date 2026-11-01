import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RoutineExecutionId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

const KEBAB_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const RoutineKebabId = Schema.String.check(Schema.isPattern(KEBAB_PATTERN), Schema.isMaxLength(64));

export const RoutineStepId = RoutineKebabId.pipe(Schema.brand("RoutineStepId"));
export type RoutineStepId = typeof RoutineStepId.Type;

/** A routine's id is the JSON file basename, so it carries the same kebab shape as a step id. */
export const RoutineId = RoutineKebabId.pipe(Schema.brand("RoutineId"));
export type RoutineId = typeof RoutineId.Type;

/** A verdict label resolves to the next step, or `$end` to finish the execution. */
const RoutineStepTarget = Schema.Union([RoutineStepId, Schema.Literal("$end")]);

/** Verdict labels share the kebab shape of step ids but are not branded. */
const RoutineVerdictLabel = RoutineKebabId;

export const RoutineVerdictSpec = Schema.Struct({
  labels: Schema.Array(RoutineVerdictLabel).check(Schema.isMinLength(1)),
});
export type RoutineVerdictSpec = typeof RoutineVerdictSpec.Type;

const routineStepBaseFields = {
  id: RoutineStepId,
  title: Schema.optional(Schema.String),
  /** Earlier steps whose outputs are passed into this step as untrusted evidence. */
  inputs: Schema.optional(Schema.Array(RoutineStepId)),
  /** Unconditional successors; mutually exclusive with `on`. */
  next: Schema.optional(Schema.Array(RoutineStepId)),
  /** Gate: verdict label to its next step. */
  on: Schema.optional(Schema.Record(Schema.String, RoutineStepTarget)),
  onError: Schema.optional(RoutineStepId),
  /** This step waits for all of these steps to finish successfully. */
  join: Schema.optional(Schema.Array(RoutineStepId)),
  /** Declares the step never edits files, so parallel branches may share the execution worktree. */
  readOnly: Schema.optional(Schema.Boolean),
  maxIterations: Schema.optional(PositiveInt),
  timeoutMs: Schema.optional(PositiveInt),
  retries: Schema.optional(NonNegativeInt),
};

export const RoutineSkillStep = Schema.Struct({
  ...routineStepBaseFields,
  kind: Schema.Literal("skill"),
  skill: TrimmedNonEmptyString,
  prompt: Schema.optional(Schema.String),
  verdict: RoutineVerdictSpec,
});
export type RoutineSkillStep = typeof RoutineSkillStep.Type;

export const RoutineAgentStep = Schema.Struct({
  ...routineStepBaseFields,
  kind: Schema.Literal("agent"),
  purpose: TrimmedNonEmptyString,
  verdict: RoutineVerdictSpec,
});
export type RoutineAgentStep = typeof RoutineAgentStep.Type;

export const RoutineCommandStep = Schema.Struct({
  ...routineStepBaseFields,
  kind: Schema.Literal("command"),
  argv: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  cwd: Schema.optional(Schema.String),
  passExitCodes: Schema.optional(Schema.Array(Schema.Int)),
  maxOutputBytes: Schema.optional(PositiveInt),
});
export type RoutineCommandStep = typeof RoutineCommandStep.Type;

export const RoutineActionStep = Schema.Struct({
  ...routineStepBaseFields,
  kind: Schema.Literal("action"),
  action: Schema.Literals(["git.push", "pr.create"]),
  draft: Schema.optional(Schema.Boolean),
});
export type RoutineActionStep = typeof RoutineActionStep.Type;

export const RoutineStep = Schema.Union([
  RoutineSkillStep,
  RoutineAgentStep,
  RoutineCommandStep,
  RoutineActionStep,
]);
export type RoutineStep = typeof RoutineStep.Type;

export const RoutineCouncilConfig = Schema.Struct({
  provider: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  /** Questions answered per step before the step stops; defaults to 5. */
  maxQuestionsPerStep: Schema.optional(PositiveInt),
  /** Context size at which the council thread stops and a retry starts a fresh one; defaults to 200000. */
  maxTokens: Schema.optional(PositiveInt),
});
export type RoutineCouncilConfig = typeof RoutineCouncilConfig.Type;

export const RoutineDefinition = Schema.Struct({
  version: Schema.Literal(1),
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  council: Schema.optional(RoutineCouncilConfig),
  /** Entry step id; defaults to the first declared step. */
  start: Schema.optional(RoutineStepId),
  steps: Schema.Array(RoutineStep).check(Schema.isMinLength(1)),
});
export type RoutineDefinition = typeof RoutineDefinition.Type;

/** Distinct executables a routine's command steps run. */
export const routineExecutables = (definition: RoutineDefinition): ReadonlyArray<string> => [
  ...new Set(
    definition.steps.flatMap((step) => (step.kind === "command" ? [step.argv[0] ?? ""] : [])),
  ),
];

/** The verdict labels a step can produce: declared for skill/agent, implicit for command/action. */
export const routineStepVerdictLabels = (step: RoutineStep): ReadonlyArray<string> => {
  switch (step.kind) {
    case "command":
      return ["pass", "fail"];
    case "action":
      return ["created", "failed"];
    case "skill":
    case "agent":
      return step.verdict.labels;
  }
};

export const RoutineValidationIssue = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  /** Location of the issue, such as `steps[2].on.approved`. */
  path: Schema.String,
  stepId: Schema.optional(RoutineStepId),
});
export type RoutineValidationIssue = typeof RoutineValidationIssue.Type;

export const RoutineSummary = Schema.Struct({
  id: RoutineId,
  projectId: ProjectId,
  /** Relative to the project root: `.proteus/routines/<id>.json`. */
  path: Schema.String,
  /** sha256 hex of the canonical text; null when the file is unparsable. */
  hash: Schema.NullOr(Schema.String),
  /** Decoded definition; null when JSON or schema decoding failed. */
  definition: Schema.NullOr(RoutineDefinition),
  /** Empty means the routine is valid. */
  issues: Schema.Array(RoutineValidationIssue),
  /** True when the current hash has been approved to run. */
  approved: Schema.Boolean,
  /** The definition last approved, kept so an edit can be diffed against it; null before any approval. */
  approvedDefinition: Schema.optional(Schema.NullOr(RoutineDefinition)),
  /** Executables this routine runs that the project allowlist does not include. */
  missingExecutables: Schema.Array(Schema.String),
});
export type RoutineSummary = typeof RoutineSummary.Type;

export const RoutineListInput = Schema.Struct({
  projectId: ProjectId,
});
export type RoutineListInput = typeof RoutineListInput.Type;

export const RoutineListResult = Schema.Struct({
  routines: ForwardCompatibleArray(RoutineSummary),
  /** Executables approved for this project's routines. */
  allowlist: Schema.Array(Schema.String),
});
export type RoutineListResult = typeof RoutineListResult.Type;

export class RoutineError extends Schema.TaggedError<RoutineError>()("RoutineError", {
  message: Schema.String,
  routineId: Schema.optional(RoutineId),
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Lean execution lifecycle: no approval gate, no retries. */
export const RoutineExecutionStatus = Schema.Literals([
  "running",
  "paused",
  "interrupted",
  "needs_attention",
  "failed",
  "awaiting_review",
  "completed",
  "cancelled",
]);
export type RoutineExecutionStatus = typeof RoutineExecutionStatus.Type;

export const RoutineStepRunStatus = Schema.Literals(["pending", "running", "done", "failed"]);
export type RoutineStepRunStatus = typeof RoutineStepRunStatus.Type;

export const RoutineVerdict = Schema.Struct({
  label: Schema.String,
  reason: Schema.String,
});
export type RoutineVerdict = typeof RoutineVerdict.Type;

export const RoutineExecutionStep = Schema.Struct({
  stepId: RoutineStepId,
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  status: RoutineStepRunStatus,
  verdict: Schema.NullOr(RoutineVerdict),
  outputExcerpt: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  error: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type RoutineExecutionStep = typeof RoutineExecutionStep.Type;

export const RoutineCouncilConfidence = Schema.Literals(["high", "medium", "low"]);
export type RoutineCouncilConfidence = typeof RoutineCouncilConfidence.Type;

/** One question the council answered on the user's behalf. */
export const RoutineCouncilRecord = Schema.Struct({
  id: Schema.String,
  executionId: RoutineExecutionId,
  stepId: RoutineStepId,
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** The step thread that asked. */
  threadId: ThreadId,
  /** The runtime request the council answered. */
  requestId: Schema.String,
  question: Schema.String,
  answer: Schema.String,
  rationale: Schema.String,
  confidence: RoutineCouncilConfidence,
  /** False when the council ran on the same model as the step author. */
  independent: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type RoutineCouncilRecord = typeof RoutineCouncilRecord.Type;

/** A record the feed surfaces without opening the full list; text is truncated. */
export const RoutineCouncilHighlight = Schema.Struct({
  recordId: Schema.String,
  question: Schema.String,
  answer: Schema.String,
  confidence: RoutineCouncilConfidence,
});
export type RoutineCouncilHighlight = typeof RoutineCouncilHighlight.Type;

/** One block of the sidebar feed. Steps that have not started have no block. */
export const RoutineFeedBlock = Schema.Struct({
  stepId: RoutineStepId,
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  stepStatus: RoutineStepRunStatus,
  verdict: Schema.NullOr(RoutineVerdict),
  /** Cached summary of the critical council decisions; null until generated. */
  summary: Schema.NullOr(Schema.String),
  recordCount: NonNegativeInt,
  /** Low-confidence answers, always shown. */
  flagged: Schema.Array(RoutineCouncilHighlight),
});
export type RoutineFeedBlock = typeof RoutineFeedBlock.Type;

export const RoutineExecution = Schema.Struct({
  id: RoutineExecutionId,
  projectId: ProjectId,
  routineId: RoutineId,
  routineHash: Schema.String,
  definition: RoutineDefinition,
  brief: Schema.String,
  status: RoutineExecutionStatus,
  worktreePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type RoutineExecution = typeof RoutineExecution.Type;

export const RoutineSkillScope = Schema.Literals(["project", "global"]);
export type RoutineSkillScope = typeof RoutineSkillScope.Type;

export const RoutineStartInput = Schema.Struct({
  projectId: ProjectId,
  routineId: RoutineId,
  brief: Schema.String,
  modelSelection: Schema.optional(ModelSelection),
  /** Where preflight installs missing skills; defaults to project. */
  skillScope: Schema.optional(RoutineSkillScope),
});
export type RoutineStartInput = typeof RoutineStartInput.Type;

export const RoutineStartResult = Schema.Struct({
  execution: RoutineExecution,
});
export type RoutineStartResult = typeof RoutineStartResult.Type;

export const RoutineApproveInput = Schema.Struct({
  projectId: ProjectId,
  routineId: RoutineId,
  /** Executables to add to the project allowlist with this approval. */
  allowExecutables: Schema.optional(Schema.Array(Schema.String)),
});
export type RoutineApproveInput = typeof RoutineApproveInput.Type;

export const RoutineApproveResult = Schema.Struct({
  routineId: RoutineId,
  approvedHash: Schema.String,
});
export type RoutineApproveResult = typeof RoutineApproveResult.Type;

export const RoutineRevokeInput = Schema.Struct({
  projectId: ProjectId,
  routineId: RoutineId,
});
export type RoutineRevokeInput = typeof RoutineRevokeInput.Type;

export const RoutineUpdateSkillsInput = RoutineRevokeInput;
export type RoutineUpdateSkillsInput = typeof RoutineUpdateSkillsInput.Type;

export const RoutineRemoveExecutableInput = Schema.Struct({
  projectId: ProjectId,
  executable: Schema.String,
});
export type RoutineRemoveExecutableInput = typeof RoutineRemoveExecutableInput.Type;

export const RoutineCancelInput = Schema.Struct({
  executionId: RoutineExecutionId,
});
export type RoutineCancelInput = typeof RoutineCancelInput.Type;

export const RoutineCancelResult = Schema.Struct({
  execution: RoutineExecution,
});
export type RoutineCancelResult = typeof RoutineCancelResult.Type;

export const RoutineControlInput = Schema.Union([
  Schema.Struct({
    executionId: RoutineExecutionId,
    action: Schema.Literals(["pause", "resume", "retry"]),
  }),
  Schema.Struct({
    executionId: RoutineExecutionId,
    action: Schema.Literal("restart"),
    stepId: RoutineStepId,
  }),
  Schema.Struct({
    executionId: RoutineExecutionId,
    action: Schema.Literal("skip"),
    stepId: RoutineStepId,
    label: Schema.String,
    reason: Schema.String,
  }),
]);
export type RoutineControlInput = typeof RoutineControlInput.Type;

export const RoutineAttentionResult = Schema.Struct({
  /** Executions across all projects that are waiting on a person. */
  count: NonNegativeInt,
});
export type RoutineAttentionResult = typeof RoutineAttentionResult.Type;

export const RoutineCompleteInput = Schema.Struct({
  executionId: RoutineExecutionId,
  /** Deletes the worktree even with uncommitted changes or unpushed commits. */
  discardWork: Schema.optional(Schema.Boolean),
});
export type RoutineCompleteInput = typeof RoutineCompleteInput.Type;

export const RoutineCompleteResult = Schema.Struct({
  execution: RoutineExecution,
});
export type RoutineCompleteResult = typeof RoutineCompleteResult.Type;

export const RoutineExecutionsInput = Schema.Struct({
  projectId: ProjectId,
});
export type RoutineExecutionsInput = typeof RoutineExecutionsInput.Type;

export const RoutineExecutionsResult = Schema.Struct({
  executions: ForwardCompatibleArray(RoutineExecution),
});
export type RoutineExecutionsResult = typeof RoutineExecutionsResult.Type;

export const RoutineExecutionInput = Schema.Struct({
  executionId: RoutineExecutionId,
});
export type RoutineExecutionInput = typeof RoutineExecutionInput.Type;

export const RoutineExecutionResult = Schema.Struct({
  execution: RoutineExecution,
  steps: ForwardCompatibleArray(RoutineExecutionStep),
  feed: ForwardCompatibleArray(RoutineFeedBlock),
});
export type RoutineExecutionResult = typeof RoutineExecutionResult.Type;

export const RoutineCouncilRecordsInput = Schema.Struct({
  executionId: RoutineExecutionId,
  stepId: RoutineStepId,
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type RoutineCouncilRecordsInput = typeof RoutineCouncilRecordsInput.Type;

export const RoutineCouncilRecordsResult = Schema.Struct({
  records: ForwardCompatibleArray(RoutineCouncilRecord),
});
export type RoutineCouncilRecordsResult = typeof RoutineCouncilRecordsResult.Type;

export const RoutineRegenerateSummaryInput = RoutineCouncilRecordsInput;
export type RoutineRegenerateSummaryInput = typeof RoutineRegenerateSummaryInput.Type;

export const RoutineRegenerateSummaryResult = Schema.Struct({
  summary: Schema.NullOr(Schema.String),
});
export type RoutineRegenerateSummaryResult = typeof RoutineRegenerateSummaryResult.Type;

/**
 * Model-facing guidance for drafting a routine from a user's use case. Shared by
 * the server author-instructions module and the web "New routine" launcher so both
 * seed the same text.
 */
/** Starts the authoring flow from the New routine button or `/routine`. */
export const routineNewPrompt = (): string =>
  `${ROUTINE_AUTHOR_INSTRUCTIONS}

---
Describe the use case you want this routine to automate, then I will draft, validate, and save it:
`;

/** Opens the authoring flow on an existing routine; saving it requires a new approval. */
export const routineEditPrompt = (path: string): string =>
  `${ROUTINE_AUTHOR_INSTRUCTIONS}

---
Edit the existing routine at ${path}. Read it first, keep its routineId, and save over it. Saving invalidates its approval, so it must be approved again. Here is what I want changed:
`;

const ROUTINE_AUTHOR_INSTRUCTIONS = `You are drafting a **routine**: a reusable, multi-step workflow stored as JSON at \`.proteus/routines/<routine-id>.json\`. Design one from the user's described use case, then save it with the MCP tools.

Routine JSON shape:
  version: always the number 1.
  name: short human title (required, non-empty).
  description: optional one-line summary.
  start: optional step id to begin at (defaults to the first step).
  steps: non-empty array of steps. Every id is kebab-case (^[a-z0-9]+(?:-[a-z0-9]+)*$, <= 64 chars) and unique.

Each step has an id, optional title, a kind, and transitions:
  kind "command": run a shell command. Fields: argv (non-empty string array), optional cwd (relative to the worktree), passExitCodes (default [0]). Implicit verdict labels: pass | fail.
  kind "agent": delegate to an agent. Fields: purpose (what to do), verdict: { labels: [...] } (your own kebab-case outcome labels, at least one).
  kind "skill": run a named skill. Fields: skill ("name" or "source@name"), optional prompt, verdict: { labels: [...] }.
  kind "action": a built-in action. Fields: action ("git.push" or "pr.create"), optional draft. Implicit verdict labels: created | failed.

Transitions (a step with neither is terminal):
  next: array of step ids to run unconditionally after this step. Never set next and on on the same step.
  on: map from a verdict label to the next step id, or to "$end" to finish the execution. Cover every verdict label the step can produce.
  inputs: ids of earlier steps whose output is passed to this step as evidence.
  maxIterations: required on a step that any transition loops back to, whether that transition is in next or on.
  join: ids of steps this step waits for. A next with several ids fans out in parallel; the step that lists them in join runs once all succeeded.
  readOnly: true marks a step that never edits files. Parallel steps without it each get their own worktree, merged back afterwards (a merge conflict fails the execution).

Workflow:
  1. Draft the routine JSON from the user's use case. Prefer a simple linear next chain unless they need branching.
  2. Call t3_routine_validate with { projectId, definition }. Fix every reported issue and re-validate. Make at most 3 repair passes.
  3. Once validation returns no issues, call t3_routine_save with { projectId, routineId, definition } (routineId is the kebab-case file name). It writes the file and returns its path. If it still has issues after three repair attempts, call t3_routine_save with saveInvalid: true and tell the user what remains.
  4. To edit an existing routine, read its file, change it, validate, and save with the same routineId. The edit needs re-approval, and the approval screen shows what changed.
  5. Tell the user the routine is saved and where, or report the remaining issues if you could not resolve them.`;
