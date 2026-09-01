const test = require("node:test");
const assert = require("node:assert/strict");

const {
  READ_SQL,
  createViewerActiveEventReadBatch,
} = require("../../src/modules/steps/services/viewerActiveEventReadBatch");

test("cold-wave active-event reads share one set-based query", async () => {
  const calls = [];
  const prisma = {
    async $queryRawUnsafe(sql, payload, raceId) {
      calls.push({ sql, ids: JSON.parse(payload), raceId });
      return [{
        userId: "user-0",
        eventId: "event-1",
        multiplier: "2",
        endsAt: new Date("2026-09-01T13:00:00.000Z"),
      }];
    },
  };
  const batch = createViewerActiveEventReadBatch();
  const now = new Date("2026-09-01T12:00:00.000Z");

  const values = await Promise.all(Array.from({ length: 100 }, (_, index) =>
    batch.load({ prisma, userId: `user-${index}`, raceId: null, now })));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, READ_SQL);
  assert.equal(calls[0].ids.length, 100);
  assert.equal(calls[0].raceId, null);
  assert.deepEqual(values[0], {
    eventId: "event-1",
    multiplier: 2,
    endsAt: new Date("2026-09-01T13:00:00.000Z"),
  });
  assert.equal(values[1], null);
  assert.match(READ_SQL, /DISTINCT ON \(requested\."userId"\)/);
  assert.match(READ_SQL, /participant\.finished_at IS NULL/);
});

test("race-scoped active-event reads never share a query across races", async () => {
  const raceIds = [];
  const prisma = { async $queryRawUnsafe(_sql, _payload, raceId) {
    raceIds.push(raceId);
    return [];
  } };
  const batch = createViewerActiveEventReadBatch();
  await Promise.all([
    batch.load({ prisma, userId: "u1", raceId: "r1", now: new Date(0) }),
    batch.load({ prisma, userId: "u2", raceId: "r2", now: new Date(0) }),
  ]);
  assert.deepEqual(raceIds.sort(), ["r1", "r2"]);
});
