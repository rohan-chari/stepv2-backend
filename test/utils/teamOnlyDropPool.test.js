const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRollContext,
  eligiblePoolFor,
  pickTypeForRarity,
  typeOddsForPosition,
  RARITY_ORDER,
} = require("../../src/modules/powerups/powerupOdds");
const {
  validateConfig,
  mergeOverDefaults,
} = require("../../src/modules/economy/balanceConfig");
const { defaultConfig } = require("../../src/modules/economy/balanceConfig.defaults");

// Unit coverage for the team-only drop pool
// (docs/team-only-drop-pool-requirements.md §9 tests 8, 9, 11, 12, 13).
//
// These five are the ones the spec justifies as unit tests: a 2x2xTier
// enumeration, a structural property of the fallback ordering, validator
// behaviour, and a parity assertion between two pure functions given identical
// input. The behaviour a player actually experiences is proved end-to-end in
// test/integration/team-only-drop-pool.test.js.

function seededRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// A neutral mid-pack context with the two new dimensions dialled in. Position
// rules are irrelevant to these tests, so mid-field keeps them inert.
function ctxFor({ isTeamRace, supportsPowerups5 }) {
  return buildRollContext({
    stepTotals: [100, 50, 10],
    myTotalSteps: 50,
    position: 2,
    totalParticipants: 3,
    isTeamRace,
    supportsPowerups5,
  });
}

// RALLY_FLAG droppable in every tier, so the 2x2 can be asserted per tier
// without depending on which tier the shipped defaults put it in.
function configWithFlagEverywhere() {
  const config = defaultConfig();
  config.teamOnlyTypes = ["RALLY_FLAG"];
  config.storeOnlyTypes = config.storeOnlyTypes.filter((t) => t !== "RALLY_FLAG");
  config.dropPool = {
    COMMON: ["PROTEIN_SHAKE", "RALLY_FLAG"],
    UNCOMMON: ["STEALTH_MODE", "RALLY_FLAG"],
    RARE: ["COMPRESSION_SOCKS", "RALLY_FLAG"],
  };
  config.typeWeights = {};
  config.positionRules = {
    leaderExcluded: [],
    lastPlaceExcluded: [],
    leadingDownweight: {},
    trailingDownweight: {},
    leadingDownweightFrom: 0.4,
    trailingDownweightFrom: 0.6,
  };
  return config;
}

// ---------------------------------------------------------------------------
// Test 8 — the 2x2 of (team/solo) x (powerups5/not), per tier.
// ---------------------------------------------------------------------------

test("eligiblePoolFor: RALLY_FLAG survives only for a powerups5 client in a team race", () => {
  const config = configWithFlagEverywhere();

  const cases = [
    { isTeamRace: true, supportsPowerups5: true, expected: true },
    { isTeamRace: true, supportsPowerups5: false, expected: false },
    { isTeamRace: false, supportsPowerups5: true, expected: false },
    { isTeamRace: false, supportsPowerups5: false, expected: false },
  ];

  for (const { isTeamRace, supportsPowerups5, expected } of cases) {
    const ctx = ctxFor({ isTeamRace, supportsPowerups5 });
    for (const rarity of RARITY_ORDER) {
      const { pool, weights } = eligiblePoolFor(rarity, ctx, config);
      assert.equal(
        pool.includes("RALLY_FLAG"),
        expected,
        `${rarity} team=${isTeamRace} p5=${supportsPowerups5} -> ${pool.join(",")}`
      );
      // The gate must never take the tier's other members with it.
      assert.ok(pool.length >= 1, `${rarity} must keep its ungated members`);
      assert.equal(weights.length, pool.length);
    }
  }
});

test("a ctx that omits the new fields still defaults to the SAFE side of both gates", () => {
  // Default-deny is the correct default for a compatibility gate: an
  // unidentified client is an old one. buildRollContext supplies both defaults,
  // so a caller updated for the position seam but not this one is still safe.
  const config = configWithFlagEverywhere();
  const ctx = buildRollContext({
    stepTotals: [100, 50, 10],
    myTotalSteps: 50,
    position: 2,
    totalParticipants: 3,
  });
  assert.equal(ctx.isTeamRace, false);
  assert.equal(ctx.supportsPowerups5, false);
  for (const rarity of RARITY_ORDER) {
    const { pool } = eligiblePoolFor(rarity, ctx, config);
    assert.ok(!pool.includes("RALLY_FLAG"), `${rarity} must not offer RALLY_FLAG by default`);
  }
});

