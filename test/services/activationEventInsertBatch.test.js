const test = require("node:test");
const assert = require("node:assert/strict");

const { createActivationEventInsertBatch } = require("../../src/modules/analytics/services/activationEventInsertBatch");

test("simultaneous activation requests use one insert and retain per-request counts", async () => {
  const calls = [];
  const prisma = { async $queryRawUnsafe(_sql, payload) {
    calls.push(payload);
    const rows = JSON.parse(payload);
    return [...new Set(rows.map((row) => row.requestIndex))].map((requestIndex) => ({
      requestIndex,
      inserted: requestIndex % 2 === 0 ? 1n : 0n,
    }));
  } };
  const batch = createActivationEventInsertBatch();
  const requests = Array.from({ length: 100 }, (_, index) => batch.insert({
    prisma,
    data: [{
      id: `event-${index}`, userId: `user-${index}`,
      onboardingSessionId: null, name: "home_reached", context: {},
      appVersion: "1.0.0", platform: "ios", occurredAt: new Date(0),
    }],
  }));

  const counts = await Promise.all(requests);
  assert.equal(calls.length, 1);
  assert.deepEqual(counts.slice(0, 4), [1, 0, 1, 0]);
});
