const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("stable timezone backfill accepts only PostgreSQL-known IANA zones", () => {
  const sql = fs.readFileSync(path.join(
    __dirname,
    "../../prisma/migrations/20260819193000_local_global_step_event_entitlements/migration.sql"
  ), "utf8");
  assert.match(sql, /pg_timezone_names/i);
  assert.match(sql, /z\.name\s*=\s*"timezone"/i);
});

test("weighted local schedule migration is additive, transactional, and narrowly backfilled", () => {
  const sql = fs.readFileSync(path.join(
    __dirname,
    "../../prisma/migrations/20260827180000_weighted_local_2x_schedule/migration.sql"
  ), "utf8");
  assert.match(sql, /^\s*BEGIN\s*;/i);
  assert.match(sql, /COMMIT\s*;\s*$/i);
  assert.match(
    sql,
    /ALTER\s+TABLE\s+"global_step_events"[\s\S]*ADD\s+COLUMN\s+"schedule_policy_version"\s+INTEGER\s*;/i
  );
  const alter = sql.match(/ALTER\s+TABLE[\s\S]*?;/i)?.[0] || "";
  assert.doesNotMatch(alter, /NOT\s+NULL|DEFAULT/i);
  assert.match(
    sql,
    /UPDATE\s+"global_step_events"[\s\S]*SET\s+"schedule_policy_version"\s*=\s*1[\s\S]*WHERE\s+"schedule_mode"\s*=\s*'LOCAL_ENTITLEMENTS'[\s\S]*AND\s+"schedule_policy_version"\s+IS\s+NULL/i
  );
  assert.doesNotMatch(sql, /\b(?:DROP|DELETE)\b/i);
  assert.doesNotMatch(sql, /UPDATE\s+"global_step_event_entitlements"/i);
  assert.doesNotMatch(sql, /SET\s+"(?:local_start_minute|starts_at|ends_at)"/i);
  assert.doesNotMatch(sql, /schedule_mode"\s*=\s*'LEGACY_GLOBAL'/i);
});
