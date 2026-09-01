const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRaceSqlSummaryReadBatch,
} = require("../../src/modules/races/services/raceSqlSummaryReadBatch");

test("simultaneous viewers rank an identical race set once", async () => {
  const calls = [];
  const prisma = {};
  const batch = createRaceSqlSummaryReadBatch();
  const execute = async (userIds) => {
    calls.push(userIds);
    return userIds.flatMap((viewerUserId) => [
      { viewerUserId, raceId: "race-a" },
      { viewerUserId, raceId: "race-b" },
    ]);
  };
  const results = await Promise.all(Array.from({ length: 50 }, (_, index) =>
    batch.load({
      prisma,
      raceSetKey: "race-a\u0000race-b",
      userId: `user-${index}`,
      execute,
    })));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 50);
  assert.ok(results.every((rows, index) =>
    rows.length === 2 && rows.every((row) => row.viewerUserId === `user-${index}`)));
});
