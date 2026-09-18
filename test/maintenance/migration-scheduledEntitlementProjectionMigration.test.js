const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migrationPath = path.resolve(
  __dirname,
  "../../prisma/migrations/20260831211500_index_scheduled_entitlement_projection/migration.sql",
);

test("scheduled entitlement projector has a queue-specific partial index", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /CREATE INDEX CONCURRENTLY/);
  assert.match(sql, /"available_at", "occurred_at", "id"/);
  assert.match(sql, /"event_type" = 'GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1'/);
  assert.match(sql, /"schema_version" = 1/);
  assert.match(sql, /"status" IN \('PENDING', 'RETRY', 'EXPANDING'\)/);
});
