const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migrationPath = path.join(
  __dirname,
  "../../prisma/migrations/20260820150000_race_resolution_queue_priority/migration.sql"
);

function migrationSql() {
  return fs.readFileSync(migrationPath, "utf8");
}

test("queue priority migration is additive and defaults legacy rows to LIVE", () => {
  const sql = migrationSql();
  assert.match(sql, /ADD COLUMN "queue_priority" VARCHAR\(16\) NOT NULL DEFAULT 'LIVE'/);
  assert.match(sql, /ADD COLUMN "processing_queue_priority" VARCHAR\(16\) NOT NULL DEFAULT 'LIVE'/);
  assert.match(sql, /CREATE INDEX "race_resolution_jobs_v2_state_queue_priority_requested_at_idx"/);
  assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN|INDEX)\b/i);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
});

test("queue priority migration permits only the four persisted scheduling classes", () => {
  const sql = migrationSql();
  for (const column of ["queue_priority", "processing_queue_priority"]) {
    const constraint = new RegExp(
      `CHECK \\(\\"${column}\\" IN \\('SETTLEMENT', 'RECOVERY', 'LIVE', 'MAINTENANCE'\\)\\)`
    );
    assert.match(sql, constraint, `${column} must have a closed priority domain`);
  }
});