test("a WHOLLY absent ctx keeps the module's 'no ctx == no filtering' contract", () => {
  // Deliberate, and NOT a hole: no production caller reaches this path (both the
  // roll and the disclosure build a ctx — see the structural guard in
  // test/services/teamOnlyCtxStructuralGuard.test.js). Changing it would break
  // the seeded Monte Carlo guard in test/services/balanceConfigService.test.js,
  // which asserts every droppable type is reachable from an un-ctx'd roll.
  const config = configWithFlagEverywhere();
  for (const rarity of RARITY_ORDER) {
    const { pool } = eligiblePoolFor(rarity, undefined, config);
    assert.ok(pool.includes("RALLY_FLAG"), `${rarity} with no ctx applies no filtering at all`);
  }
});

test("a config with no teamOnlyTypes imposes no team restriction", () => {
  // §6 default-safe reads: absent / not-an-array == [] == pre-change behaviour.
  for (const value of [undefined, null, "RALLY_FLAG", 7]) {
    const config = configWithFlagEverywhere();
    config.teamOnlyTypes = value;
    const ctx = ctxFor({ isTeamRace: false, supportsPowerups5: true });
    const { pool } = eligiblePoolFor("UNCOMMON", ctx, config);
    assert.ok(
      pool.includes("RALLY_FLAG"),
      `teamOnlyTypes=${JSON.stringify(value)} must not restrict anything`
    );
  }
});

// ---------------------------------------------------------------------------
// Test 9 — THE test. The empty-pool fallback restores the UNFILTERED pool; a
// hard compatibility gate applied before it would be silently undone.
// ---------------------------------------------------------------------------

test("the empty-pool fallback never restores a hard-gated type", () => {
  const config = defaultConfig();
  config.teamOnlyTypes = ["RALLY_FLAG"];
  config.storeOnlyTypes = config.storeOnlyTypes.filter((t) => t !== "RALLY_FLAG");
  config.typeWeights = {};
  // A tier whose ENTIRE membership is hard-gated. The position rules leave it
  // alone, so the balance-only filter is a no-op and the fallback is not even
  // triggered by the position pass — the gate must still hold on its own.
  config.dropPool = { COMMON: [], UNCOMMON: ["RALLY_FLAG"], RARE: [] };

  for (const { isTeamRace, supportsPowerups5 } of [
    { isTeamRace: false, supportsPowerups5: true },
    { isTeamRace: true, supportsPowerups5: false },
    { isTeamRace: false, supportsPowerups5: false },
  ]) {
    const ctx = ctxFor({ isTeamRace, supportsPowerups5 });
    const { pool } = eligiblePoolFor("UNCOMMON", ctx, config);
    assert.deepEqual(
      pool,
      [],
      `team=${isTeamRace} p5=${supportsPowerups5}: the gate must empty the tier rather than fall back to the unfiltered pool`
    );
    assert.equal(
      pickTypeForRarity("UNCOMMON", seededRng(7), config, ctx),
      null,
      "an emptied tier returns null; openMysteryBox owns the cascade (§5.5)"
    );
  }

  // …and the same config still works for the client the gate is FOR.
  const allowed = ctxFor({ isTeamRace: true, supportsPowerups5: true });
  assert.deepEqual(eligiblePoolFor("UNCOMMON", allowed, config).pool, ["RALLY_FLAG"]);
});

