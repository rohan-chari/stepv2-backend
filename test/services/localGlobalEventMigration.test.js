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
