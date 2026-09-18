const assert = require("node:assert/strict");
const test = require("node:test");

const {
  classifyScheduleReceipt,
} = require("../../src/modules/notifications/models/notificationScheduleReceipt");

test("source-backed schedule receipts are retained by source identity", () => {
  assert.deepEqual(classifyScheduleReceipt({
    type: "GLOBAL_EVENT_STARTED",
    sourceRef: "entitlement-1",
    sourceRevision: 2,
    availableAt: new Date("2026-09-02T12:00:00Z"),
  }), {
    sourceKind: "SOURCE_BACKED",
    sourceType: "GLOBAL_STEP_EVENT_ENTITLEMENT",
    sourceId: "entitlement-1",
    sourceRevision: 2,
    directRetainUntil: null,
  });
});

test("direct schedule receipts cover alert visibility plus retry horizon", () => {
  assert.deepEqual(classifyScheduleReceipt({
    type: "DAILY_REWARD_REMINDER",
    sourceRef: null,
    availableAt: new Date("2026-09-02T12:00:00Z"),
    expiresAt: new Date("2026-10-02T12:00:00Z"),
  }).directRetainUntil, new Date("2026-10-02T12:15:00Z"));
});
