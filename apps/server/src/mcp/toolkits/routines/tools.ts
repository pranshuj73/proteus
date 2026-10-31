import {
  OrchestratorMcpFailure,
  ProjectId,
  RoutineDefinition,
  RoutineId,
  RoutineValidationIssue,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as RoutineAuthoring from "../../../routines/RoutineAuthoring.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    RoutineAuthoring.RoutineAuthoring,
    ThreadManagementService.ThreadManagementService,
  ],
};

const RoutineValidateTool = Tool.make("t3_routine_validate", {
  ...shared,
  description:
    "Validate a routine definition. Returns structural issues (empty means valid) and the canonical JSON text. Call repeatedly while fixing issues before saving.",
  parameters: Schema.Struct({
    projectId: ProjectId,
    definition: RoutineDefinition,
  }),
  success: Schema.Struct({
    issues: Schema.Array(RoutineValidationIssue),
    canonicalText: Schema.String,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const RoutineSaveTool = Tool.make("t3_routine_save", {
  ...shared,
  description:
    "Save a routine to .proteus/routines/<routineId>.json after it validates with no issues. Returns the written path, or the remaining issues when it does not validate.",
  parameters: Schema.Struct({
    projectId: ProjectId,
    routineId: RoutineId,
    definition: RoutineDefinition,
  }),
  success: Schema.Union([
    Schema.Struct({ saved: Schema.Literal(true), path: Schema.String }),
    Schema.Struct({ saved: Schema.Literal(false), issues: Schema.Array(RoutineValidationIssue) }),
  ]),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true);

const RoutineSkillsTool = Tool.make("t3_routine_skills", {
  ...shared,
  description:
    "List skills installed in the project (.agents/skills) so a routine can reference them. Pass query to also search the skills registry via `npx skills find`. Propose skills to the user before referencing them as source@name; nothing is installed or pinned while authoring.",
  parameters: Schema.Struct({
    projectId: ProjectId,
    query: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    installed: Schema.Array(
      Schema.Struct({ name: Schema.String, description: Schema.String, path: Schema.String }),
    ),
    found: Schema.NullOr(Schema.String),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const RoutinesToolkit = Toolkit.make(
  RoutineValidateTool,
  RoutineSaveTool,
  RoutineSkillsTool,
);
