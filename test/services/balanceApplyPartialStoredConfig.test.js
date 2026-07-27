const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MIGRATIONS,
  teamOnlyRallyFlag,
  evaluateMigration,
  lostDropPoolAdditions,
} = require("../../scripts/balance-apply");
const {
  validateConfig,
  mergeOverDefaults,
} = require("../../src/modules/economy/balanceConfig");
const { defaultConfig } = require("../../src/modules/economy/balanceConfig.defaults");

// REGRESSION (2026-07-27 prod cut). balance:apply refused to write to prod AND
// staging with 11 × "rarityByType is missing <TYPE>" plus "RALLY_FLAG is in the
// drop pool but has no rarity" — so Rally Flag's team-only drop pool shipped
// inert in both environments.
//
// The pre-existing suite (balanceApplyScript.test.js) could not catch it: its
// fixture is built from defaultConfig(), i.e. a COMPLETE config. The stored row
// in prod is a genuine PARTIAL written at schema v1, before eleven powerup types
// existed. mergeOverDefaults fills those gaps at runtime, so the partial is a
// legal stored config and an invalid standalone one — and the script was
// validating the standalone.
//
// These are pure config-algebra cases over hand-built shapes (CLAUDE.md's unit
// carve-out); the DB half stays dry-run-by-default and reviewed by hand.

// The stored prod row as it actually existed on 2026-07-27, reconstructed:
// schema v1, no `teamOnlyTypes`, a drop pool predating the Pocket Watch move,
// and a `rarityByType` missing every type added after it was written.
const TYPES_ADDED_AFTER_THE_STORED_ROW = [
  "UPRISING",
  "GHOST_PEPPER",
  "COIN_FLIP",
  "MYSTERY_POTION",
  "DECOY",
  "POWER_OUTAGE",
  "UMBRELLA",
  "RALLY_FLAG",
  "DRILL_SERGEANT",
  "PIGGY_BANK",
  "BOUNTY",
];

function prodStoredConfig() {
  const config = defaultConfig();
  delete config.teamOnlyTypes;
  config.storeOnlyTypes = [
    "IMPOSTER",
    "RAINSTORM",
    "SIGNAL_JAMMER",
    "LEECH",
    "DEFENSE_SCAN",
    "HITCHHIKE",
    "QUICK_RINSE",
  ];
  config.dailyBoxExcludedTypes = ["DEFENSE_SCAN", "LEECH", "HITCHHIKE", "QUICK_RINSE"];
  config.dropPool = {
    COMMON: [...config.dropPool.COMMON],
    UNCOMMON: ["LEG_CRAMP", "STEALTH_MODE", "WRONG_TURN"],
    RARE: [
      "RED_CARD",
      "SECOND_WIND",
      "COMPRESSION_SOCKS",
      "FANNY_PACK",
      "LUCKY_HORSESHOE",
      "POCKET_WATCH",
      "TRAIL_MINE",
      "SNEAKY_SWAP",
      "SHORTCUT",
      "CLEANSE",
      "MIRROR",
    ],
  };
  for (const type of TYPES_ADDED_AFTER_THE_STORED_ROW) delete config.rarityByType[type];
  return config;
}

test("the fixture reproduces the prod failure: the migrated PARTIAL is invalid standalone", () => {
  const after = teamOnlyRallyFlag(prodStoredConfig());
  const errors = validateConfig(after);

  assert.ok(
    errors.some((e) => e.path === "rarityByType.RALLY_FLAG"),
    "expected the exact prod rejection; if this stops failing the fixture has drifted"
  );
  assert.ok(errors.length >= TYPES_ADDED_AFTER_THE_STORED_ROW.length);
});

test("evaluateMigration validates the MERGED config, so the partial row is writable", () => {
  const result = evaluateMigration({
    storedConfig: prodStoredConfig(),
    migration: MIGRATIONS["team-only-rally-flag"],
  });

  assert.deepEqual(
    result.errors,
    [],
    `still refusing to write: ${result.errors.map((e) => e.message).join(" | ")}`
  );
  assert.deepEqual(result.lostAdditions, []);
});

