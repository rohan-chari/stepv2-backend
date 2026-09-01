const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
  GLOBAL_EVENT_ATTEMPTS_PER_MINUTE,
  GLOBAL_EVENT_DELIVERY_WINDOW_MS,
  admissionSequenceForDeliveryKey,
  tokenSpacingMicros,
} = require("../../src/modules/notifications/services/notificationAdmission");

test("global-event admission uses a permanent exact-microsecond two-minute policy", () => {
  assert.equal(ADMISSION_CLASS_GLOBAL_EVENT_STARTED, "visible:GLOBAL_EVENT_STARTED");
  assert.equal(GLOBAL_EVENT_ATTEMPTS_PER_MINUTE, 6000);
  assert.equal(GLOBAL_EVENT_DELIVERY_WINDOW_MS, 120000);
  assert.equal(60_000_000 % GLOBAL_EVENT_ATTEMPTS_PER_MINUTE, 0);
  assert.equal(tokenSpacingMicros(GLOBAL_EVENT_ATTEMPTS_PER_MINUTE), 10000);
});

test("admission sequence is a stable non-negative signed-bigint value", () => {
  const key = "visible:GLOBAL_EVENT_STARTED:user-1:event-1";
  const first = admissionSequenceForDeliveryKey(key);
  assert.equal(first, admissionSequenceForDeliveryKey(key));
  assert.equal(typeof first, "bigint");
  assert.ok(first >= 0n);
  assert.ok(first <= 9223372036854775807n);
  assert.notEqual(first, admissionSequenceForDeliveryKey(`${key}:different`));
});
