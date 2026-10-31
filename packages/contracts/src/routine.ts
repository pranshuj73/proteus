import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

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
});
export type RoutineSummary = typeof RoutineSummary.Type;

export const RoutineListInput = Schema.Struct({
  projectId: ProjectId,
});
export type RoutineListInput = typeof RoutineListInput.Type;

export const RoutineListResult = Schema.Struct({
  routines: ForwardCompatibleArray(RoutineSummary),
});
export type RoutineListResult = typeof RoutineListResult.Type;

export class RoutineError extends Schema.TaggedError<RoutineError>()("RoutineError", {
  message: Schema.String,
  routineId: Schema.optional(RoutineId),
  cause: Schema.optional(Schema.Defect()),
}) {}
