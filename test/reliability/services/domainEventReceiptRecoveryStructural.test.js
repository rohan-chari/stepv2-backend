const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const source = fs.readFileSync(
  path.join(__dirname, "../../src/modules/domainEvents/models/domainEventReceiptRecovery.js"),
  "utf8",
);
const retentionSource = fs.readFileSync(
  path.join(__dirname, "../../src/modules/domainEvents/jobs/domainEventRetention.js"),
  "utf8",
);
const schemaSource = fs.readFileSync(
  path.join(__dirname, "../../prisma/schema.prisma"),
  "utf8",
);
const migrationSource = fs.readFileSync(
  path.join(__dirname, "../../prisma/migrations/20260911131000_receipt_discovery_index/migration.sql"),
  "utf8",
);

it("does not SKIP LOCKED historical discovery rows, while claims remain bounded", () => {
  const discovery = source.slice(source.indexOf("async discoverPage"), source.indexOf("async claimPage"));
  const claims = source.slice(source.indexOf("async claimPage"));
  assert.doesNotMatch(discovery, /SKIP\s+LOCKED/i);
  assert.match(claims, /FOR UPDATE SKIP LOCKED/i);
});

it("retires only the domain-event broad scan in the approved single deployment", () => {
  assert.doesNotMatch(retentionSource, /eventReceipts\.backfillPage/);
  assert.match(retentionSource, /MAX_PAGES/);
  assert.match(retentionSource, /scheduleReceipts\.backfillPage/);
  assert.match(retentionSource, /checkpointed recovery cron/);
});

it("declares the keyset discovery index in both Prisma and its migration", () => {
  assert.match(schemaSource, /@@index\(\[createdAt, id\], map: "domain_event_outbox_created_at_id_receipt_recovery_idx"\)/);
  assert.match(migrationSource, /CREATE INDEX CONCURRENTLY "domain_event_outbox_created_at_id_receipt_recovery_idx"\s+ON "domain_event_outbox"\("created_at", "id"\)/);
});
