const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  createGlobalEventCaptureFactCache,
} = require("../../src/modules/steps/services/globalEventCaptureFactCache");

const DAY_MS = 24 * 60 * 60 * 1000;

function request(userId, startDay, endDay, generation = 1n) {
  return {
    userId,
    generation,
    sampleStartMs: startDay * DAY_MS,
    sampleEndMs: endDay * DAY_MS,
    dailyStart: new Date(startDay * DAY_MS).toISOString().slice(0, 10),
    dailyEnd: new Date((endDay - 1) * DAY_MS).toISOString().slice(0, 10),
  };
}

function loaded(userId, startDay, { sampleCount = 1, dailyCount = 1 } = {}) {
  return {
    samples: Array.from({ length: sampleCount }, (_, index) => ({
      rowId: `${userId}-sample-${startDay}-${index}`,
      userId,
      periodStart: new Date((startDay + index / 10) * DAY_MS),
      periodEnd: new Date((startDay + (index + 1) / 10) * DAY_MS),
      steps: 100 + index,
    })),
    dailySteps: Array.from({ length: dailyCount }, (_, index) => ({
      rowId: `${userId}-daily-${startDay}-${index}`,
      userId,
      date: new Date((startDay + index) * DAY_MS),
      steps: 1_000 + index,
    })),
  };
}

function commit(cache, cacheRequest, facts = loaded(cacheRequest.userId, 1)) {
  const claim = cache.inspect(cacheRequest);
  assert.equal(claim.outcome, "miss");
  claim.commit(facts);
}

describe("global-event capture fact cache invariants", () => {
  it("does not treat the gap between two disjoint fills as covered", () => {
    const cache = createGlobalEventCaptureFactCache();
    commit(cache, request("user-1", 10, 12), loaded("user-1", 10));
    commit(cache, request("user-1", 1, 3), loaded("user-1", 1));

    const middle = cache.inspect(request("user-1", 5, 7));
    assert.equal(middle.outcome, "miss");
    assert.equal(middle.bounds.length, 1);
    middle.rollback();
  });

  it("evicts least-recently-used entries using samples and daily rows together", () => {
    const cache = createGlobalEventCaptureFactCache({ maxRows: 3 });
    commit(cache, request("user-1", 1, 2), loaded("user-1", 1, {
      sampleCount: 2,
      dailyCount: 1,
    }));
    commit(cache, request("user-2", 1, 2), loaded("user-2", 1, {
      sampleCount: 1,
      dailyCount: 1,
    }));

    const evicted = cache.inspect(request("user-1", 1, 2));
    assert.equal(evicted.outcome, "miss");
    evicted.rollback();
    const retained = cache.inspect(request("user-2", 1, 2));
    assert.equal(retained.outcome, "hit");
  });

  it("expires entries at the configured TTL", () => {
    let now = 10_000;
    const cache = createGlobalEventCaptureFactCache({ ttlMs: 50, now: () => now });
    const cacheRequest = request("user-1", 1, 2);
    commit(cache, cacheRequest);
    assert.equal(cache.inspect(cacheRequest).outcome, "hit");
    now += 51;
    const expired = cache.inspect(cacheRequest);
    assert.equal(expired.outcome, "miss");
    expired.rollback();
  });

  it("releases a pending waiter when a failed fill rolls back", async () => {
    const cache = createGlobalEventCaptureFactCache();
    const cacheRequest = request("user-1", 1, 2);
    const leader = cache.inspect(cacheRequest);
    const waiter = cache.inspect(cacheRequest);
    assert.equal(leader.outcome, "miss");
    assert.equal(waiter.outcome, "wait");

    leader.rollback();
    assert.equal(await waiter.wait, false);
    const recovery = cache.inspect(cacheRequest);
    assert.equal(recovery.outcome, "miss");
    recovery.rollback();
  });
});
