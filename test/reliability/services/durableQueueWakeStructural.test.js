const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("queue model transaction modules never publish Redis wake-ups", () => {
  for (const file of [
    "src/modules/races/models/raceResolutionJobV2.js",
    "src/modules/races/models/racePlacementTransitionJob.js",
    "src/modules/races/models/raceResolutionPostTask.js",
    "src/modules/domainEvents/models/domainEventOutbox.js",
    "src/modules/notifications/models/notificationScheduleReceipt.js",
  ]) {
    const source = read(file);
    assert.doesNotMatch(source, /redisCache|publishDurableQueueWakeup|publishNotificationWakeup/, file);
  }
});

test("every raw domain-event producer is receipt-triggered and publishes only after commit", () => {
  const entitlement = read("src/modules/steps/services/globalStepEventEntitlement.js");
  const timezone = read("src/modules/steps/services/globalEventTimezoneReconciliation.js");
  const migration = read(
    "prisma/migrations/20260902120000_durable_queue_receipts_and_readiness/migration.sql",
  );
  for (const [file, source] of [
    ["globalStepEventEntitlement.js", entitlement],
    ["globalEventTimezoneReconciliation.js", timezone],
  ]) {
    assert.match(source, /INSERT INTO domain_event_outbox/, file);
    assert.match(source, /deferUntilAfterCommit/, file);
    assert.match(source, /publishDurableQueueWakeup\("domain-event"\)/, file);
  }
  assert.match(migration, /CREATE TRIGGER domain_event_outbox_legacy_receipt_trigger/);
  assert.match(migration, /receipt_state[^\n]*PROVISIONAL/i);
});
