const assert = require("node:assert/strict");
const test = require("node:test");

// ---------------------------------------------------------------------------
// signedMultiplierAt — the pure signed effective multiplier m(t) (buff-stacking
// spec §3). This is the "pure algorithmic math with many cases" exception where
// a unit truth-table is the right tool; the behavior is ALSO proven end-to-end
// in test/integration/buff-stacking-event-scoring.test.js.
// ---------------------------------------------------------------------------

const {
  signedMultiplierAt,
  multiplierBoundaries,
} = require("../../src/modules/races/services/effectMultiplier");

// Windowed effect helpers. Times are epoch ms; T is an arbitrary anchor.
const T = 1_000_000;
const win = (extra = {}) => ({ startsAt: new Date(T), expiresAt: new Date(T + 100), ...extra });
const rh = () => win();
const up = (mult) => win({ metadata: mult === undefined ? {} : { multiplier: mult } });
const rally = (mult) => win({ metadata: mult === undefined ? {} : { multiplier: mult } });
const coinWin = (mult) => win({ metadata: { multiplier: mult } });
const coinLose = (mult) => win({ metadata: { multiplier: mult } });
const rain = (mult) => win({ metadata: mult === undefined ? {} : { multiplier: mult } });
const wt = () => win();
const legCramp = () => win();
// Campfire: freeze [start, start+freezeMs), boost [start+freezeMs, expiresAt).
const campfire = (mult, freezeMs = 30) =>
  ({ startsAt: new Date(T), expiresAt: new Date(T + 100), metadata: { multiplier: mult, freezeMs } });
// Ghost pepper: boost [start, start+boostMs), freeze [start+boostMs, expiresAt).
const ghost = (mult, boostMs = 50) =>
  ({ startsAt: new Date(T), expiresAt: new Date(T + 100), metadata: { multiplier: mult, boostMs } });

const AT = T + 10; // an instant inside the boost / active phase of the above

test("§3 truth table — the worked-example rows", () => {
  assert.equal(signedMultiplierAt(AT, {}), 1, "nothing → 1");
  assert.equal(signedMultiplierAt(AT, { ghostPeppers: [ghost(3)] }), 3, "pepper boost → 3");
  assert.equal(
    signedMultiplierAt(AT, { ghostPeppers: [ghost(3)], runnersHighs: [rh()] }),
    5,
    "pepper + RH → 5 (sum)"
  );
  assert.equal(
    signedMultiplierAt(AT, { ghostPeppers: [ghost(3)], runnersHighs: [rh()], wrongTurns: [wt()] }),
    -5,
    "pepper + RH + WT → −5"
  );
  assert.equal(signedMultiplierAt(AT, { wrongTurns: [wt()] }), -1, "WT alone → −1");
  // Pepper freeze phase (instant in the freeze half).
  assert.equal(signedMultiplierAt(T + 60, { ghostPeppers: [ghost(3, 50)] }), 0, "pepper freeze → 0");
  assert.equal(
    signedMultiplierAt(T + 60, { ghostPeppers: [ghost(3, 50)], wrongTurns: [wt()] }),
    0,
    "freeze + WT → 0 (freeze beats WT)"
  );
  assert.equal(
    signedMultiplierAt(AT, { runnersHighs: [rh()], uprisings: [up(2)], ghostPeppers: [ghost(3)] }),
    7,
    "RH + Uprising(2) + Pepper(3) → 7 (true 3-way sum)"
  );
  assert.equal(
    signedMultiplierAt(T + 40, { campfires: [campfire(2.25, 30)], runnersHighs: [rh()] }),
    4.25,
    "campfire boost 2.25 + RH → 4.25"
  );
  assert.equal(signedMultiplierAt(AT, { rainstorms: [rain(0.5)] }), 0.5, "rainstorm 0.5 → 0.5");
  assert.equal(
    signedMultiplierAt(AT, { rainstorms: [rain(0.5)], runnersHighs: [rh()] }),
    1.5,
    "RH + rainstorm → 1.5"
  );
});

test("freeze precedence: Leg Cramp / Campfire freeze beat every buff and WT", () => {
  assert.equal(signedMultiplierAt(AT, { legCramps: [legCramp()], runnersHighs: [rh()] }), 0);
  assert.equal(signedMultiplierAt(AT, { legCramps: [legCramp()], wrongTurns: [wt()] }), 0);
  assert.equal(signedMultiplierAt(T + 10, { campfires: [campfire(2.25, 30)], runnersHighs: [rh()] }), 0, "campfire freeze half");
});

