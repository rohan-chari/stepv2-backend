const assert = require("node:assert/strict");
const test = require("node:test");

// ---------------------------------------------------------------------------
// DISPLAY == SETTLEMENT parity for the global step-multiplier event.
//
// The display path (getRaceProgress) calls computeEffectModifiers directly; the
// settlement path (raceExpiry) calls calculateCurrentTotal, which internally
// calls the SAME computeEffectModifiers. Both must produce identical totals
// when fed the same steps + the same active global events, so standings agree.
//
// This test feeds identical inputs to BOTH entry points and asserts the totals
// match exactly.
// ---------------------------------------------------------------------------

const {
  computeEffectModifiers,
} = require("../../src/modules/races/queries/getRaceProgress");
const {
  calculateCurrentTotal,
} = require("../../src/modules/races/services/raceStateResolution");

const WINDOW_START = "2026-06-02T12:00:00Z";
const WINDOW_END = "2026-06-02T13:00:00Z";
const NOW = new Date("2026-06-02T13:00:00Z");

// Sliced-sum step model shared by both paths.
function makeStepModel(steps) {
  return {
    async sumStepsInWindow(userId, start, end) {
      const ss = new Date(WINDOW_START).getTime();
      const se = new Date(WINDOW_END).getTime();
      const dur = se - ss;
      const os = Math.max(ss, new Date(start).getTime());
      const oe = Math.min(se, new Date(end).getTime());
      const od = oe - os;
      if (od <= 0) return 0;
      return Math.round(steps * (od / dur));
    },
    async findByUserIdAndTimeRange() { return []; },
  };
}

const GLOBAL_EVENTS = [
  {
    startsAt: new Date(WINDOW_START),
    endsAt: new Date(WINDOW_END),
    multiplier: 2,
  },
];

// RUNNERS_HIGH for the first half-hour to exercise multiplicative stacking on
// PART of the window, ensuring both paths slice identically.
const RUNNERS_HIGH = {
  type: "RUNNERS_HIGH",
  startsAt: new Date("2026-06-02T12:00:00Z"),
  expiresAt: new Date("2026-06-02T12:30:00Z"),
  status: "ACTIVE",
  metadata: {},
};

test("getRaceProgress math and raceExpiry math produce identical totals (no powerups, event active)", async () => {
  const steps = 6000;
  const stepModel = makeStepModel(steps);

  // DISPLAY path: replicate getRaceProgress's formula directly.
  const { frozenSteps, buffedSteps, reversedSteps, globalBoostedSteps } =
    await computeEffectModifiers(
      [],
      steps,
      "user-1",
      stepModel,
      true,
      { globalEvents: GLOBAL_EVENTS, now: NOW }
    );
  const displayTotal = Math.max(
    0,
    steps - frozenSteps + buffedSteps - 2 * reversedSteps + (globalBoostedSteps || 0)
  );

  // SETTLEMENT path: calculateCurrentTotal (used by raceExpiry).
  const { total: settlementTotal } = await calculateCurrentTotal({
    raceId: "race-1",
    racePowerupsEnabled: false,
    participant: { id: "rp-1", userId: "user-1", bonusSteps: 0 },
    baseAdjusted: steps,
    hasSampleData: true,
    raceActiveEffectModel: {
      async findEffectsForRaceByType() { return []; },
    },
    stepSampleModel: stepModel,
    globalEvents: GLOBAL_EVENTS,
    now: NOW,
  });

  assert.equal(displayTotal, 12000, "6000 * 2");
  assert.equal(settlementTotal, displayTotal, "display == settlement");
});

test("getRaceProgress math and raceExpiry math match WITH RUNNERS_HIGH stacking", async () => {
  const steps = 6000; // 100/min over the hour
  const stepModel = makeStepModel(steps);

  const effects = [RUNNERS_HIGH];

  // DISPLAY path
  const mods = await computeEffectModifiers(
    effects,
    steps,
    "user-1",
    stepModel,
    true,
    { globalEvents: GLOBAL_EVENTS, now: NOW }
  );
  const displayTotal = Math.max(
    0,
    steps -
      mods.frozenSteps +
      mods.buffedSteps -
      2 * mods.reversedSteps +
      (mods.globalBoostedSteps || 0)
  );

  // SETTLEMENT path
  const { total: settlementTotal } = await calculateCurrentTotal({
    raceId: "race-1",
    racePowerupsEnabled: true,
    participant: { id: "rp-1", userId: "user-1", bonusSteps: 0 },
    baseAdjusted: steps,
    hasSampleData: true,
    raceActiveEffectModel: {
      async findEffectsForRaceByType(raceId, participantId, type) {
        return type === "RUNNERS_HIGH" ? [RUNNERS_HIGH] : [];
      },
    },
    stepSampleModel: stepModel,
    globalEvents: GLOBAL_EVENTS,
    now: NOW,
  });

  // Sanity on the number:
  //   First half (12:00-12:30), 3000 steps: RH 2x AND event 2x => 4x => 12000
  //   Second half (12:30-13:00), 3000 steps: event 2x only => 2x => 6000
  //   total = 18000
  assert.equal(displayTotal, 18000, "3000*4 + 3000*2");
  assert.equal(settlementTotal, displayTotal, "display == settlement with stacking");
});
