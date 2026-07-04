const assert = require("node:assert/strict");
const test = require("node:test");

// ---------------------------------------------------------------------------
// RAINSTORM scoring math.
//
// A RAINSTORM effect is an ADDITIVE -0.5x on step accrual during its window
// (folded into frozenSteps by computeEffectModifiers):
//   * rain only:               1x - 0.5x = 0.5x
//   * rain + Runner's High:    1x + 1x - 0.5x = 1.5x  (stays additive)
//   * rain + Leg Cramp:        0x (freeze dominates; rain penalty SUSPENDED so
//                              frozen steps can never go negative)
//   * rain + Wrong Turn:       -1x (reversal dominates; rain suspended)
// multiplierForTime (finish-time interpolation) must agree with these exact
// values so live totals and finish snapshots never diverge.
// ---------------------------------------------------------------------------

const { computeEffectModifiers } = require("../../src/queries/getRaceProgress");
const { calculateCurrentTotal } = require("../../src/services/raceStateResolution");

const T0 = new Date("2026-07-04T12:00:00Z");
const T1 = new Date("2026-07-04T13:00:00Z");

// Uniform-rate step model: `steps` spread evenly over [T0, T1].
function makeStepModel(steps) {
  return {
    async sumStepsInWindow(userId, start, end) {
      const ss = T0.getTime();
      const se = T1.getTime();
      const os = Math.max(ss, new Date(start).getTime());
      const oe = Math.min(se, new Date(end).getTime());
      if (oe <= os) return 0;
      return Math.round(steps * ((oe - os) / (se - ss)));
    },
    async findByUserIdAndTimeRange() { return []; },
  };
}

function effect(type, overrides = {}) {
  return {
    type,
    startsAt: T0,
    expiresAt: T1,
    status: "ACTIVE",
    metadata: { multiplier: type === "RAINSTORM" ? 0.5 : undefined },
    ...overrides,
  };
}

async function totalFor(effects, steps) {
  const { frozenSteps, buffedSteps, reversedSteps } = await computeEffectModifiers(
    effects,
    steps,
    "user-1",
    makeStepModel(steps),
    true
  );
  return Math.max(0, steps - frozenSteps + buffedSteps - 2 * reversedSteps);
}

test("rain alone halves steps in the window", async () => {
  assert.equal(await totalFor([effect("RAINSTORM")], 6000), 3000);
});

test("rain multiplier defaults to 0.5 when metadata is missing/malformed", async () => {
  assert.equal(
    await totalFor([effect("RAINSTORM", { metadata: {} })], 6000),
    3000
  );
  assert.equal(
    await totalFor([effect("RAINSTORM", { metadata: { multiplier: "wat" } })], 6000),
    3000
  );
});

test("rain + Runner's High stays additive: 1.5x", async () => {
  const effects = [effect("RAINSTORM"), effect("RUNNERS_HIGH")];
  assert.equal(await totalFor(effects, 6000), 9000);
});

test("rain is suspended during a Leg Cramp: frozen steps stay 0, never negative", async () => {
  const effects = [effect("RAINSTORM"), effect("LEG_CRAMP")];
  assert.equal(await totalFor(effects, 6000), 0);
});

test("rain is suspended during a Wrong Turn: reversal stays exactly -1x", async () => {
  const effects = [effect("RAINSTORM"), effect("WRONG_TURN")];
  // base 6000 - reversed(2*6000) = -6000 → clamped to 0
  assert.equal(await totalFor(effects, 6000), 0);
});

test("partial-window rain only penalizes the rained half", async () => {
  const halfway = new Date("2026-07-04T12:30:00Z");
  const rain = effect("RAINSTORM", { expiresAt: halfway });
  // 3000 steps fall in the rain window → lose 1500; other 3000 untouched.
  assert.equal(await totalFor([rain], 6000), 4500);
});

test("settlement path (calculateCurrentTotal) matches the display math for rain", async () => {
  const steps = 6000;
  const rain = effect("RAINSTORM");
  const effectModel = {
    async findEffectsForRaceByType(raceId, participantId, type) {
      return type === "RAINSTORM" ? [rain] : [];
    },
  };
  const { total } = await calculateCurrentTotal({
    raceId: "race-1",
    racePowerupsEnabled: true,
    participant: { id: "rp-1", userId: "user-1", bonusSteps: 0 },
    baseAdjusted: steps,
    hasSampleData: true,
    raceActiveEffectModel: effectModel,
    stepSampleModel: makeStepModel(steps),
  });
  assert.equal(total, await totalFor([rain], steps));
  assert.equal(total, 3000);
});
