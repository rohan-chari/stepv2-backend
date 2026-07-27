const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRollContext,
  eligiblePoolFor,
  positionMultiplierFor,
  typeOddsForPosition,
  rollPowerup,
  normalizePosition,
} = require("../../src/modules/powerups/powerupOdds");
const { validateConfig } = require("../../src/modules/economy/balanceConfig");
const { defaultConfig } = require("../../src/modules/economy/balanceConfig.defaults");

// Unit coverage for the position-aware drop filter (spec §7 tests 11-15). These
// are the five properties the spec explicitly justifies as unit tests: they are
// either enumerations over many positional cases, or structural properties of
// the config validator, neither of which an integration test can express without
// dozens of fixtures.

function seededRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    // xorshift32 — deterministic, good enough for distribution sampling.
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Test 11 — empty-pool guard
// ---------------------------------------------------------------------------

test("eligiblePoolFor falls back to the unfiltered pool when the rules empty a tier", () => {
  const config = defaultConfig();
  config.dropPool.RARE = ["RED_CARD", "SECOND_WIND"];
  config.positionRules.leaderExcluded = ["RED_CARD", "SECOND_WIND"];

  const ctx = buildRollContext({
    stepTotals: [100, 10],
    myTotalSteps: 100,
    position: 1,
    totalParticipants: 2,
  });
  assert.equal(ctx.isStepLeader, true);

  const { pool, weights } = eligiblePoolFor("RARE", ctx, config);
  assert.deepEqual(
    pool,
    ["RED_CARD", "SECOND_WIND"],
    "a tier must never become unreachable — fall back to the unfiltered pool"
  );
  assert.equal(weights.length, pool.length);
  assert.ok(weights.every((w) => Number.isFinite(w) && w >= 0));
});

test("eligiblePoolFor never returns null and always pairs pool with weights", () => {
  const config = defaultConfig();
  const ctx = buildRollContext({
    stepTotals: [5],
    myTotalSteps: 5,
    position: 1,
    totalParticipants: 1,
  });
  for (const rarity of ["COMMON", "UNCOMMON", "RARE"]) {
    const res = eligiblePoolFor(rarity, ctx, config);
    assert.ok(Array.isArray(res.pool) && res.pool.length > 0, `${rarity} pool non-empty`);
    assert.equal(res.weights.length, res.pool.length);
  }
});

// ---------------------------------------------------------------------------
// Test 12 — the roll and the disclosure must not drift
// ---------------------------------------------------------------------------

test("typeOddsForPosition matches the empirical roll distribution at leader / mid / last", () => {
  const config = defaultConfig();
  const total = 5;
  const cases = [
    { label: "leader", position: 1, isStepLeader: true, isStepLast: false },
    { label: "mid", position: 3, isStepLeader: false, isStepLast: false },
    { label: "last", position: 5, isStepLeader: false, isStepLast: true },
  ];

  for (const c of cases) {
    const ctx = {
      normalizedPosition: normalizePosition(c.position, total),
      isStepLeader: c.isStepLeader,
      isStepLast: c.isStepLast,
    };
    const disclosed = typeOddsForPosition(c.position, total, config, ctx);

    const N = 120000;
    const rng = seededRng(0xC0FFEE + c.position);
    const counts = {};
    for (let i = 0; i < N; i++) {
      const { type } = rollPowerup(c.position, total, rng, { config, ctx });
      counts[type] = (counts[type] || 0) + 1;
    }

    // Every disclosed type must be reachable, and every rolled type disclosed.
    for (const type of Object.keys(counts)) {
      assert.ok(
        disclosed[type] !== undefined,
        `${c.label}: rolled ${type} but it is not disclosed`
      );
    }
    for (const [type, p] of Object.entries(disclosed)) {
      const empirical = (counts[type] || 0) / N;
      assert.ok(
        Math.abs(empirical - p) < 0.01,
        `${c.label}: ${type} disclosed ${p.toFixed(4)} but rolled ${empirical.toFixed(4)}`
      );
    }
  }
});

