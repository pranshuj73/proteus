import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS routine_walk_frontiers (
      execution_id TEXT PRIMARY KEY,
      frontier_json TEXT NOT NULL
    )
  `;
});
