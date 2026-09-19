const assert = require("node:assert/strict");
const { test } = require("node:test");
const { hydrateGlobalEventRedisSchedule } = require("../../../src/modules/steps/jobs/globalEventRedisScheduleHydrator");

test("hydration batches END writes and restores overdue pending boundaries", async () => {
  const now = new Date("2098-09-19T12:00:00Z");
  const rows = [
    { id: "a", startProcessedAt: now, endsAt: new Date(now.getTime() - 60_000) },
    { id: "b", startProcessedAt: now, endsAt: new Date(now.getTime() + 60_000) },
    { id: "c", startProcessedAt: null, endsAt: new Date(now.getTime() + 120_000) },
    { id: "d", startProcessedAt: now, endProcessedAt: now, endsAt: new Date(now.getTime() - 60_000) },
  ].map((row) => ({ startsAt: new Date(now.getTime() - 120_000), endProcessedAt: null, scheduleRevision: 0, ...row }));
  const writes = [];
  const result = await hydrateGlobalEventRedisSchedule({
    now, batchSize: 2,
    prisma: { globalStepEventEntitlement: {
      async findMany({ where, take }) {
        return rows.filter((row) => (!where.id || row.id > where.id.gt) && where.OR.some((condition) =>
          Object.entries(condition).every(([field, expected]) => {
            if (expected === null) return row[field] == null;
            return (!expected.gt || row[field] > expected.gt) && (!expected.lte || row[field] <= expected.lte);
          }),
        )).slice(0, take);
      },
    } },
    async scheduleEntitlements(batch, options = {}) {
      writes.push({ ids: batch.map((row) => row.id), options });
    },
  });
  assert.equal(result.scheduled, 4);
  assert.deepEqual(writes, [
    { ids: ["a", "b"], options: { start: false } },
    { ids: ["c"], options: {} },
  ]);
});
