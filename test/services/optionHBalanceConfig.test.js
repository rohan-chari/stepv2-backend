const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  MIGRATIONS,
  optionHPositionFairness,
  evaluateMigration,
} = require("../../scripts/balance-apply");
const {
  validateConfig,
  mergeOverDefaults,
} = require("../../src/modules/economy/balanceConfig");
const { defaultConfig } = require("../../src/modules/economy/balanceConfig.defaults");
const {
  eligiblePoolFor,
  typeOddsForPosition,
  RARITY_ORDER,
} = require("../../src/modules/powerups/powerupOdds");

// Option H — trailers catch up by SELF-BOOST, not griefing
// (docs/economy.md §8 Option H; spec step 8 / test plan 7).
//
// The config row is applied by hand AFTER the code deploy (Option H amplifies
// the hoarding exploit if it lands first — the ordering is mandatory). This
// file is the pre-flight: the exact transform that will be applied, proven to
// validate cleanly and — the trap that matters — proven never to leave a rarity
// tier with a total weight of ZERO at any position, because `drawWeighted`
// falls back to a UNIFORM pick when the weights sum to 0, silently inverting a
// down-weight into an up-weight (powerupOdds.js:226).

// The ramp endpoints (0.4 / 0.6) are in the sweep deliberately: they are where
// leadingDownweight and trailingDownweight reach full strength, i.e. where a
// tier's weight sum is at its smallest (analyst S2).
const SWEEP_POSITIONS = [0, 0.25, 0.4, 0.5, 0.6, 0.75, 1];

// Every ctx a production roll can present. `isStepLeader && isStepLast` is a
// real state, not a contradiction: at a 0-0 race start every player is both.
const CTX_VARIANTS = [];
for (const isStepLeader of [true, false]) {
  for (const isStepLast of [true, false]) {
    for (const isTeamRace of [true, false]) {
      for (const supportsPowerups5 of [true, false]) {
        CTX_VARIANTS.push({ isStepLeader, isStepLast, isTeamRace, supportsPowerups5 });
      }
    }
  }
}

// The live prod row as verified 2026-08-08/09 (docs/economy.md §3.2, §3.3b),
// including the two rarityByType drifts Option H reconciles. Stored rows are
// PARTIAL by design — mergeOverDefaults fills the rest — so this is exactly the
// shape balance-apply will read out of the database.
function prodShapedStoredConfig() {
  return {
    schemaVersion: 1,
    dropPool: {
      COMMON: ["PROTEIN_SHAKE", "TRAIL_MIX", "DETOUR_SIGN", "RUNNERS_HIGH", "PINECONE_TOSS"],
      UNCOMMON: ["LEG_CRAMP", "STEALTH_MODE", "WRONG_TURN", "RALLY_FLAG"],
      RARE: [
        "RED_CARD",
        "SECOND_WIND",
        "COMPRESSION_SOCKS",
        "FANNY_PACK",
        "LUCKY_HORSESHOE",
        "TRAIL_MINE",
        "SNEAKY_SWAP",
        "SHORTCUT",
        "CLEANSE",
        "MIRROR",
      ],
    },
    rarityByType: { WRONG_TURN: "RARE", SNEAKY_SWAP: "UNCOMMON" },
    teamOnlyTypes: ["RALLY_FLAG"],
    typeWeights: { RED_CARD: 0.5 },
    positionOdds: { first: [0.48, 0.25, 0.27], last: [0.2, 0.35, 0.45] },
    positionRules: {
      leaderExcluded: ["RED_CARD", "SECOND_WIND"],
      lastPlaceExcluded: ["TRAIL_MINE"],
      leadingDownweight: { RUNNERS_HIGH: 0.5 },
      trailingDownweight: { CLEANSE: 0.5, MIRROR: 0.5, STEALTH_MODE: 0.5 },
      leadingDownweightFrom: 0.4,
      trailingDownweightFrom: 0.6,
    },
  };
}

function assertNoZeroWeightTier(config, label) {
  for (const npos of SWEEP_POSITIONS) {
    for (const variant of CTX_VARIANTS) {
      const ctx = { normalizedPosition: npos, ...variant };
      for (const rarity of RARITY_ORDER) {
        const { pool, weights } = eligiblePoolFor(rarity, ctx, config);
        const total = weights.reduce((a, b) => a + b, 0);
        assert.ok(
          pool.length > 0 && total > 0,
          `${label}: ${rarity} weight sum is ${total} at npos ${npos} ` +
            `(${JSON.stringify(variant)}) — drawWeighted would fall back to a ` +
            `UNIFORM pick and invert the down-weight`
        );
      }
    }
  }
}

test("Option H is registered as a reviewed balance-apply migration", () => {
  assert.ok(MIGRATIONS["option-h-position-fairness"], "migration must be registered");
  assert.equal(
    MIGRATIONS["option-h-position-fairness"].apply,
    optionHPositionFairness
  );
});

