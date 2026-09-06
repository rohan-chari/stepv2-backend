const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

// These operational SQL entrypoints have no HTTP route. Guard the ordering of
// their transaction fence structurally; HTTP/retention behavior is covered by
// step-intake-bounded-history.test.js against real PostgreSQL.
for (const name of ["reset-app-review.sql", "seed-app-review-demo.sql"]) {
  test(`${name} invalidates scoring revisions before mutating source facts`, () => {
    const sql = readFileSync(path.join(__dirname, "../../scripts", name), "utf8");
    const fence = sql.indexOf("INSERT INTO user_scoring_input_versions");
    const sourceWrite = sql.search(/(?:INSERT INTO|DELETE FROM) steps\b/);
    assert.ok(fence >= 0 && fence < sourceWrite, "lock and bump input versions before source writes");
    assert.match(sql.slice(fence, sourceWrite), /generation\s*=\s*user_scoring_input_versions\.generation\s*\+\s*1/);
    assert.ok(sql.indexOf("BEGIN;") < fence);
    assert.ok(sql.indexOf("COMMIT;") > sourceWrite);
  });
}
