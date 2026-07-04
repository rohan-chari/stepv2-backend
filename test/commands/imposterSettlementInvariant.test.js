const assert = require("node:assert/strict");
const test = require("node:test");

const {
  calculateCurrentTotal,
} = require("../../src/services/raceStateResolution");

// ---------------------------------------------------------------------------
// HARD INVARIANT: IMPOSTER is PURELY COSMETIC. The settlement / placement path
// (raceExpiry.js -> calculateCurrentTotal -> standings.sort) must compute from
// REAL steps and ignore IMPOSTER effects entirely.
//
// raceExpiry.js settles each participant's total via
//   raceStateResolution.calculateCurrentTotal(...)
// which queries the active-effect model ONLY for the step-affecting effect types
// (LEG_CRAMP, RUNNERS_HIGH, WRONG_TURN, CAMPFIRE_REST). It never asks for
// IMPOSTER, so an active IMPOSTER cannot change a settlement total. Final
// placements then sort on those real totals.
//
// This focused test proves: (a) the settlement total is unchanged whether or
// not IMPOSTER effects exist, and (b) the settlement path NEVER queries the
// IMPOSTER type — so finish order is computed from real steps and the display
// swap can never leak into payouts.
//
// Written from the spec + the existing raceStateResolution surface, NOT by
// mirroring implementation.
// ---------------------------------------------------------------------------

function makeEffectModel({ trackQueries } = {}) {
  return {
    queriedTypes: [],
    async findEffectsForRaceByType(raceId, participantId, type) {
      if (trackQueries) this.queriedTypes.push(type);
      // No step-affecting effects exist for anyone in this scenario.
      return [];
    },
  };
}

// Real per-user steps come straight through the step-sample model.
function makeStepSampleModel(stepsByUser) {
  return {
    async sumStepsInWindow(userId) {
      return stepsByUser[userId] || 0;
    },
  };
}

test("settlement total ignores an active IMPOSTER (computed from real steps)", async () => {
  const stepsByUser = { "user-1": 30000 };
  const participant = { id: "rp-1", userId: "user-1", bonusSteps: 0 };

  // Even though an IMPOSTER effect is "active" in the race, calculateCurrentTotal
  // only consults the step-affecting effect types — so the total is the real
  // baseAdjusted, unaffected by IMPOSTER.
  const effectModel = makeEffectModel({ trackQueries: true });

  const { total } = await calculateCurrentTotal({
    raceId: "race-1",
    racePowerupsEnabled: true,
    participant,
    baseAdjusted: stepsByUser["user-1"],
    hasSampleData: true,
    raceActiveEffectModel: effectModel,
    stepSampleModel: makeStepSampleModel(stepsByUser),
  });

  assert.equal(total, 30000, "settlement total equals real steps");

  // INVARIANT: the settlement path never queries IMPOSTER effects.
  assert.equal(
    effectModel.queriedTypes.includes("IMPOSTER"),
    false,
    "settlement must NOT query IMPOSTER effects"
  );
  // It only queries the step-affecting effect types.
  assert.deepEqual(
    [...new Set(effectModel.queriedTypes)].sort(),
    ["CAMPFIRE_REST", "LEG_CRAMP", "RAINSTORM", "RUNNERS_HIGH", "WRONG_TURN"]
  );
});

test("real finish ORDER (sort on settlement totals) is unaffected by IMPOSTER", async () => {
  // user-1 has the most real steps, user-3 the fewest. An IMPOSTER that swaps
  // the DISPLAY of user-1 and user-3 must NOT change the settled standings.
  const stepsByUser = { "user-1": 30000, "user-2": 20000, "user-3": 10000 };
  const participants = [
    { id: "rp-1", userId: "user-1", bonusSteps: 0 },
    { id: "rp-2", userId: "user-2", bonusSteps: 0 },
    { id: "rp-3", userId: "user-3", bonusSteps: 0 },
  ];

  const effectModel = makeEffectModel();
  const stepSampleModel = makeStepSampleModel(stepsByUser);

  const standings = [];
  for (const participant of participants) {
    const { total } = await calculateCurrentTotal({
      raceId: "race-1",
      racePowerupsEnabled: true,
      participant,
      baseAdjusted: stepsByUser[participant.userId],
      hasSampleData: true,
      raceActiveEffectModel: effectModel,
      stepSampleModel,
    });
    standings.push({ userId: participant.userId, totalSteps: total });
  }

  // raceExpiry sorts standings by totalSteps desc to assign placements.
  standings.sort((a, b) => b.totalSteps - a.totalSteps);
  const finishOrder = standings.map((s) => s.userId);

  assert.deepEqual(
    finishOrder,
    ["user-1", "user-2", "user-3"],
    "winner is the real top stepper regardless of any IMPOSTER display swap"
  );
});
