import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS routine_council_records (
      record_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      rationale TEXT NOT NULL,
      confidence TEXT NOT NULL,
      independent INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX routine_council_records_execution_idx
    ON routine_council_records(execution_id, created_at)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS routine_step_summaries (
      execution_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      summary TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      PRIMARY KEY (execution_id, step_id, attempt)
    )
  `;
});
