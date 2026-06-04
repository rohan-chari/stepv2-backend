const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildSyncRacePowerupState,
} = require("../../src/services/racePowerupStateSync");

// Box progress is IMMUNE to Leg Cramp + Wrong Turn. The step paths compute a
// debuff-immune box total and pass it to the gate as `boxEffectiveSteps`; the
// gate rolls on THAT, not the debuff-suppressed leaderboard totalSteps. Callers
// that pass no override fall back to the debuff-sensitive value (safe: they
// never follow a step increase, so the fallback can only under-roll).

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

const FROZEN_PARTICIPANT = {
  id: "rp-1",
  userId: "user-1",
  status: "ACCEPTED",
  totalSteps: 5000, // suppressed by a Leg Cramp; leaderboard value
  bonusSteps: 0,
  maxBonusSteps: 0,
  nextBoxAtSteps: 6000,
  powerupSlots: 3,
  finishedAt: null,
  finishTotalSteps: null,
  user: { displayName: "Frozen" },
};

test("gate rolls on the boxEffectiveSteps override even though totalSteps is debuff-suppressed", async () => {
  // Real forward progress (Leg Cramp added back) is 7000 >= next box 6000 -> roll,
  // even though the debuff-sensitive totalSteps (5000) is below the threshold.
  const ctx = makeDeps(FROZEN_PARTICIPANT);

  await ctx.syncRacePowerupState({
    raceId: "race-1",
    userId: "user-1",
    boxEffectiveSteps: 7000,
  });

  assert.equal(ctx.rollCalls.length, 1, "rolls on the immune box total");
  assert.equal(ctx.rollCalls[0].effectiveSteps, 7000, "passes the immune total to rollPowerup");
});

test("without an override, the gate falls back to debuff-sensitive steps (no spurious mint)", async () => {
  // No boxEffectiveSteps passed (e.g. an inventory-action sync). effective falls
  // back to totalSteps 5000 < next box 6000 -> no roll.
  const ctx = makeDeps(FROZEN_PARTICIPANT);

  await ctx.syncRacePowerupState({ raceId: "race-1", userId: "user-1" });

  assert.equal(ctx.rollCalls.length, 0, "fallback can only under-roll, never mint");
});

test("a zero override is honored (not treated as missing)", async () => {
  // boxEffectiveSteps: 0 is a real value, not absence -> 0 < next box -> no roll.
  const ctx = makeDeps({ ...FROZEN_PARTICIPANT, totalSteps: 9000 });

  await ctx.syncRacePowerupState({
    raceId: "race-1",
    userId: "user-1",
    boxEffectiveSteps: 0,
  });

  assert.equal(ctx.rollCalls.length, 0, "explicit 0 override gates, not the 9000 totalSteps");
});
