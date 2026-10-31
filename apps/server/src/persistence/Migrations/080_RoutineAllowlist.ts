import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS routine_allowlist (
      project_id TEXT NOT NULL,
      executable TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (project_id, executable)
    )
  `;
});
