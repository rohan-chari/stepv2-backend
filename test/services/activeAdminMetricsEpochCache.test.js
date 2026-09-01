const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createActiveAdminMetricsEpochCache,
} = require("../../src/modules/analytics/services/activeAdminMetricsEpochCache");

test("active metrics epoch reads collapse and remain cached for the bounded ttl", async () => {
  let calls = 0;
  let current = 1_000;
  const prisma = {
    adminMetricsCollectionEpoch: {
      async findFirst() {
        calls += 1;
        return { id: "epoch-1" };
      },
    },
  };
  const cache = createActiveAdminMetricsEpochCache({ now: () => current, ttlMs: 5_000 });

  const values = await Promise.all([
    cache.get(prisma), cache.get(prisma), cache.get(prisma),
  ]);
  assert.deepEqual(values, [{ id: "epoch-1" }, { id: "epoch-1" }, { id: "epoch-1" }]);
  assert.equal(calls, 1);

  current += 4_999;
  assert.equal((await cache.get(prisma)).id, "epoch-1");
  assert.equal(calls, 1);

  current += 2;
  await cache.get(prisma);
  assert.equal(calls, 2);
});

test("the shared epoch cache never narrows the row needed by telemetry ingestion", async () => {
  let query;
  const epoch = { id: "epoch-1", startedAt: new Date(), endedAt: null };
  const prisma = {
    adminMetricsCollectionEpoch: {
      async findFirst(args) { query = args; return epoch; },
    },
  };
  const cache = createActiveAdminMetricsEpochCache();
  assert.equal(await cache.get(prisma), epoch);
  assert.equal("select" in query, false);
});

test("a lifecycle reset evicts the cached epoch", async () => {
  let calls = 0;
  const prisma = { adminMetricsCollectionEpoch: { async findFirst() {
    return { id: `epoch-${++calls}` };
  } } };
  const cache = createActiveAdminMetricsEpochCache();
  assert.equal((await cache.get(prisma)).id, "epoch-1");
  cache.clear(prisma);
  assert.equal((await cache.get(prisma)).id, "epoch-2");
});
