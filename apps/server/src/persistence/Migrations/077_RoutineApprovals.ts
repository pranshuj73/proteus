import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS routine_approvals (
      project_id TEXT NOT NULL,
      routine_id TEXT NOT NULL,
      approved_hash TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      PRIMARY KEY (project_id, routine_id)
    )
  `;
});
