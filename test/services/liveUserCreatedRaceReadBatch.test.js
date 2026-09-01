const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createLiveUserCreatedRaceReadBatch,
} = require("../../src/modules/races/services/liveUserCreatedRaceReadBatch");

test("live user-created race checks collapse concurrent viewers", async () => {
  let calls = 0;
  const prisma = { raceParticipant: { async findMany({ where }) {
    calls += 1;
    assert.deepEqual(new Set(where.userId.in), new Set(["u1", "u2"]));
    return [{ userId: "u2" }];
  } } };
  const batch = createLiveUserCreatedRaceReadBatch();
  const [one, two] = await Promise.all([
    batch.hasLive({ prisma, userId: "u1" }),
    batch.hasLive({ prisma, userId: "u2" }),
  ]);
  assert.equal(one, false);
  assert.equal(two, true);
  assert.equal(calls, 1);
});
