const assert = require("node:assert/strict");
const { it } = require("node:test");
const { prisma } = require("./setup");
it("expiry publication and legacy failure census have bounded partial-index paths", async () => {
  const rows = await prisma.$queryRawUnsafe(
    "SELECT p.indexname,p.indexdef,i.indisvalid FROM pg_indexes p JOIN pg_class c ON c.relname=p.indexname JOIN pg_index i ON i.indexrelid=c.oid WHERE p.schemaname='public' AND p.indexname=ANY($1::text[])",
    [
      "race_post_snapshot_pending_idx",
      "race_post_snapshot_failure_census_idx",
      "race_post_receipt_failure_census_idx",
    ],
  );
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.indisvalid));
  assert.ok(rows.every((row) => row.indexdef.includes(" WHERE ")));
});
