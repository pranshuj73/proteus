import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS routine_executions (
      execution_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      routine_id TEXT NOT NULL,
      routine_hash TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      brief TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      worktree_path TEXT,
      branch TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX routine_executions_project_created_idx
    ON routine_executions(project_id, created_at)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS routine_execution_steps (
      execution_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      verdict_label TEXT,
      verdict_reason TEXT,
      output_excerpt TEXT,
      thread_id TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      PRIMARY KEY (execution_id, step_id, attempt)
    )
  `;
});
