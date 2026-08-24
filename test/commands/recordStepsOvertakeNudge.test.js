const assert = require("node:assert/strict");
const test = require("node:test");
const { nudgeOvertakenRivals } = require("../../src/modules/steps/commands/recordSteps");

function participants({ unchanged = false, finishedSecond = false } = {}) {
  return [
    { id: "p1", userId: "u1", totalSteps: 1000, bonusSteps: 0,
      joinedAt: new Date(0), status: "ACCEPTED",
      lastNotifiedPlacement: unchanged ? 1 : 3, finishedAt: null },
    { id: "p2", userId: "u2", totalSteps: 900, bonusSteps: 0,
      joinedAt: new Date(1), status: "ACCEPTED",
      lastNotifiedPlacement: unchanged ? 2 : 1,
      finishedAt: finishedSecond ? new Date() : null },
    { id: "p3", userId: "u3", totalSteps: 800, bonusSteps: 0,
      joinedAt: new Date(2), status: "ACCEPTED",
      lastNotifiedPlacement: unchanged ? 3 : 2, finishedAt: null },
  ];
}

async function run(rows) {
  const nudged = [];
  await nudgeOvertakenRivals({
    raceResults: [{ raceId: "race-1", race: {} }],
    userId: "u1",
    participantModel: {
      async findAcceptedByRace(raceId) {
        assert.equal(raceId, "race-1");
        return rows;
      },
    },
    requestStepSyncForUsers: async (ids) => nudged.push(ids),
  });
  return nudged;
}

test("worker-owned overtake nudge selects exactly rivals passed 3 -> 1", async () => {
  assert.deepEqual(await run(participants()), [["u2", "u3"]]);
});

test("worker-owned overtake nudge does nothing when rank is unchanged", async () => {
  assert.deepEqual(await run(participants({ unchanged: true })), []);
});

test("worker-owned overtake nudge excludes a finished rival", async () => {
  assert.deepEqual(await run(participants({ finishedSecond: true })), [["u3"]]);
});

test("worker-owned overtake nudge surfaces delivery errors to the worker catcher", async () => {
  await assert.rejects(
    () => nudgeOvertakenRivals({
      raceResults: [{ raceId: "race-1", race: {} }],
      userId: "u1",
      participantModel: { async findAcceptedByRace() { return participants(); } },
      requestStepSyncForUsers: async () => { throw new Error("push boom"); },
    }),
    /push boom/
  );
});
