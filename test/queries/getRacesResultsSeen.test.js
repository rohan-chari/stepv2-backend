const assert = require("node:assert/strict");
const test = require("node:test");

// getRaces imports the Race + RacePowerup models directly. Mock those modules
// and re-require getRaces (same monkey-patch pattern as awardCoins.test.js) so
// we can assert the completed-bucket myResultsSeen flag without a real DB.
function withMockedRaces(races, fn) {
  const raceModule = require("../../src/models/race");
  const powerupModule = require("../../src/models/racePowerup");
  const originalRace = raceModule.Race;
  const originalPowerup = powerupModule.RacePowerup;

  Object.assign(raceModule, {
    Race: { async findForUser() { return races; } },
  });
  Object.assign(powerupModule, {
    RacePowerup: { async countQueuedByParticipant() { return 0; } },
  });

  try {
    delete require.cache[require.resolve("../../src/queries/getRaces")];
    const mod = require("../../src/queries/getRaces");
    return fn(mod);
  } finally {
    Object.assign(raceModule, { Race: originalRace });
    Object.assign(powerupModule, { RacePowerup: originalPowerup });
    delete require.cache[require.resolve("../../src/queries/getRaces")];
  }
}

function completedRace(myResultsSeenAt) {
  return {
    id: "race-1",
    name: "Done Race",
    status: "COMPLETED",
    maxDurationDays: 7,
    targetSteps: 50000,
    buyInAmount: 0,
    payoutPreset: "WINNER_TAKES_ALL",
    potCoins: 0,
    payoutCoins: 0,
    powerupsEnabled: false,
    creatorId: "user-1",
    isPublic: false,
    maxParticipants: 10,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    startedAt: new Date("2026-06-01T00:00:00Z"),
    endsAt: new Date("2026-06-08T00:00:00Z"),
    completedAt: new Date("2026-06-05T00:00:00Z"),
    creator: { id: "user-1", displayName: "Me" },
    winner: { id: "user-1", displayName: "Me" },
    participants: [
      {
        id: "p-1",
        userId: "user-1",
        status: "ACCEPTED",
        buyInStatus: "NONE",
        buyInAmount: 0,
        payoutCoins: 0,
        placement: 2,
        resultsSeenAt: myResultsSeenAt,
      },
    ],
  };
}

test("getRaces: myResultsSeen=false for an unseen completed race", async () => {
  await withMockedRaces([completedRace(null)], async ({ getRaces }) => {
    const result = await getRaces("user-1");
    assert.equal(result.completed.length, 1);
    assert.equal(result.completed[0].myResultsSeen, false);
  });
});

test("getRaces: myResultsSeen=true once the race has been acked", async () => {
  const seenAt = new Date("2026-06-10T00:00:00Z");
  await withMockedRaces([completedRace(seenAt)], async ({ getRaces }) => {
    const result = await getRaces("user-1");
    assert.equal(result.completed.length, 1);
    assert.equal(result.completed[0].myResultsSeen, true);
  });
});

test("getRaces: myResultsSeen=false when the field is absent (older backend row)", async () => {
  const race = completedRace(null);
  delete race.participants[0].resultsSeenAt;
  await withMockedRaces([race], async ({ getRaces }) => {
    const result = await getRaces("user-1");
    assert.equal(result.completed[0].myResultsSeen, false);
  });
});
