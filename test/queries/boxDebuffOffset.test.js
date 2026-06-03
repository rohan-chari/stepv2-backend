const assert = require("node:assert/strict");
const test = require("node:test");

const {
  computeEffectModifiers,
  computeBoxDebuffOffset,
} = require("../../src/queries/getRaceProgress");

// The mystery-box offset neutralizes ONLY Leg Cramp (freeze) and Wrong Turn
// (reverse). Campfire Rest also freezes steps (feeds frozenSteps) but must NOT
// be re-credited for box progress, so computeEffectModifiers exposes a separate
// `legCrampFrozenSteps` slice and computeBoxDebuffOffset uses only that + the
// Wrong-Turn reversal.

test("computeBoxDebuffOffset = legCrampFrozenSteps + 2*reversedSteps", () => {
  assert.equal(computeBoxDebuffOffset({ legCrampFrozenSteps: 1000, reversedSteps: 200 }), 1400);
  assert.equal(computeBoxDebuffOffset({ legCrampFrozenSteps: 0, reversedSteps: 0 }), 0);
  assert.equal(computeBoxDebuffOffset({}), 0);
  // Defensive: never negative.
  assert.equal(computeBoxDebuffOffset({ legCrampFrozenSteps: -5, reversedSteps: -3 }), 0);
});

test("legCrampFrozenSteps excludes Campfire Rest's freeze; offset ignores Campfire", async () => {
  const T1 = new Date("2026-06-03T10:00:00.000Z"); // Leg Cramp start
  const T2 = new Date("2026-06-03T11:00:00.000Z"); // Campfire start
  const T2_FREEZE_END = new Date("2026-06-03T11:10:00.000Z");
  const T3 = new Date("2026-06-03T12:00:00.000Z"); // Wrong Turn start
  const EXP = new Date("2026-06-03T13:00:00.000Z");

  // Return sample steps keyed by the window START so each effect's window is
  // distinguishable.
  const byStart = {
    [T1.getTime()]: 1000, // Leg Cramp froze 1000
    [T2.getTime()]: 500, // Campfire froze 500 (must be excluded from the offset)
    [T2_FREEZE_END.getTime()]: 0, // Campfire boost phase: no steps
    [T3.getTime()]: 200, // Wrong Turn reversed 200
  };
  const stepSampleModel = {
    async sumStepsInWindow(_userId, windowStart) {
      return byStart[new Date(windowStart).getTime()] || 0;
    },
  };

  const effects = [
    { type: "LEG_CRAMP", startsAt: T1, expiresAt: EXP, status: "ACTIVE", metadata: {} },
    {
      type: "CAMPFIRE_REST",
      startsAt: T2,
      expiresAt: EXP,
      status: "ACTIVE",
      metadata: { freezeMs: 10 * 60 * 1000, multiplier: 2 },
    },
    { type: "WRONG_TURN", startsAt: T3, expiresAt: EXP, status: "ACTIVE", metadata: {} },
  ];

  const { frozenSteps, reversedSteps, legCrampFrozenSteps } = await computeEffectModifiers(
    effects,
    0,
    "user-1",
    stepSampleModel,
    true
  );

  assert.equal(frozenSteps, 1500, "frozenSteps still includes Campfire (1000 + 500)");
  assert.equal(legCrampFrozenSteps, 1000, "legCrampFrozenSteps excludes Campfire's 500");
  assert.equal(reversedSteps, 200);

  const offset = computeBoxDebuffOffset({ legCrampFrozenSteps, reversedSteps });
  assert.equal(offset, 1400, "1000 (Leg Cramp) + 2*200 (Wrong Turn); Campfire excluded");
});
