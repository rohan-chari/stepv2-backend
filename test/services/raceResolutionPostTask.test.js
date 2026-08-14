const assert = require("node:assert/strict");
const test = require("node:test");

const {
  TASK_STATES,
  SNAPSHOT_STATES,
  INTENT_STATES,
  validatePostTaskPayload,
} = require("../../src/modules/races/models/raceResolutionPostTask");

test("post-task state machines are closed and have no retry/obsolete state", () => {
  assert.deepEqual([...TASK_STATES], ["queued", "running", "succeeded", "succeeded_with_failures"]);
  assert.deepEqual([...SNAPSHOT_STATES], [
    "pending", "attempting", "succeeded", "failed_no_retry",
    "ambiguous_at_most_once", "skipped_superseded",
  ]);
  assert.deepEqual([...INTENT_STATES], [
    "pending", "attempting", "accepted", "rejected_no_retry", "ambiguous_at_most_once",
  ]);
});

test("post-task validation preserves ordinal intent order and exact byte/count caps", () => {
  const value = validatePostTaskPayload({
    snapshotCommand: { raceId: "r", timeZone: "UTC" },
    intents: [
      { kind: "STATE_NOTIFICATION", recipientUserId: "u1", payload: { title: "one" }, deliveryKeyHash: "a".repeat(64) },
      { kind: "NUDGE", recipientUserId: "u2", payload: { title: "two" }, deliveryKeyHash: "b".repeat(64) },
    ],
  });
  assert.deepEqual(value.intents.map((intent) => intent.ordinal), [0, 1]);
  assert.equal(value.intentCount, 2);
  assert.ok(value.payloadBytes > 0);
});

test("snapshot publication command is a closed allowlist", () => {
  assert.throws(
    () =>
      validatePostTaskPayload({
        snapshotCommand: { raceId: "r1", timeZone: "UTC", extra: true },
        intents: [],
      }),
    /invalid snapshot command/
  );
  assert.throws(
    () => validatePostTaskPayload({ snapshotCommand: { raceId: "r1" }, intents: [] }),
    /invalid snapshot command/
  );
  assert.deepEqual(
    validatePostTaskPayload({
      snapshotCommand: { raceId: "r1", timeZone: "UTC" },
      intents: [],
    }).snapshotCommand,
    { raceId: "r1", timeZone: "UTC" }
  );
});

test("post-task validation refuses truncation, device tokens and unknown intent kinds", () => {
  assert.throws(
    () => validatePostTaskPayload({ snapshotCommand: { raceId: "r", timeZone: "UTC" }, intents: Array.from({ length: 1001 }, () => ({})) }),
    /intent cap/
  );
  assert.throws(
    () => validatePostTaskPayload({ snapshotCommand: { raceId: "r", timeZone: "UTC" }, intents: [{ kind: "RETRY", payload: {}, deliveryKeyHash: "a".repeat(64) }] }),
    /intent kind/
  );
  assert.throws(
    () => validatePostTaskPayload({ snapshotCommand: { raceId: "r", timeZone: "UTC" }, intents: [{ kind: "NUDGE", payload: { deviceToken: "secret" }, deliveryKeyHash: "a".repeat(64) }] }),
    /device token/
  );
});