test("typeOddsForPosition leaves the tier totals mathematically unchanged", () => {
  const config = defaultConfig();
  const total = 4;
  for (const position of [1, 2, 3, 4]) {
    for (const ctx of [
      { isStepLeader: true, isStepLast: false },
      { isStepLeader: false, isStepLast: true },
      { isStepLeader: false, isStepLast: false },
    ]) {
      const full = { ...ctx, normalizedPosition: normalizePosition(position, total) };
      const byType = typeOddsForPosition(position, total, config, full);
      const sum = Object.values(byType).reduce((a, b) => a + b, 0);
      assert.ok(
        Math.abs(sum - 1) < 1e-9,
        `byType must still sum to 1 (position ${position}), got ${sum}`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Test 13 — the step predicates
// ---------------------------------------------------------------------------

test("isStepLeader / isStepLast handle ties, singletons and all-equal fields", () => {
  // Tied at the top: BOTH players are step leaders (this is the case a
  // position-index implementation gets wrong).
  const tiedA = buildRollContext({
    stepTotals: [5000, 5000, 100],
    myTotalSteps: 5000,
    position: 1,
    totalParticipants: 3,
  });
  const tiedB = buildRollContext({
    stepTotals: [5000, 5000, 100],
    myTotalSteps: 5000,
    position: 2,
    totalParticipants: 3,
  });
  assert.equal(tiedA.isStepLeader, true);
  assert.equal(tiedB.isStepLeader, true, "sort order among equal totals is arbitrary");
  assert.equal(tiedA.isStepLast, false);

  // Tied at the bottom: both trailing players are "last".
  const bottom = buildRollContext({
    stepTotals: [9000, 10, 10],
    myTotalSteps: 10,
    position: 3,
    totalParticipants: 3,
  });
  assert.equal(bottom.isStepLast, true);
  assert.equal(bottom.isStepLeader, false);

  // Single participant: simultaneously leader and last.
  const solo = buildRollContext({
    stepTotals: [42],
    myTotalSteps: 42,
    position: 1,
    totalParticipants: 1,
  });
  assert.equal(solo.isStepLeader, true);
  assert.equal(solo.isStepLast, true);
  assert.equal(solo.normalizedPosition, 0.5);

  // All-equal field: everyone is both.
  const flat = buildRollContext({
    stepTotals: [0, 0, 0, 0],
    myTotalSteps: 0,
    position: 2,
    totalParticipants: 4,
  });
  assert.equal(flat.isStepLeader, true);
  assert.equal(flat.isStepLast, true);

  // Mid-pack: neither.
  const mid = buildRollContext({
    stepTotals: [900, 500, 100],
    myTotalSteps: 500,
    position: 2,
    totalParticipants: 3,
  });
  assert.equal(mid.isStepLeader, false);
  assert.equal(mid.isStepLast, false);

  // Missing / non-numeric totals default safely rather than throwing.
  const messy = buildRollContext({
    stepTotals: [null, undefined, 10],
    myTotalSteps: undefined,
    position: 1,
    totalParticipants: 3,
  });
  assert.equal(typeof messy.isStepLeader, "boolean");
  assert.equal(typeof messy.isStepLast, "boolean");
});

test("a team-race member of the leading team who is not the step leader is not excluded", () => {
  // Team position collapses to 1-of-2, but the predicates are individual.
  const ctx = buildRollContext({
    stepTotals: [10000, 100, 500, 400],
    myTotalSteps: 100,
    position: 1, // leading TEAM
    totalParticipants: 2,
  });
  assert.equal(ctx.isStepLeader, false, "not the individual step leader");
  const { pool } = eligiblePoolFor("RARE", ctx, defaultConfig());
  assert.ok(pool.includes("RED_CARD"), "Red Card must stay rollable for them");
});

// ---------------------------------------------------------------------------
// Test 14 — down-weight interpolation has no cliff
// ---------------------------------------------------------------------------

test("trailing down-weight is 1.0 at mid-field and ramps monotonically to full strength", () => {
  const config = defaultConfig();
  const from = config.positionRules.trailingDownweightFrom;
  const full = config.positionRules.trailingDownweight.CLEANSE;
  assert.ok(from > 0.5 && from <= 1, "threshold sits behind mid-field");
  assert.ok(full > 0 && full < 1, "a down-weight is a tilt, never a removal");

  const at = (t) => positionMultiplierFor("CLEANSE", { normalizedPosition: t }, config);

  assert.equal(at(0.5), 1, "no effect at mid-field");
  assert.equal(at(0), 1, "no trailing effect at the front");
  assert.ok(Math.abs(at(from) - full) < 1e-9, "full strength at the threshold");
  assert.ok(Math.abs(at(1) - full) < 1e-9, "stays at full strength beyond it");

  let previous = at(0.5);
  for (let t = 0.5; t <= 1.0001; t += 0.01) {
    const value = at(t);
    assert.ok(value <= previous + 1e-9, `multiplier must not increase at t=${t.toFixed(2)}`);
    assert.ok(value >= full - 1e-9 && value <= 1 + 1e-9, `multiplier in range at t=${t.toFixed(2)}`);
    previous = value;
  }
});

test("leading down-weight ramps in the opposite direction", () => {
  const config = defaultConfig();
  const from = config.positionRules.leadingDownweightFrom;
  const full = config.positionRules.leadingDownweight.RUNNERS_HIGH;
  assert.ok(from < 0.5 && from >= 0, "threshold sits ahead of mid-field");
  assert.ok(full > 0 && full < 1);

  const at = (t) => positionMultiplierFor("RUNNERS_HIGH", { normalizedPosition: t }, config);

  assert.equal(at(0.5), 1, "no effect at mid-field");
  assert.equal(at(1), 1, "no leading effect at the back");
  assert.ok(Math.abs(at(from) - full) < 1e-9, "full strength at the threshold");
  assert.ok(Math.abs(at(0) - full) < 1e-9, "stays at full strength ahead of it");

  let previous = at(0.5);
  for (let t = 0.5; t >= -0.0001; t -= 0.01) {
    const value = at(Math.max(0, t));
    assert.ok(value <= previous + 1e-9, `multiplier must not increase at t=${t.toFixed(2)}`);
    previous = value;
  }
});

test("a type in neither down-weight list is never scaled", () => {
  const config = defaultConfig();
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    assert.equal(positionMultiplierFor("PROTEIN_SHAKE", { normalizedPosition: t }, config), 1);
  }
});

test("cleared positionRules restore exactly the pre-change weights", () => {
  const config = defaultConfig();
  config.positionRules = {
    leaderExcluded: [],
    lastPlaceExcluded: [],
    leadingDownweight: {},
    trailingDownweight: {},
    leadingDownweightFrom: 0.4,
    trailingDownweightFrom: 0.6,
  };
  const ctx = buildRollContext({
    stepTotals: [100, 1],
    myTotalSteps: 100,
    position: 1,
    totalParticipants: 2,
  });
  const { pool, weights } = eligiblePoolFor("RARE", ctx, config);
  assert.deepEqual(pool, config.dropPool.RARE);
  assert.equal(weights[pool.indexOf("RED_CARD")], config.typeWeights.RED_CARD);
});

// ---------------------------------------------------------------------------
// Test 15 — config validation rejects overlap across the four lists
// ---------------------------------------------------------------------------

test("validateConfig accepts the shipped positionRules block", () => {
  const errors = validateConfig(defaultConfig());
  assert.deepEqual(errors, []);
});

test("validateConfig rejects a type appearing in more than one positionRules list", () => {
  const pairs = [
    ["leaderExcluded", "leadingDownweight"],
    ["leaderExcluded", "lastPlaceExcluded"],
    ["lastPlaceExcluded", "trailingDownweight"],
    ["leadingDownweight", "trailingDownweight"],
  ];
  for (const [a, b] of pairs) {
    const config = defaultConfig();
    config.positionRules = {
      leaderExcluded: [],
      lastPlaceExcluded: [],
      leadingDownweight: {},
      trailingDownweight: {},
      leadingDownweightFrom: 0.4,
      trailingDownweightFrom: 0.6,
    };
    const put = (key) => {
      if (key.endsWith("Excluded")) config.positionRules[key] = ["MIRROR"];
      else config.positionRules[key] = { MIRROR: 0.5 };
    };
    put(a);
    put(b);
    const errors = validateConfig(config);
    assert.ok(
      errors.some((e) => String(e.path).startsWith("positionRules")),
      `MIRROR in both ${a} and ${b} must be rejected`
    );
  }
});

test("validateConfig rejects unknown types and bad shapes inside positionRules", () => {
  const base = () => {
    const config = defaultConfig();
    config.positionRules = {
      leaderExcluded: [],
      lastPlaceExcluded: [],
      leadingDownweight: {},
      trailingDownweight: {},
      leadingDownweightFrom: 0.4,
      trailingDownweightFrom: 0.6,
    };
    return config;
  };

  const badType = base();
  badType.positionRules.leaderExcluded = ["NOT_A_POWERUP"];
  assert.ok(validateConfig(badType).some((e) => String(e.path).startsWith("positionRules")));

  const badWeight = base();
  badWeight.positionRules.trailingDownweight = { MIRROR: -1 };
  assert.ok(validateConfig(badWeight).some((e) => String(e.path).startsWith("positionRules")));

  const badThreshold = base();
  badThreshold.positionRules.trailingDownweightFrom = 2;
  assert.ok(validateConfig(badThreshold).some((e) => String(e.path).startsWith("positionRules")));

  const badShape = base();
  badShape.positionRules.leaderExcluded = "RED_CARD";
  assert.ok(validateConfig(badShape).some((e) => String(e.path).startsWith("positionRules")));
});