test("the empty-pool fallback still works for BALANCE rules (unchanged behaviour)", () => {
  // The fallback exists so an aggressive positionRules config cannot make a tier
  // unreachable. That is a balance heuristic and must keep working exactly as it
  // did — this change only carves the two hard gates out of it.
  const config = defaultConfig();
  config.dropPool.RARE = ["RED_CARD", "SECOND_WIND"];
  config.positionRules.leaderExcluded = ["RED_CARD", "SECOND_WIND"];
  const ctx = buildRollContext({
    stepTotals: [100, 10],
    myTotalSteps: 100,
    position: 1,
    totalParticipants: 2,
    isTeamRace: false,
    supportsPowerups5: true,
  });
  assert.equal(ctx.isStepLeader, true);
  assert.deepEqual(eligiblePoolFor("RARE", ctx, config).pool, ["RED_CARD", "SECOND_WIND"]);
});

// ---------------------------------------------------------------------------
// Test 11 — validateConfig
// ---------------------------------------------------------------------------

function errorsFor(mutate) {
  const config = defaultConfig();
  mutate(config);
  return validateConfig(config);
}

function pathsOf(errors) {
  return errors.map((e) => `${e.path}: ${e.message}`);
}

test("validateConfig rejects a non-array teamOnlyTypes", () => {
  const errors = errorsFor((c) => {
    c.teamOnlyTypes = "RALLY_FLAG";
  });
  assert.ok(
    errors.some((e) => e.path === "teamOnlyTypes"),
    `expected a teamOnlyTypes error, got ${pathsOf(errors).join(" | ")}`
  );
});

test("validateConfig rejects an unknown type in teamOnlyTypes", () => {
  const errors = errorsFor((c) => {
    c.teamOnlyTypes = ["NOT_A_POWERUP"];
  });
  assert.ok(
    errors.some((e) => e.path === "teamOnlyTypes" && /NOT_A_POWERUP/.test(e.message)),
    `expected an unknown-type error, got ${pathsOf(errors).join(" | ")}`
  );
});

test("validateConfig rejects a type that is both team-only and store-only", () => {
  // Contradiction: "never droppable" and "conditionally droppable" at once.
  const errors = errorsFor((c) => {
    c.teamOnlyTypes = ["LEECH"]; // LEECH is store-only in the defaults
  });
  assert.ok(
    errors.some((e) => /LEECH/.test(e.message) && /store-only/.test(e.message)),
    `expected a both-lists contradiction, got ${pathsOf(errors).join(" | ")}`
  );
});

test("validateConfig ACCEPTS a team-only type that is also in the drop pool", () => {
  // This combination is the entire point of the feature.
  const errors = errorsFor((c) => {
    c.teamOnlyTypes = ["RALLY_FLAG"];
    c.storeOnlyTypes = c.storeOnlyTypes.filter((t) => t !== "RALLY_FLAG");
    if (!c.dropPool.UNCOMMON.includes("RALLY_FLAG")) c.dropPool.UNCOMMON.push("RALLY_FLAG");
  });
  assert.deepEqual(errors, [], `config must save: ${pathsOf(errors).join(" | ")}`);
});

test("validateConfig ACCEPTS a daily-box exclusion that is team-only but not store-only", () => {
  // §5.2 relaxation. Without it the shipped §5.1 config is unsaveable the moment
  // RALLY_FLAG leaves storeOnlyTypes — the rollout would fail at step 3, after
  // the deploy.
  const errors = errorsFor((c) => {
    c.teamOnlyTypes = ["RALLY_FLAG"];
    c.storeOnlyTypes = c.storeOnlyTypes.filter((t) => t !== "RALLY_FLAG");
    c.dropPool.UNCOMMON = [...c.dropPool.UNCOMMON.filter((t) => t !== "RALLY_FLAG"), "RALLY_FLAG"];
    assert.ok(c.dailyBoxExcludedTypes.includes("RALLY_FLAG"), "fixture: still daily-box excluded");
  });
  assert.deepEqual(errors, [], `config must save: ${pathsOf(errors).join(" | ")}`);
});

test("validateConfig still rejects a daily-box exclusion that is neither store-only nor team-only", () => {
  // The relaxation must not become a hole: the rule's intent ("don't silently
  // bar something that is otherwise freely obtainable") is preserved.
  const errors = errorsFor((c) => {
    c.dailyBoxExcludedTypes = [...c.dailyBoxExcludedTypes, "PROTEIN_SHAKE"];
  });
  assert.ok(
    errors.some((e) => e.path === "dailyBoxExcludedTypes" && /PROTEIN_SHAKE/.test(e.message)),
    `expected the rule to still fire, got ${pathsOf(errors).join(" | ")}`
  );
});

