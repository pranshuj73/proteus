import {
  type ProjectId,
  RoutineDefinition,
  RoutineCouncilRecord,
  RoutineError,
  RoutineExecution,
  type RoutineExecutionId,
  RoutineExecutionStep,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const LIST_LIMIT = 50;

interface ExecutionRow {
  readonly execution_id: string;
  readonly project_id: string;
  readonly routine_id: string;
  readonly routine_hash: string;
  readonly definition_json: string;
  readonly brief: string;
  readonly status: string;
  readonly worktree_path: string | null;
  readonly branch: string | null;
  readonly error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly finished_at: string | null;
}

interface StepRow {
  readonly execution_id: string;
  readonly step_id: string;
  readonly attempt: number;
  readonly status: string;
  readonly verdict_label: string | null;
  readonly verdict_reason: string | null;
  readonly output_excerpt: string | null;
  readonly thread_id: string | null;
  readonly error: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
}

export interface ExecutionStepRecord extends RoutineExecutionStep {
  readonly executionId: RoutineExecutionId;
}

export class ExecutionRepository extends Context.Service<
  ExecutionRepository,
  {
    readonly listExecutions: (
      projectId: ProjectId,
    ) => Effect.Effect<RoutineExecution[], RoutineError>;
    readonly getExecution: (
      id: RoutineExecutionId,
    ) => Effect.Effect<Option.Option<RoutineExecution>, RoutineError>;
    readonly listSteps: (
      id: RoutineExecutionId,
    ) => Effect.Effect<RoutineExecutionStep[], RoutineError>;
    readonly insertExecution: (execution: RoutineExecution) => Effect.Effect<void, RoutineError>;
    readonly updateExecution: (execution: RoutineExecution) => Effect.Effect<void, RoutineError>;
    readonly upsertStep: (step: ExecutionStepRecord) => Effect.Effect<void, RoutineError>;
    readonly insertCouncilRecord: (
      record: RoutineCouncilRecord,
    ) => Effect.Effect<void, RoutineError>;
    /** Without `stepId`, every record of the execution, oldest first. */
    readonly listCouncilRecords: (input: {
      readonly executionId: RoutineExecutionId;
      readonly stepId?: string | undefined;
      readonly attempt?: number | undefined;
    }) => Effect.Effect<RoutineCouncilRecord[], RoutineError>;
    readonly upsertSummary: (input: {
      readonly executionId: RoutineExecutionId;
      readonly stepId: string;
      readonly attempt: number;
      readonly summary: string;
      readonly generatedAt: string;
    }) => Effect.Effect<void, RoutineError>;
    /** Keyed `stepId:attempt`. */
    readonly listSummaries: (
      executionId: RoutineExecutionId,
    ) => Effect.Effect<ReadonlyMap<string, string>, RoutineError>;
    readonly listRunning: () => Effect.Effect<RoutineExecution[], RoutineError>;
    readonly listApprovedHashes: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyMap<string, string>, RoutineError>;
    readonly setApproval: (input: {
      readonly projectId: ProjectId;
      readonly routineId: string;
      readonly hash: string;
      readonly approvedAt: string;
    }) => Effect.Effect<void, RoutineError>;
  }
>()("t3/routines/ExecutionRepository") {}

const decodeDefinitionJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeDefinitionJson = Schema.encodeSync(Schema.fromJsonString(RoutineDefinition));
const decodeExecution = Schema.decodeUnknownEffect(RoutineExecution);
const decodeCouncilRecord = Schema.decodeUnknownEffect(RoutineCouncilRecord);
const decodeStep = Schema.decodeUnknownEffect(RoutineExecutionStep);

const repositoryError = (message: string, cause: unknown): RoutineError =>
  new RoutineError({ message, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const toExecution = (row: ExecutionRow) =>
    decodeDefinitionJson(row.definition_json).pipe(
      Effect.flatMap((definition) =>
        decodeExecution({
          id: row.execution_id,
          projectId: row.project_id,
          routineId: row.routine_id,
          routineHash: row.routine_hash,
          definition,
          brief: row.brief,
          status: row.status,
          worktreePath: row.worktree_path,
          branch: row.branch,
          error: row.error,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          finishedAt: row.finished_at,
        }),
      ),
      Effect.mapError((cause) =>
        repositoryError("Could not decode a routine execution row.", cause),
      ),
    );

  const toStep = (row: StepRow) =>
    decodeStep({
      stepId: row.step_id,
      attempt: row.attempt,
      status: row.status,
      verdict:
        row.verdict_label === null
          ? null
          : { label: row.verdict_label, reason: row.verdict_reason ?? "" },
      outputExcerpt: row.output_excerpt,
      threadId: row.thread_id,
      error: row.error,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    }).pipe(
      Effect.mapError((cause) => repositoryError("Could not decode a routine step row.", cause)),
    );

  const listExecutions: ExecutionRepository["Service"]["listExecutions"] = (projectId) =>
    sql<ExecutionRow>`
      SELECT execution_id, project_id, routine_id, routine_hash, definition_json, brief, status,
             worktree_path, branch, error, created_at, updated_at, finished_at
      FROM routine_executions
      WHERE project_id = ${projectId}
      ORDER BY created_at DESC, execution_id DESC
      LIMIT ${LIST_LIMIT}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError((cause) => repositoryError("Could not list routine executions.", cause)),
      Effect.flatMap((rows) => Effect.forEach(rows, toExecution)),
    );

  const getExecution: ExecutionRepository["Service"]["getExecution"] = (id) =>
    sql<ExecutionRow>`
      SELECT execution_id, project_id, routine_id, routine_hash, definition_json, brief, status,
             worktree_path, branch, error, created_at, updated_at, finished_at
      FROM routine_executions
      WHERE execution_id = ${id}
      LIMIT 1
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError((cause) => repositoryError("Could not read a routine execution.", cause)),
      Effect.flatMap((rows) => {
        const row = rows[0];
        return row === undefined
          ? Effect.succeed(Option.none<RoutineExecution>())
          : toExecution(row).pipe(Effect.asSome);
      }),
    );

  const listSteps: ExecutionRepository["Service"]["listSteps"] = (id) =>
    sql<StepRow>`
      SELECT execution_id, step_id, attempt, status, verdict_label, verdict_reason, output_excerpt,
             thread_id, error, started_at, finished_at
      FROM routine_execution_steps
      WHERE execution_id = ${id}
      ORDER BY started_at ASC, step_id ASC, attempt ASC
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError((cause) => repositoryError("Could not list routine steps.", cause)),
      Effect.flatMap((rows) => Effect.forEach(rows, toStep)),
    );

  const insertExecution: ExecutionRepository["Service"]["insertExecution"] = (execution) =>
    sql`
      INSERT INTO routine_executions (
        execution_id, project_id, routine_id, routine_hash, definition_json, brief, status,
        worktree_path, branch, error, created_at, updated_at, finished_at
      ) VALUES (
        ${execution.id}, ${execution.projectId}, ${execution.routineId}, ${execution.routineHash},
        ${encodeDefinitionJson(execution.definition)}, ${execution.brief}, ${execution.status},
        ${execution.worktreePath}, ${execution.branch}, ${execution.error},
        ${execution.createdAt}, ${execution.updatedAt}, ${execution.finishedAt}
      )
    `.pipe(
      Effect.asVoid,
      Effect.mapError((cause) => repositoryError("Could not insert a routine execution.", cause)),
    );

  const updateExecution: ExecutionRepository["Service"]["updateExecution"] = (execution) =>
    sql`
      UPDATE routine_executions
      SET status = ${execution.status},
          worktree_path = ${execution.worktreePath},
          branch = ${execution.branch},
          error = ${execution.error},
          updated_at = ${execution.updatedAt},
          finished_at = ${execution.finishedAt}
      WHERE execution_id = ${execution.id}
    `.pipe(
      Effect.asVoid,
      Effect.mapError((cause) => repositoryError("Could not update a routine execution.", cause)),
    );

  const upsertStep: ExecutionRepository["Service"]["upsertStep"] = (step) =>
    sql`
      INSERT OR REPLACE INTO routine_execution_steps (
        execution_id, step_id, attempt, status, verdict_label, verdict_reason, output_excerpt,
        thread_id, error, started_at, finished_at
      ) VALUES (
        ${step.executionId}, ${step.stepId}, ${step.attempt}, ${step.status},
        ${step.verdict?.label ?? null}, ${step.verdict?.reason ?? null}, ${step.outputExcerpt},
        ${step.threadId}, ${step.error}, ${step.startedAt}, ${step.finishedAt}
      )
    `.pipe(
      Effect.asVoid,
      Effect.mapError((cause) => repositoryError("Could not write a routine step.", cause)),
    );

  const listRunning: ExecutionRepository["Service"]["listRunning"] = () =>
    sql<ExecutionRow>`
      SELECT execution_id, project_id, routine_id, routine_hash, definition_json, brief, status,
             worktree_path, branch, error, created_at, updated_at, finished_at
      FROM routine_executions
      WHERE status = 'running'
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError((cause) => repositoryError("Could not list running executions.", cause)),
      Effect.flatMap((rows) => Effect.forEach(rows, toExecution)),
    );

  const listApprovedHashes: ExecutionRepository["Service"]["listApprovedHashes"] = (projectId) =>
    sql<{ readonly routine_id: string; readonly approved_hash: string }>`
      SELECT routine_id, approved_hash FROM routine_approvals WHERE project_id = ${projectId}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError((cause) => repositoryError("Could not list routine approvals.", cause)),
      Effect.map((rows) => new Map(rows.map((row) => [row.routine_id, row.approved_hash]))),
    );

  const setApproval: ExecutionRepository["Service"]["setApproval"] = (input) =>
    sql`
      INSERT OR REPLACE INTO routine_approvals (project_id, routine_id, approved_hash, approved_at)
      VALUES (${input.projectId}, ${input.routineId}, ${input.hash}, ${input.approvedAt})
    `.pipe(
      Effect.asVoid,
      Effect.mapError((cause) => repositoryError("Could not write a routine approval.", cause)),
    );

  const insertCouncilRecord: ExecutionRepository["Service"]["insertCouncilRecord"] = (record) =>
    sql`
      INSERT INTO routine_council_records (
        record_id, execution_id, step_id, attempt, thread_id, request_id, question, answer,
        rationale, confidence, independent, created_at
      ) VALUES (
        ${record.id}, ${record.executionId}, ${record.stepId}, ${record.attempt},
        ${record.threadId}, ${record.requestId}, ${record.question}, ${record.answer},
        ${record.rationale}, ${record.confidence}, ${record.independent ? 1 : 0}, ${record.createdAt}
      )
    `.pipe(
      Effect.asVoid,
      Effect.mapError((cause) => repositoryError("Could not write a council record.", cause)),
    );

  const listCouncilRecords: ExecutionRepository["Service"]["listCouncilRecords"] = (input) =>
    sql<{
      readonly record_id: string;
      readonly execution_id: string;
      readonly step_id: string;
      readonly attempt: number;
      readonly thread_id: string;
      readonly request_id: string;
      readonly question: string;
      readonly answer: string;
      readonly rationale: string;
      readonly confidence: string;
      readonly independent: number;
      readonly created_at: string;
    }>`
      SELECT record_id, execution_id, step_id, attempt, thread_id, request_id, question, answer,
             rationale, confidence, independent, created_at
      FROM routine_council_records
      WHERE execution_id = ${input.executionId}
        AND (${input.stepId ?? null} IS NULL OR step_id = ${input.stepId ?? null})
        AND (${input.attempt ?? null} IS NULL OR attempt = ${input.attempt ?? null})
      ORDER BY created_at ASC, record_id ASC
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError((cause) => repositoryError("Could not list council records.", cause)),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeCouncilRecord({
            id: row.record_id,
            executionId: row.execution_id,
            stepId: row.step_id,
            attempt: row.attempt,
            threadId: row.thread_id,
            requestId: row.request_id,
            question: row.question,
            answer: row.answer,
            rationale: row.rationale,
            confidence: row.confidence,
            independent: row.independent !== 0,
            createdAt: row.created_at,
          }).pipe(
            Effect.mapError((cause) =>
              repositoryError("Could not decode a council record.", cause),
            ),
          ),
        ),
      ),
    );

  const upsertSummary: ExecutionRepository["Service"]["upsertSummary"] = (input) =>
    sql`
      INSERT OR REPLACE INTO routine_step_summaries (
        execution_id, step_id, attempt, summary, generated_at
      ) VALUES (${input.executionId}, ${input.stepId}, ${input.attempt}, ${input.summary}, ${input.generatedAt})
    `.pipe(
      Effect.asVoid,
      Effect.mapError((cause) => repositoryError("Could not write a step summary.", cause)),
    );

  const listSummaries: ExecutionRepository["Service"]["listSummaries"] = (executionId) =>
    sql<{ readonly step_id: string; readonly attempt: number; readonly summary: string }>`
      SELECT step_id, attempt, summary FROM routine_step_summaries WHERE execution_id = ${executionId}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError((cause) => repositoryError("Could not list step summaries.", cause)),
      Effect.map(
        (rows) => new Map(rows.map((row) => [`${row.step_id}:${row.attempt}`, row.summary])),
      ),
    );

  return ExecutionRepository.of({
    insertCouncilRecord,
    listCouncilRecords,
    upsertSummary,
    listSummaries,
    listRunning,
    listApprovedHashes,
    setApproval,
    listExecutions,
    getExecution,
    listSteps,
    insertExecution,
    updateExecution,
    upsertStep,
  });
});

export const layer = Layer.effect(ExecutionRepository, make);
