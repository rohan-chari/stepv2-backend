const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildSyncRacePowerupState,
} = require("../../src/services/racePowerupStateSync");

// Product decision: box progress is DEBUFF-SENSITIVE. Leg Cramp (frozenSteps)
// and Wrong Turn (reversedSteps) reduce effective steps, so they DO slow box
// earning and the countdown honestly reflects the steps still needed. Only the
// bonusSteps high-water (maxBonusSteps) protects bonus-steal pushbacks. The old
// maxBoxProgressSteps anchor (which froze the countdown below a player's
// pre-debuff peak) is deprecated and must be IGNORED by the roll gate.

function makeDeps(participant) {
  const rollCalls = [];
  const deps = {
    Race: {
      async findById() {
        return {
          id: "race-1",
          status: "ACTIVE",
          powerupsEnabled: true,
          powerupStepInterval: 2000,
          participants: [{ ...participant, user: { ...participant.user } }],
        };
      },
    },
    RacePowerup: {
      async countOccupiedSlots() {
        return 0;
      },
      async findQueuedByParticipant() {
        return [];
      },
      async update() {},
      async countQueuedByParticipant() {
        return 0;
      },
    },
    rollPowerup: async (args) => {
      rollCalls.push(args);
      return [];
    },
  };
  return { rollCalls, syncRacePowerupState: buildSyncRacePowerupState(deps) };
}

test("box roll IGNORES the deprecated maxBoxProgressSteps anchor (debuff-sensitive)", async () => {
  // Debuffed down to effective 5000, next box at 8000 (3000 away). A stale
  // anchor of 9000 sits above the next box — with the old anchor logic this
  // would have rolled. It must NOT: the roll gates on current effective steps.
  const ctx = makeDeps({
    id: "rp-1",
    userId: "user-1",
    status: "ACCEPTED",
    totalSteps: 5000,
    bonusSteps: 0,
    maxBonusSteps: 0,
    nextBoxAtSteps: 8000,
    maxBoxProgressSteps: 9000, // stale/deprecated — must be ignored
    powerupSlots: 3,
    finishedAt: null,
    finishTotalSteps: null,
    user: { displayName: "Frozen" },
  });

  await ctx.syncRacePowerupState({ raceId: "race-1", userId: "user-1" });

  assert.equal(
    ctx.rollCalls.length,
    0,
    "must not roll on the stale anchor; box progress is debuff-sensitive"
  );
});

test("box roll gates on current effective steps (bonus-anchored), not the anchor", async () => {
  // Effective 8000 (>= next box 8000) -> rolls. The deprecated anchor value is
  // irrelevant; the roll is driven by effectiveSteps.
  const ctx = makeDeps({
    id: "rp-1",
    userId: "user-1",
    status: "ACCEPTED",
    totalSteps: 8000,
    bonusSteps: 0,
    maxBonusSteps: 0,
    nextBoxAtSteps: 8000,
    maxBoxProgressSteps: 0,
    powerupSlots: 3,
    finishedAt: null,
    finishTotalSteps: null,
    user: { displayName: "Walker" },
  });

  await ctx.syncRacePowerupState({ raceId: "race-1", userId: "user-1" });

  assert.equal(ctx.rollCalls.length, 1);
  assert.equal(ctx.rollCalls[0].effectiveSteps, 8000);
});
