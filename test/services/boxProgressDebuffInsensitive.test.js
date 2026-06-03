const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildSyncRacePowerupState,
} = require("../../src/services/racePowerupStateSync");

// Product decision (revert of the brief debuff-sensitive window): mystery-box
// progress is DEBUFF-INSENSITIVE for Leg Cramp (freeze) and Wrong Turn (reverse).
// Those two debuffs subtract from totalSteps, but the steps they shaved off are
// persisted on the participant as boxDebuffOffsetSteps and ADDED BACK by the
// roll gate, so neither pushes the "steps to next box" countdown backward. The
// bonusSteps high-water (maxBonusSteps) separately shields bonus-steal
// (Red Card/Shortcut/Pinecone/Trail Mine). Campfire Rest's freeze is NOT in the
// offset and so still slows box earning.

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

function baseParticipant(overrides = {}) {
  return {
    id: "rp-1",
    userId: "user-1",
    status: "ACCEPTED",
    totalSteps: 5000,
    bonusSteps: 0,
    maxBonusSteps: 0,
    nextBoxAtSteps: 8000,
    boxDebuffOffsetSteps: 0,
    powerupSlots: 3,
    finishedAt: null,
    finishTotalSteps: null,
    user: { displayName: "Runner" },
    ...overrides,
  };
}

test("Leg Cramp / Wrong Turn losses are re-credited: box rolls once the offset closes the gap", async () => {
  // Net totalSteps is only 5000 (a 3000-step freeze/reverse pushed it down), but
  // boxDebuffOffsetSteps re-credits those 3000 -> effective 8000 == next box.
  const ctx = makeDeps(
    baseParticipant({ totalSteps: 5000, boxDebuffOffsetSteps: 3000, nextBoxAtSteps: 8000 })
  );

  await ctx.syncRacePowerupState({ raceId: "race-1", userId: "user-1" });

  assert.equal(ctx.rollCalls.length, 1, "debuff must not delay the box");
  assert.equal(
    ctx.rollCalls[0].effectiveSteps,
    8000,
    "effectiveSteps handed to the roll includes the debuff offset"
  );
});

test("no debuff (offset 0): box gates on real steps", async () => {
  const ctx = makeDeps(
    baseParticipant({ totalSteps: 5000, boxDebuffOffsetSteps: 0, nextBoxAtSteps: 8000 })
  );

  await ctx.syncRacePowerupState({ raceId: "race-1", userId: "user-1" });

  assert.equal(ctx.rollCalls.length, 0, "no offset -> no early roll");
});

test("offset stacks with the bonusSteps high-water (bonus-steal + Leg Cramp)", async () => {
  // Red Card stole 1000 bonus (max 1000, now 0) AND a Leg Cramp froze 2000.
  // Base steps 5000 + bonus re-credit 1000 + offset 2000 = 8000 == next box.
  const ctx = makeDeps(
    baseParticipant({
      totalSteps: 5000,
      bonusSteps: 0,
      maxBonusSteps: 1000,
      boxDebuffOffsetSteps: 2000,
      nextBoxAtSteps: 8000,
    })
  );

  await ctx.syncRacePowerupState({ raceId: "race-1", userId: "user-1" });

  assert.equal(ctx.rollCalls.length, 1);
  assert.equal(ctx.rollCalls[0].effectiveSteps, 8000);
});

test("absent/NULL boxDebuffOffsetSteps is treated as 0 (back-compat)", async () => {
  const participant = baseParticipant({ totalSteps: 8000, nextBoxAtSteps: 8000 });
  delete participant.boxDebuffOffsetSteps; // old row written before the column existed

  const ctx = makeDeps(participant);

  await ctx.syncRacePowerupState({ raceId: "race-1", userId: "user-1" });

  assert.equal(ctx.rollCalls.length, 1, "missing offset must not crash or block");
  assert.equal(ctx.rollCalls[0].effectiveSteps, 8000);
});