test("the merged result is what the runtime wants: Rally Flag droppable and team-only", () => {
  const { mergedAfter } = evaluateMigration({
    storedConfig: prodStoredConfig(),
    migration: MIGRATIONS["team-only-rally-flag"],
  });

  assert.ok(
    mergedAfter.dropPool.UNCOMMON.includes("RALLY_FLAG"),
    "the whole point of the migration"
  );
  assert.deepEqual(mergedAfter.teamOnlyTypes, ["RALLY_FLAG"]);
  assert.ok(!mergedAfter.storeOnlyTypes.includes("RALLY_FLAG"));
  assert.equal(mergedAfter.rarityByType.RALLY_FLAG, "UNCOMMON");
});

test("what gets PERSISTED stays partial — defaults must not be frozen into the row", () => {
  const { after } = evaluateMigration({
    storedConfig: prodStoredConfig(),
    migration: MIGRATIONS["team-only-rally-flag"],
  });

  for (const type of TYPES_ADDED_AFTER_THE_STORED_ROW) {
    if (type === "RALLY_FLAG") continue;
    assert.ok(
      !(type in after.rarityByType),
      `validating the merged config must not write ${type} back into the stored row`
    );
  }
  assert.ok(after.dropPool.UNCOMMON.includes("RALLY_FLAG"));
});

test("a complete stored config still behaves — no regression for fresh environments", () => {
  const complete = defaultConfig();
  delete complete.teamOnlyTypes;
  complete.storeOnlyTypes = [...complete.storeOnlyTypes, "RALLY_FLAG"];
  complete.dropPool.UNCOMMON = complete.dropPool.UNCOMMON.filter((t) => t !== "RALLY_FLAG");

  const result = evaluateMigration({
    storedConfig: complete,
    migration: MIGRATIONS["team-only-rally-flag"],
  });

  assert.deepEqual(result.errors, []);
  assert.ok(result.storedDiff.length > 0);
});

// The defaults-veto trap (team-only-drop-pool-requirements.md §3.2):
// enforceStoreOnlyExclusion filters the drop pool by the UNION of the stored
// storeOnlyTypes and the CODE DEFAULTS' list. So a migration can add a type to
// dropPool, validate clean, write successfully — and change nothing at runtime,
// because the defaults silently strip it right back out.
test("lostDropPoolAdditions catches an addition the code defaults veto", () => {
  const before = prodStoredConfig();
  // IMPOSTER is store-only in the code defaults, so this addition cannot survive.
  const after = JSON.parse(JSON.stringify(before));
  after.dropPool.UNCOMMON = [...after.dropPool.UNCOMMON, "IMPOSTER"];

  const lost = lostDropPoolAdditions(before, after, mergeOverDefaults(after));

  assert.deepEqual(lost, [{ tier: "UNCOMMON", type: "IMPOSTER" }]);
});

test("lostDropPoolAdditions reports nothing for the real migration", () => {
  const before = prodStoredConfig();
  const after = teamOnlyRallyFlag(before);

  assert.deepEqual(lostDropPoolAdditions(before, after, mergeOverDefaults(after)), []);
});

test("evaluateMigration does not mutate the stored config it is handed", () => {
  const before = prodStoredConfig();
  const snapshot = JSON.stringify(before);

  evaluateMigration({
    storedConfig: before,
    migration: MIGRATIONS["team-only-rally-flag"],
  });

  assert.equal(JSON.stringify(before), snapshot);
});

test("re-running an applied migration is a clean no-op", () => {
  const once = evaluateMigration({
    storedConfig: prodStoredConfig(),
    migration: MIGRATIONS["team-only-rally-flag"],
  });
  const twice = evaluateMigration({
    storedConfig: once.after,
    migration: MIGRATIONS["team-only-rally-flag"],
  });

  assert.deepEqual(twice.storedDiff, []);
  assert.deepEqual(twice.errors, []);
});
