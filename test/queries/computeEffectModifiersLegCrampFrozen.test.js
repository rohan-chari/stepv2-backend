const assert = require("node:assert/strict");
const test = require("node:test");

const { computeEffectModifiers } = require("../../src/queries/getRaceProgress");

// computeEffectModifiers must return legCrampFrozenSteps = the Leg-Cramp-only
// slice of frozenSteps, so box progress can be made immune to Leg Cramp WITHOUT
// also exempting Campfire Rest's self-imposed freeze (which still counts).

const legCrampStart = new Date("2026-06-04T10:00:00Z");
const legCrampEnd = new Date("2026-06-04T10:30:00Z");
const campStart = new Date("2026-06-04T11:00:00Z");
const FREEZE_MS = 10 * 60 * 1000;
const campEnd = new Date("2026-06-04T11:40:00Z");

function makeStepSampleModel() {
  return {
    async sumStepsInWindow(_userId, start) {
      const s = start.getTime();
      if (s === legCrampStart.getTime()) return 300; // Leg Cramp frozen window
      if (s === campStart.getTime()) return 100; // Campfire freeze window
      return 0; // Campfire boost window etc.
    },
  };
}

test("legCrampFrozenSteps isolates the Leg-Cramp slice from Campfire freeze", async () => {
  const effects = [
    {
      type: "LEG_CRAMP",
      startsAt: legCrampStart,
      expiresAt: legCrampEnd,
      status: "EXPIRED",
      metadata: {},
    },
    {
      type: "CAMPFIRE_REST",
      startsAt: campStart,
      expiresAt: campEnd,
      status: "EXPIRED",
      metadata: { freezeMs: FREEZE_MS, multiplier: 2 },
    },
  ];

  const res = await computeEffectModifiers(
    effects,
    5000,
    "user-1",
    makeStepSampleModel(),
    true, // hasSampleData -> use the sample path
    null
  );

  assert.equal(res.legCrampFrozenSteps, 300, "only the Leg-Cramp window counts");
  assert.equal(res.frozenSteps, 400, "frozenSteps still includes Campfire freeze (300 + 100)");
});

test("no Leg Cramp => legCrampFrozenSteps is 0 while Campfire still freezes", async () => {
  const effects = [
    {
      type: "CAMPFIRE_REST",
      startsAt: campStart,
      expiresAt: campEnd,
      status: "EXPIRED",
      metadata: { freezeMs: FREEZE_MS, multiplier: 2 },
    },
  ];

  const res = await computeEffectModifiers(
    effects,
    5000,
    "user-1",
    makeStepSampleModel(),
    true,
    null
  );

  assert.equal(res.legCrampFrozenSteps, 0);
  assert.equal(res.frozenSteps, 100, "Campfire freeze still subtracts from the leaderboard total");
});
