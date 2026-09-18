const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migrationPath = path.resolve(
  __dirname,
  "../../prisma/migrations/20260826230000_repair_domain_event_projection_claim/migration.sql",
);

test("projection recovery migration indexes only nonterminal aggregate ordering rows", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /CREATE INDEX CONCURRENTLY/);
  assert.match(
    sql,
    /\("aggregate_type", "aggregate_id", "occurred_at", "id"\)/,
  );
  assert.match(
    sql,
    /WHERE "status" NOT IN \('COMPLETED', 'SUPPRESSED', 'FAILED_TERMINAL'\)/,
  );
});