test("Option H applies docs/economy.md §8 exactly, and is idempotent", () => {
  const before = defaultConfig();
  const after = mergeOverDefaults(optionHPositionFairness(before));

  assert.deepEqual(before, defaultConfig(), "the transform must not mutate its input");

  for (const type of ["PROTEIN_SHAKE", "TRAIL_MIX", "RUNNERS_HIGH"]) {
    assert.ok(
      after.dropPool.UNCOMMON.includes(type),
      `${type} must join dropPool.UNCOMMON`
    );
    assert.ok(
      after.dropPool.COMMON.includes(type),
      `${type} stays in dropPool.COMMON too`
    );
    assert.equal(
      after.rarityByType[type],
      "COMMON",
      "canonical rarity (and therefore the upgrade ladder) is unchanged"
    );
  }
  assert.deepEqual(after.positionOdds.first, [0.52, 0.2, 0.28]);
  assert.deepEqual(after.positionOdds.last, [0.3, 0.36, 0.34]);
  assert.deepEqual(after.positionRules.leadingDownweight, {
    RUNNERS_HIGH: 0.5,
    PROTEIN_SHAKE: 0.7,
    TRAIL_MIX: 0.7,
  });
  assert.deepEqual(after.positionRules.trailingDownweight, {
    WRONG_TURN: 0.2,
    LEG_CRAMP: 0.25,
    PINECONE_TOSS: 0.4,
    DETOUR_SIGN: 0.4,
    SNEAKY_SWAP: 0.5,
    CLEANSE: 0.5,
    MIRROR: 0.5,
    // Restored to full strength. It MUST be an explicit 1.0, not an omission:
    // mergeOverDefaults merges plain objects recursively, so a missing key
    // inherits the code default's 0.5 and the change silently does nothing.
    STEALTH_MODE: 1,
  });
  assert.equal(
    after.positionRules.trailingDownweight.STEALTH_MODE,
    1,
    "STEALTH_MODE must be neutralised explicitly, or the defaults re-impose 0.5"
  );
  // Untouched by design.
  assert.deepEqual(after.positionRules.leaderExcluded, ["RED_CARD", "SECOND_WIND"]);
  assert.deepEqual(after.positionRules.lastPlaceExcluded, ["TRAIL_MINE"]);
  assert.equal(after.positionRules.leadingDownweightFrom, 0.4);
  assert.equal(after.positionRules.trailingDownweightFrom, 0.6);
  assert.deepEqual(after.typeWeights, defaultConfig().typeWeights);
  assert.deepEqual(after.discardPrices, defaultConfig().discardPrices);
  assert.deepEqual(after.upgradeCosts, defaultConfig().upgradeCosts);

  // Idempotent: re-running on an already-migrated config changes nothing.
  assert.deepEqual(
    mergeOverDefaults(optionHPositionFairness(optionHPositionFairness(defaultConfig()))),
    after
  );
});

test("Option H reconciles the two rarityByType drifts on the live prod row", () => {
  const after = mergeOverDefaults(optionHPositionFairness(prodShapedStoredConfig()));
  assert.equal(after.rarityByType.WRONG_TURN, "UNCOMMON", "195 -> 130 coins");
  assert.equal(after.rarityByType.SNEAKY_SWAP, "RARE", "130 -> 195 coins");
});

test("validateConfig returns [] for Option H, from the code defaults AND from the live prod row", () => {
  for (const [label, stored] of [
    ["defaults", defaultConfig()],
    ["prod row", prodShapedStoredConfig()],
  ]) {
    const evaluation = evaluateMigration({
      storedConfig: stored,
      migration: MIGRATIONS["option-h-position-fairness"],
    });
    assert.deepEqual(evaluation.errors, [], `${label}: validateConfig must be clean`);
    assert.deepEqual(
      evaluation.lostAdditions,
      [],
      `${label}: no drop-pool addition may be vetoed by storeOnlyTypes`
    );
  }
});

test("no rarity tier can reach a ZERO total weight at any position under Option H", () => {
  assertNoZeroWeightTier(
    mergeOverDefaults(optionHPositionFairness(defaultConfig())),
    "defaults + H"
  );
  assertNoZeroWeightTier(
    mergeOverDefaults(optionHPositionFairness(prodShapedStoredConfig())),
    "prod + H"
  );
});

test("Option H moves offense to mid-pack and self-boost to the back (economy.md §8 table)", () => {
  const config = mergeOverDefaults(optionHPositionFairness(prodShapedStoredConfig()));
  const ctxFor = (position, total) => ({
    normalizedPosition: (position - 1) / (total - 1),
    isStepLeader: position === 1,
    isStepLast: position === total,
    isTeamRace: false,
    supportsPowerups5: true,
  });
  const at = (position) =>
    typeOddsForPosition(position, 6, config, ctxFor(position, 6));

  const last = at(6);
  const first = at(1);
  const mid = at(3);

  // Trailers get self-boosts…
  for (const type of ["PROTEIN_SHAKE", "TRAIL_MIX", "RUNNERS_HIGH"]) {
    assert.ok(
      last[type] > 0.15,
      `${type} must be ~17% at last place, got ${(last[type] * 100).toFixed(2)}%`
    );
    assert.ok(last[type] > first[type], `${type} must favour the back of the field`);
  }
  // …and stop drawing the grief tools.
  const wtLcLast = last.WRONG_TURN + last.LEG_CRAMP;
  const wtLcMid = mid.WRONG_TURN + mid.LEG_CRAMP;
  assert.ok(
    wtLcLast < 0.06,
    `Wrong Turn + Leg Cramp must fall to ~4% at last place, got ${(wtLcLast * 100).toFixed(2)}%`
  );
  assert.ok(
    wtLcMid > wtLcLast,
    "offense must peak at mid-pack, not at the back"
  );

  // The tier block is untouched — the shipped odds sheet hides itself if the
  // rarity block stops summing to 1.0.
  for (const position of [1, 3, 6]) {
    const total = Object.values(at(position)).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 0.01, `byType must sum to 1.0 at P${position}`);
  }
});

test("the committed Option H artifact matches the transform (regenerate it if this fails)", () => {
  const file = path.join(__dirname, "..", "..", "data", "option-h-balance-config.json");
  const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(
    artifact.config,
    mergeOverDefaults(optionHPositionFairness(defaultConfig())),
    "data/option-h-balance-config.json is stale"
  );
  assert.deepEqual(validateConfig(artifact.config), []);
});