test("the shipped defaults are themselves a valid config", () => {
  assert.deepEqual(validateConfig(defaultConfig()), []);
});

// ---------------------------------------------------------------------------
// Test 12 — mergeOverDefaults / enforceStoreOnlyExclusion
// ---------------------------------------------------------------------------

test("a stored config with no teamOnlyTypes inherits the shipped defaults", () => {
  const stored = defaultConfig();
  delete stored.teamOnlyTypes;
  const merged = mergeOverDefaults(stored);
  assert.deepEqual(
    merged.teamOnlyTypes,
    defaultConfig().teamOnlyTypes,
    "a config written before this deploy must resolve the new key from code"
  );
});

test("enforceStoreOnlyExclusion no longer strips RALLY_FLAG from a stored drop pool", () => {
  // §3.1: the code defaults' storeOnlyTypes are unioned in on every read, so
  // while RALLY_FLAG stayed listed there, adding it to a stored dropPool was a
  // no-op. Removing it from the defaults is what makes the data write land.
  const stored = defaultConfig();
  stored.dropPool = { COMMON: [], UNCOMMON: ["RALLY_FLAG", "STEALTH_MODE"], RARE: [] };
  const merged = mergeOverDefaults(stored);
  assert.ok(
    merged.dropPool.UNCOMMON.includes("RALLY_FLAG"),
    "the merge must stop vetoing the stored drop pool"
  );
  // …and the exclusion still works for everything that IS still store-only.
  const other = defaultConfig();
  other.dropPool = { COMMON: [], UNCOMMON: ["LEECH", "STEALTH_MODE"], RARE: [] };
  assert.deepEqual(mergeOverDefaults(other).dropPool.UNCOMMON, ["STEALTH_MODE"]);
});

test("the shipped defaults put RALLY_FLAG in the drop pool and out of storeOnlyTypes", () => {
  const config = defaultConfig();
  assert.ok(!config.storeOnlyTypes.includes("RALLY_FLAG"));
  assert.deepEqual(config.teamOnlyTypes, ["RALLY_FLAG"]);
  assert.ok(config.dropPool.UNCOMMON.includes("RALLY_FLAG"));
  assert.ok(
    config.dailyBoxExcludedTypes.includes("RALLY_FLAG"),
    "the daily spin must still never award it"
  );
  assert.equal(
    config.rarityByType.RALLY_FLAG,
    "UNCOMMON",
    "the drop tier must match the canonical rarity"
  );
});

// ---------------------------------------------------------------------------
// Test 13 — parity between the roll and the disclosure.
// ---------------------------------------------------------------------------

test("typeOddsForPosition and pickTypeForRarity agree for identical ctx, all four combinations", () => {
  const config = configWithFlagEverywhere();
  // One tier at a time so byType maps one-to-one onto that tier's pool.
  for (const rarity of RARITY_ORDER) {
    const pinned = JSON.parse(JSON.stringify(config));
    const row = { COMMON: [1, 0, 0], UNCOMMON: [0, 1, 0], RARE: [0, 0, 1] }[rarity];
    pinned.positionOdds = { first: [...row], last: [...row] };

    for (const isTeamRace of [true, false]) {
      for (const supportsPowerups5 of [true, false]) {
        const ctx = ctxFor({ isTeamRace, supportsPowerups5 });
        const label = `${rarity} team=${isTeamRace} p5=${supportsPowerups5}`;

        const byType = typeOddsForPosition(2, 3, pinned, ctx);
        const quoted = new Set(
          Object.entries(byType).filter(([, p]) => p > 0).map(([t]) => t)
        );

        const rng = seededRng(12345);
        const drawn = new Set();
        for (let i = 0; i < 400; i++) {
          const t = pickTypeForRarity(rarity, rng, pinned, ctx);
          if (t) drawn.add(t);
        }

        assert.deepEqual(
          [...drawn].sort(),
          [...quoted].sort(),
          `${label}: the odds sheet must quote exactly what the roll can produce`
        );
      }
    }
  }
});
