import { type RoutineListInput, type RoutineListResult, RoutineError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectService from "../project/ProjectService.ts";
import * as RoutineStore from "./RoutineStore.ts";

export class RoutineService extends Context.Service<
  RoutineService,
  {
    readonly list: (input: RoutineListInput) => Effect.Effect<RoutineListResult, RoutineError>;
  }
>()("t3/routines/RoutineService") {}

const make = Effect.gen(function* () {
  const projectService = yield* ProjectService.ProjectService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const list: RoutineService["Service"]["list"] = Effect.fn("RoutineService.list")(
    function* (input) {
      const project = yield* projectService
        .getById(input.projectId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new RoutineError({ message: "Failed to resolve project for routines.", cause }),
          ),
        );
      if (Option.isNone(project)) {
        return yield* new RoutineError({ message: `Project ${input.projectId} not found.` });
      }
      const routines = yield* RoutineStore.list({
        workspaceRoot: project.value.workspaceRoot,
        projectId: input.projectId,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) => new RoutineError({ message: "Failed to read routines.", cause }),
        ),
      );
      return { routines };
    },
  );

  return RoutineService.of({ list });
});

export const layer = Layer.effect(RoutineService, make);
