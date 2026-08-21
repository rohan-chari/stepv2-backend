const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildGetRacePowerupTargetContext,
} = require("../../src/modules/races/queries/getRacePowerupTargetContext");

test("Bounty target context uses the narrow persisted roster instead of full progress", async () => {
  let progressLoads = 0;
  const getContext = buildGetRacePowerupTargetContext({
    Race: {
      async findPowerupTargetContext() {
        return {
          id: "race-1",
          status: "ACTIVE",
          powerupsEnabled: true,
          participants: [
            {
              id: "p-1", userId: "user-1", totalSteps: 100,
              finishedAt: null, placement: 1, forfeitedAt: null,
              team: null, joinedAt: new Date("2026-08-20T13:00:00Z"),
              powerupSlots: 3,
              user: { displayName: "Runner", profilePhotoUrl: null },
            },
          ],
        };
      },
    },
    RaceActiveEffect: { async findActiveForRace() { return []; } },
    RacePowerup: {
      async findInventoryForParticipants() {
        return [{ id: "powerup-1", type: "BOUNTY", rarity: "RARE", status: "HELD" }];
      },
    },
    now: () => new Date("2026-08-20T14:00:00Z"),
  });

  const result = await getContext({
    userId: "user-1",
    raceId: "race-1",
    powerupType: "BOUNTY",
    loadBountyProgress: async () => {
      progressLoads += 1;
      throw new Error("full progress should not load");
    },
  });

  assert.equal(progressLoads, 0);
  assert.equal(result.contract, "race-powerup-target-context-v1");
  assert.equal(result.participants[0].totalSteps, 100);
  assert.equal(result.powerupData.inventory[0].id, "powerup-1");
});