test("phase edges at exact boundary instants", () => {
  const g = ghost(3, 50); // boost [T, T+50), freeze [T+50, T+100)
  assert.equal(signedMultiplierAt(T, { ghostPeppers: [g] }), 3, "boost starts at start (inclusive)");
  assert.equal(signedMultiplierAt(T + 49, { ghostPeppers: [g] }), 3, "still boost just before transition");
  assert.equal(signedMultiplierAt(T + 50, { ghostPeppers: [g] }), 0, "freeze starts at start+boostMs (inclusive)");
  assert.equal(signedMultiplierAt(T + 100, { ghostPeppers: [g] }), 1, "inactive at expiresAt (exclusive)");

  const c = campfire(2.25, 30); // freeze [T, T+30), boost [T+30, T+100)
  assert.equal(signedMultiplierAt(T, { campfires: [c] }), 0, "freeze at start");
  assert.equal(signedMultiplierAt(T + 29, { campfires: [c] }), 0, "freeze just before boost");
  assert.equal(signedMultiplierAt(T + 30, { campfires: [c] }), 2.25, "boost at start+freezeMs");
  assert.equal(signedMultiplierAt(T + 100, { campfires: [c] }), 1, "inactive at expiresAt");

  const r = rh(); // active [T, T+100)
  assert.equal(signedMultiplierAt(T - 1, { runnersHighs: [r] }), 1, "before start");
  assert.equal(signedMultiplierAt(T, { runnersHighs: [r] }), 2, "at start (inclusive)");
  assert.equal(signedMultiplierAt(T + 100, { runnersHighs: [r] }), 1, "at expiresAt (exclusive)");
});

test("reductions clamp at a single 0.5 across overlapping storms / storm+coinflip", () => {
  assert.equal(signedMultiplierAt(AT, { rainstorms: [rain(0.5), rain(0.5)] }), 0.5, "two storms → single 0.5");
  assert.equal(
    signedMultiplierAt(AT, { rainstorms: [rain(0.5)], coinFlipLoses: [coinLose(0.5)] }),
    0.5,
    "storm + coin-flip lose → single 0.5"
  );
  assert.equal(signedMultiplierAt(AT, { coinFlipLoses: [coinLose(0.5)] }), 0.5, "coin-flip lose alone → 0.5");
});

test("Wrong Turn negates the reduced rate, and buffs+reductions together", () => {
  // RH(2) − rain(0.5) = 1.5, WT negates → −1.5.
  assert.equal(
    signedMultiplierAt(AT, { runnersHighs: [rh()], rainstorms: [rain(0.5)], wrongTurns: [wt()] }),
    -1.5
  );
});

test("invalid / missing metadata falls back to canonical multipliers", () => {
  assert.equal(signedMultiplierAt(AT, { uprisings: [up(undefined)] }), 2, "uprising default 2");
  assert.equal(signedMultiplierAt(AT, { rallyFlags: [rally(undefined)] }), 1.25, "rally default 1.25");
  assert.equal(signedMultiplierAt(AT, { ghostPeppers: [ghost(undefined)] }), 3, "pepper default 3");
  assert.equal(signedMultiplierAt(AT, { coinFlipWins: [coinWin(NaN)] }), 2, "coin win default 2");
  assert.equal(signedMultiplierAt(AT, { rainstorms: [rain("wat")] }), 0.5, "rain default lose 0.5");
  assert.equal(signedMultiplierAt(AT, { rainstorms: [rain(5)] }), 0.5, "out-of-range rain → 0.5 lost");
});

test("umbrella pre-adjustment is the caller's job: an empty rainstorms slot means no penalty", () => {
  // signedMultiplierAt trusts that the caller already removed umbrella-covered
  // spans from the rainstorms it passes in. With none passed, m stays 1.
  assert.equal(signedMultiplierAt(AT, { rainstorms: [] }), 1);
});

test("multiplierBoundaries emits every phase edge inside the window, sorted & deduped", () => {
  const groups = {
    runnersHighs: [rh()],
    campfires: [campfire(2.25, 30)],
    ghostPeppers: [ghost(3, 50)],
  };
  const bounds = multiplierBoundaries(T - 10, T + 200, groups);
  // Expect: window ends (T-10, T+200), effect starts (T), campfire freeze->boost
  // (T+30), pepper boost->freeze (T+50), effect expiries (T+100).
  for (const b of [T - 10, T, T + 30, T + 50, T + 100, T + 200]) {
    assert.ok(bounds.includes(b), `boundary ${b} present`);
  }
  const sorted = [...bounds].sort((a, b) => a - b);
  assert.deepEqual(bounds, sorted, "sorted ascending");
  assert.equal(new Set(bounds).size, bounds.length, "deduped");
});
