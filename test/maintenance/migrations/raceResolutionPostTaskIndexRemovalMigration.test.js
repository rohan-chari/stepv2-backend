const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migrationPath = path.join(
  __dirname,
  "../../prisma/migrations/20260915120000_drop_redundant_race_post_task_generation_index/migration.sql"
);

test("post-task redundant index migration drops only the plain generation index concurrently", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /DROP\s+INDEX\s+CONCURRENTLY\s+"race_resolution_post_tasks_race_id_source_generation_idx"/i);
  assert.doesNotMatch(sql, /DROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS/i);
  assert.doesNotMatch(sql, /\b(BEGIN|COMMIT)\b/i);
  assert.doesNotMatch(sql, /race_resolution_post_tasks_race_id_source_generation_key.*DROP|DROP.*race_resolution_post_tasks_race_id_source_generation_key/is);
  assert.doesNotMatch(sql, /race_resolution_post_tasks_dedupe_key_key.*DROP|DROP.*race_resolution_post_tasks_dedupe_key_key/is);
});
