const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildSyncRacePowerupState,
} = require("../../src/modules/races/services/racePowerupStateSync");

// Box progress tracks RAW walked steps (immune to every buff/debuff multiplier).
// The step paths compute that raw box total and pass it to the gate as
// `boxEffectiveSteps`; the gate rolls on THAT value. Callers that pass no override
// (inventory actions: open/use/discard) add no steps, so the gate must NOT roll
// for them — preventing a buffed leaderboard total from advancing next_box.

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

const PARTICIPANT = {
  id: "rp-1",
  userId: "user-1",
  status: "ACCEPTED",
  totalSteps: 12000, // buff-inflated leaderboard total — must NOT drive box rolls
  bonusSteps: 0,
  maxBonusSteps: 0,
  nextBoxAtSteps: 6000,
  powerupSlots: 3,
  finishedAt: null,
  finishTotalSteps: null,
  user: { displayName: "Runner" },
};

test("gate rolls on the raw boxEffectiveSteps override (not the buffed total)", async () => {
  // Raw walked steps = 7000 >= next box 6000 -> roll, regardless of the 12000 total.
  const ctx = makeDeps(PARTICIPANT);

  await ctx.syncRacePowerupState({
    raceId: "race-1",
    userId: "user-1",
    boxEffectiveSteps: 7000,
  });

  assert.equal(ctx.rollCalls.length, 1, "rolls on the raw box total");
  assert.equal(ctx.rollCalls[0].effectiveSteps, 7000, "passes the raw total to rollPowerup");
});

test("without an override (inventory-action sync) the gate does NOT roll", async () => {
  // No boxEffectiveSteps -> must not roll, even though totalSteps 12000 >= next box.
  // This is what stops an open/use/discard during a buff from advancing next_box.
  const ctx = makeDeps(PARTICIPANT);

  await ctx.syncRacePowerupState({ raceId: "race-1", userId: "user-1" });

  assert.equal(ctx.rollCalls.length, 0, "no override => no roll");
});

test("a raw override below the threshold does not roll, and 0 is honored (not 'missing')", async () => {
  const below = makeDeps(PARTICIPANT);
  await below.syncRacePowerupState({ raceId: "race-1", userId: "user-1", boxEffectiveSteps: 5000 });
  assert.equal(below.rollCalls.length, 0, "5000 < next box 6000 -> no roll");

  const zero = makeDeps(PARTICIPANT);
  await zero.syncRacePowerupState({ raceId: "race-1", userId: "user-1", boxEffectiveSteps: 0 });
  assert.equal(zero.rollCalls.length, 0, "explicit 0 gates on 0, not on totalSteps");
});
