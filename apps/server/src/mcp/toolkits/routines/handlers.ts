import { OrchestratorMcpFailure, type RoutineError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as RoutineAuthoring from "../../../routines/RoutineAuthoring.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { RoutinesToolkit } from "./tools.ts";

const routineFailure = (error: RoutineError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const handlers = {
  t3_routine_validate: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const authoring = yield* RoutineAuthoring.RoutineAuthoring;
      return yield* authoring.validateDefinition(input).pipe(Effect.mapError(routineFailure));
    }),
  ),
  t3_routine_skills: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const authoring = yield* RoutineAuthoring.RoutineAuthoring;
      return yield* authoring.listSkills(input).pipe(Effect.mapError(routineFailure));
    }),
  ),
  t3_routine_save: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const authoring = yield* RoutineAuthoring.RoutineAuthoring;
      return yield* authoring.saveDefinition(input).pipe(Effect.mapError(routineFailure));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof RoutinesToolkit.tools>;

export const layer = McpToolAccess.toLayer(RoutinesToolkit, handlers);
