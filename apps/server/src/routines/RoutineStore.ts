// @effect-diagnostics nodeBuiltinImport:off - canonical hashing is a synchronous digest.
import * as NodeCrypto from "node:crypto";

import {
  type ProjectId,
  type RoutineCouncilConfig,
  RoutineDefinition,
  RoutineId,
  type RoutineStep,
  type RoutineSummary,
  type RoutineValidationIssue,
  routineStepVerdictLabels,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { validateRoutine } from "./RoutineValidator.ts";

const ROUTINES_DIR_SEGMENTS = [".proteus", "routines"] as const;

const STEP_KEY_ORDER = [
  "id",
  "title",
  "kind",
  "skill",
  "prompt",
  "purpose",
  "argv",
  "cwd",
  "passExitCodes",
  "maxOutputBytes",
  "action",
  "draft",
  "verdict",
  "inputs",
  "next",
  "on",
  "onError",
  "join",
  "maxIterations",
  "timeoutMs",
  "retries",
] as const;

const decodeRoutineDefinition = Schema.decodeUnknownResult(RoutineDefinition);
const decodeRoutineId = Schema.decodeUnknownResult(RoutineId);

function orderedCouncil(council: RoutineCouncilConfig): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  if (council.provider !== undefined) ordered.provider = council.provider;
  if (council.model !== undefined) ordered.model = council.model;
  return ordered;
}

function orderedOn(step: RoutineStep, on: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const label of routineStepVerdictLabels(step)) {
    if (label in on) ordered[label] = on[label];
  }
  for (const key of Object.keys(on)) {
    if (!(key in ordered)) ordered[key] = on[key];
  }
  return ordered;
}

function orderedStep(step: RoutineStep): Record<string, unknown> {
  // Reorder a validated step's own keys; dynamic indexing needs a record view.
  const record = step as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of STEP_KEY_ORDER) {
    if (key === "on") {
      if (step.on !== undefined) ordered.on = orderedOn(step, step.on);
      continue;
    }
    const value = record[key];
    if (value === undefined) continue;
    ordered[key] = value;
  }
  return ordered;
}

function orderedDefinition(def: RoutineDefinition): Record<string, unknown> {
  const ordered: Record<string, unknown> = { version: def.version, name: def.name };
  if (def.description !== undefined) ordered.description = def.description;
  if (def.council !== undefined) ordered.council = orderedCouncil(def.council);
  if (def.start !== undefined) ordered.start = def.start;
  ordered.steps = def.steps.map(orderedStep);
  return ordered;
}

export const canonicalRoutineText = (def: RoutineDefinition): string =>
  `${JSON.stringify(orderedDefinition(def), null, 2)}\n`;

export const routineHash = (canonicalText: string): string =>
  NodeCrypto.createHash("sha256").update(canonicalText).digest("hex");

function summarizeFile(input: {
  readonly projectId: ProjectId;
  readonly fileName: string;
  readonly text: string;
}): RoutineSummary {
  const basename = input.fileName.replace(/\.json$/, "");
  const relativePath = `${ROUTINES_DIR_SEGMENTS.join("/")}/${input.fileName}`;
  const issues: RoutineValidationIssue[] = [];

  const idResult = decodeRoutineId(basename);
  if (Result.isFailure(idResult)) {
    issues.push({
      code: "invalid-routine-id",
      message: idResult.failure.message,
      path: relativePath,
    });
  }
  const id = (Result.isSuccess(idResult) ? idResult.success : basename) as RoutineId;

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.text);
  } catch (error) {
    issues.push({
      code: "invalid-json",
      message: error instanceof Error ? error.message : String(error),
      path: relativePath,
    });
    return {
      id,
      projectId: input.projectId,
      path: relativePath,
      hash: null,
      definition: null,
      issues,
    };
  }

  const decoded = decodeRoutineDefinition(parsed);
  if (Result.isFailure(decoded)) {
    issues.push({ code: "schema", message: decoded.failure.message, path: relativePath });
    return {
      id,
      projectId: input.projectId,
      path: relativePath,
      hash: null,
      definition: null,
      issues,
    };
  }

  const definition = decoded.success;
  issues.push(...validateRoutine(definition));
  return {
    id,
    projectId: input.projectId,
    path: relativePath,
    hash: routineHash(canonicalRoutineText(definition)),
    definition,
    issues,
  };
}

export const list = Effect.fn("RoutineStore.list")(function* (input: {
  readonly workspaceRoot: string;
  readonly projectId: ProjectId;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(input.workspaceRoot, ...ROUTINES_DIR_SEGMENTS);
  const entries = yield* fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
  const summaries: RoutineSummary[] = [];
  for (const fileName of entries) {
    if (!fileName.endsWith(".json")) continue;
    const text = yield* fileSystem.readFileString(path.join(directory, fileName));
    summaries.push(summarizeFile({ projectId: input.projectId, fileName, text }));
  }
  return summaries.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
});

export const writeCanonical = Effect.fn("RoutineStore.writeCanonical")(function* (input: {
  readonly workspaceRoot: string;
  readonly definition: RoutineDefinition;
  readonly id: RoutineId;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(input.workspaceRoot, ...ROUTINES_DIR_SEGMENTS);
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(directory, `${input.id}.json`),
    canonicalRoutineText(input.definition),
  );
});
