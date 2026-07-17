const assert = require("node:assert/strict");
const test = require("node:test");

// ---------------------------------------------------------------------------
// LEECH scoring math (Item 2). A LEECH effect on victim V, sourced by leecher S,
// removes one step from V per step S accrues during the leech window
// [startsAt, expiresAt], capped at 3000 per leech. Unlike rainstorm it keys off
// the SOURCE user's step history, so a leecher who doesn't walk drains nothing.
// It is folded into frozenSteps (a plain subtraction) and the total floors at 0.
// The SAME computeEffectModifiers drives display AND settlement, so a settlement
// re-check (calculateCurrentTotal) must agree with the display math.
// ---------------------------------------------------------------------------

const { computeEffectModifiers } = require("../../src/queries/getRaceProgress");
const { calculateCurrentTotal } = require("../../src/services/raceStateResolution");

const T0 = new Date("2026-07-17T12:00:00Z");
const T1 = new Date("2026-07-17T12:30:00Z"); // 30-min window end

// Per-user uniform-rate step model over [T0, T1].
function makeStepModel(stepsByUser) {
  return {
    async sumStepsInWindow(userId, start, end) {
      const steps = stepsByUser[userId] || 0;
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

function leech(sourceUserId, overrides = {}) {
  return {
    type: "LEECH",
    startsAt: T0,
    expiresAt: T1,
    status: "ACTIVE",
    sourceUserId,
    targetUserId: "victim",
    metadata: { cap: 3000 },
    ...overrides,
  };
}

// Compute victim's total given a set of effects + a step model keyed by user.
async function victimTotal(effects, victimSteps, stepsByUser) {
  const { frozenSteps, buffedSteps, reversedSteps } = await computeEffectModifiers(
    effects,
    victimSteps,
    "victim",
    makeStepModel({ victim: victimSteps, ...stepsByUser }),
    true
  );
  return Math.max(0, victimSteps - frozenSteps + buffedSteps - 2 * reversedSteps);
}

test("leech removes exactly the leecher's in-window steps from the victim", async () => {
  // Leecher walked 2000 in the window; victim had 10000. -> 8000.
  const total = await victimTotal([leech("leecher")], 10000, { leecher: 2000 });
  assert.equal(total, 8000);
});

test("leech is capped at 3000 steps removed per leech", async () => {
  // Leecher walked 9000 in the window, but the cap is 3000. 10000 - 3000 = 7000.
  const total = await victimTotal([leech("leecher")], 10000, { leecher: 9000 });
  assert.equal(total, 7000);
});

test("a leecher who doesn't walk drains nothing", async () => {
  const total = await victimTotal([leech("leecher")], 10000, { leecher: 0 });
  assert.equal(total, 10000);
});

test("two leechers stack (each capped), and the total floors at 0", async () => {
  // Two leechers each walk 9000 -> each capped to 3000 -> -6000. Victim 5000.
  const effects = [leech("leecher-a"), leech("leecher-b")];
  const total = await victimTotal(effects, 5000, { "leecher-a": 9000, "leecher-b": 9000 });
  assert.equal(total, 0, "5000 - 3000 - 3000 clamps at 0, never negative");
});

test("only the rained/leeched portion of the leecher's steps counts (partial window)", async () => {
  // Leech window ends halfway; leecher's rate yields 1000 steps in the half-window.
  const halfway = new Date("2026-07-17T12:15:00Z");
  const effects = [leech("leecher", { expiresAt: halfway })];
  // leecher would walk 2000 over the full window -> 1000 over the half.
  const total = await victimTotal(effects, 10000, { leecher: 2000 });
  assert.equal(total, 9000);
});

test("settlement (calculateCurrentTotal) matches the display math for leech", async () => {
  const stepsByUser = { victim: 10000, leecher: 2000 };
  const l = leech("leecher");
  const effectModel = {
    // Bulk fetch is what production uses; include LEECH so settlement scores it.
    async findEffectsForRaceByTypes(raceId, participantId, types) {
      const byType = {};
      for (const t of types) byType[t] = [];
      if (types.includes("LEECH")) byType.LEECH = [l];
      return byType;
    },
  };
  const { total } = await calculateCurrentTotal({
    raceId: "race-1",
    racePowerupsEnabled: true,
    participant: { id: "rp-v", userId: "victim", bonusSteps: 0 },
    baseAdjusted: stepsByUser.victim,
    hasSampleData: true,
    raceActiveEffectModel: effectModel,
    stepSampleModel: makeStepModel(stepsByUser),
  });
  assert.equal(total, 8000);
  assert.equal(total, await victimTotal([l], 10000, { leecher: 2000 }));
});
