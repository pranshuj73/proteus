import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../../processRunner.ts";
import { RoutineStepError } from "../steps/StepRunner.ts";

interface RoutineProcessRunInput {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes: number;
}

interface RoutineProcessRunOutput {
  readonly code: number | null;
  readonly output: string;
  readonly timedOut: boolean;
}

/** Narrow seam over the shared ProcessRunner so step runners never touch spawn plumbing. */
export class RoutineProcessRunner extends Context.Service<
  RoutineProcessRunner,
  {
    readonly run: (
      input: RoutineProcessRunInput,
    ) => Effect.Effect<RoutineProcessRunOutput, RoutineStepError>;
  }
>()("t3/routines/adapters/process/RoutineProcessRunner") {}

/** Keeps the combined output to the last `maxBytes` so a step excerpt never unbounds. */
const tailBytes = (text: string, maxBytes: number): string => {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return text;
  return new TextDecoder().decode(encoded.slice(encoded.length - maxBytes));
};

const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const run: RoutineProcessRunner["Service"]["run"] = (input) =>
    processRunner
      .run({
        command: input.argv[0] ?? "",
        args: input.argv.slice(1),
        cwd: input.cwd,
        maxOutputBytes: input.maxOutputBytes,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
        ...(input.timeoutMs === undefined ? {} : { timeout: Duration.millis(input.timeoutMs) }),
      })
      .pipe(
        Effect.map((result): RoutineProcessRunOutput => {
          const combined =
            result.stdout.length > 0 && result.stderr.length > 0
              ? `${result.stdout}\n${result.stderr}`
              : `${result.stdout}${result.stderr}`;
          return {
            code: result.code,
            output: tailBytes(combined, input.maxOutputBytes),
            timedOut: result.timedOut,
          };
        }),
        Effect.mapError(
          (cause) =>
            new RoutineStepError({ message: `Command failed to run: ${cause.message}`, cause }),
        ),
      );

  return RoutineProcessRunner.of({ run });
});

export const layer = Layer.effect(RoutineProcessRunner, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
