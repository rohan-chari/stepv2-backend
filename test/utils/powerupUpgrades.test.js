const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isUpgradeable,
  upgradeCost,
  upgradedDuration,
  upgradedMagnitude,
  MAX_UPGRADE_LEVEL,
  UPGRADEABLE_TYPES,
} = require("../../src/modules/powerups/powerupUpgrades");

const HOUR = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// isUpgradeable
// ---------------------------------------------------------------------------

test("isUpgradeable: returns true for the designed upgradeable types", () => {
  for (const type of [
    "PROTEIN_SHAKE",
    "SHORTCUT",
    "DETOUR_SIGN",
    "TRAIL_MIX",
    "RUNNERS_HIGH",
    "LEG_CRAMP",
    "STEALTH_MODE",
    "WRONG_TURN",
    "COMPRESSION_SOCKS",
    "LUCKY_HORSESHOE",
    "CAMPFIRE_REST",
    "TRAIL_MAGNET",
    "POCKET_WATCH",
    "TRAIL_MINE",
    "PINECONE_TOSS",
  ]) {
    assert.equal(isUpgradeable(type), true, `${type} should be upgradeable`);
  }
});

test("isUpgradeable: returns false for non-upgradeable types", () => {
  for (const type of ["RED_CARD", "SECOND_WIND", "FANNY_PACK", "SNEAKY_SWAP"]) {
    assert.equal(isUpgradeable(type), false, `${type} must NOT be upgradeable`);
  }
});

test("isUpgradeable: returns false for MYSTERY_BOX and unknown types", () => {
  assert.equal(isUpgradeable("MYSTERY_BOX"), false);
  assert.equal(isUpgradeable("NOT_A_REAL_TYPE"), false);
  assert.equal(isUpgradeable(null), false);
  assert.equal(isUpgradeable(undefined), false);
});

test("UPGRADEABLE_TYPES exported with the designed upgradeable set", () => {
  assert.equal(UPGRADEABLE_TYPES.size, 15);
  assert.ok(UPGRADEABLE_TYPES.has("PROTEIN_SHAKE"));
  assert.ok(UPGRADEABLE_TYPES.has("TRAIL_MIX"));
  assert.ok(UPGRADEABLE_TYPES.has("PINECONE_TOSS"));
  assert.ok(!UPGRADEABLE_TYPES.has("RED_CARD"));
  assert.ok(!UPGRADEABLE_TYPES.has("SNEAKY_SWAP"));
});

test("MAX_UPGRADE_LEVEL is 3", () => {
  assert.equal(MAX_UPGRADE_LEVEL, 3);
});

// ---------------------------------------------------------------------------
// upgradeCost — Common rarity (Protein Shake, Shortcut, Detour Sign): 5/15/45
// ---------------------------------------------------------------------------

test("upgradeCost: Common rarity (Protein Shake) — 5/15/45", () => {
  assert.equal(upgradeCost("PROTEIN_SHAKE", 0), 0);
  assert.equal(upgradeCost("PROTEIN_SHAKE", 1), 5);
  assert.equal(upgradeCost("PROTEIN_SHAKE", 2), 15);
  assert.equal(upgradeCost("PROTEIN_SHAKE", 3), 45);
});

// Shortcut moved COMMON -> RARE. It has always DROPPED from the RARE tier
// (powerupOdds RARITY_TIERS) while pricing off the COMMON ladder, so it was the
// strongest powerup in the game and also the cheapest to max (65 vs 195 coins) —
// prod shows 190 upgrades / 9,210 coins, the single largest sink. Rarity is now
// resolved from one canonical table, so cost follows the drop tier.
test("upgradeCost: Rare rarity (Shortcut) — 15/45/135", () => {
  assert.equal(upgradeCost("SHORTCUT", 1), 15);
  assert.equal(upgradeCost("SHORTCUT", 2), 45);
  assert.equal(upgradeCost("SHORTCUT", 3), 135);
});

test("upgradeCost: Common rarity (Detour Sign) — 5/15/45", () => {
  assert.equal(upgradeCost("DETOUR_SIGN", 1), 5);
  assert.equal(upgradeCost("DETOUR_SIGN", 2), 15);
  assert.equal(upgradeCost("DETOUR_SIGN", 3), 45);
});

test("upgradeCost: Common rarity (Trail Mix) — 5/15/45", () => {
  assert.equal(upgradeCost("TRAIL_MIX", 1), 5);
  assert.equal(upgradeCost("TRAIL_MIX", 2), 15);
  assert.equal(upgradeCost("TRAIL_MIX", 3), 45);
});

// ---------------------------------------------------------------------------
// upgradeCost — Uncommon rarity: 10/30/90
// ---------------------------------------------------------------------------

// Runner's High moved UNCOMMON -> COMMON (cheaper). Like Pinecone Toss, it was
// retiered in powerupOdds long ago but RARITY_BY_TYPE was never updated — prod
// drop history shows both rarities on record (133 common / 479 uncommon), which
// is what identified these as a half-finished migration rather than intent.
test("upgradeCost: Common rarity (Runner's High) — 5/15/45", () => {
  assert.equal(upgradeCost("RUNNERS_HIGH", 1), 5);
  assert.equal(upgradeCost("RUNNERS_HIGH", 2), 15);
  assert.equal(upgradeCost("RUNNERS_HIGH", 3), 45);
});

test("upgradeCost: Uncommon rarity (Leg Cramp) — 10/30/90", () => {
  assert.equal(upgradeCost("LEG_CRAMP", 1), 10);
  assert.equal(upgradeCost("LEG_CRAMP", 2), 30);
  assert.equal(upgradeCost("LEG_CRAMP", 3), 90);
});

test("upgradeCost: Uncommon rarity (Stealth Mode) — 10/30/90", () => {
  assert.equal(upgradeCost("STEALTH_MODE", 1), 10);
  assert.equal(upgradeCost("STEALTH_MODE", 2), 30);
  assert.equal(upgradeCost("STEALTH_MODE", 3), 90);
});

test("upgradeCost: Uncommon rarity (Wrong Turn) — 10/30/90", () => {
  assert.equal(upgradeCost("WRONG_TURN", 1), 10);
  assert.equal(upgradeCost("WRONG_TURN", 2), 30);
  assert.equal(upgradeCost("WRONG_TURN", 3), 90);
});

// ---------------------------------------------------------------------------
// upgradeCost — Rare rarity (Compression Socks): 15/45/135
// ---------------------------------------------------------------------------

test("upgradeCost: Rare rarity (Compression Socks) — 15/45/135", () => {
  assert.equal(upgradeCost("COMPRESSION_SOCKS", 1), 15);
  assert.equal(upgradeCost("COMPRESSION_SOCKS", 2), 45);
  assert.equal(upgradeCost("COMPRESSION_SOCKS", 3), 135);
});

// ---------------------------------------------------------------------------
// upgradeCost — invalid inputs
// ---------------------------------------------------------------------------

test("upgradeCost: non-upgradeable type throws", () => {
  assert.throws(() => upgradeCost("RED_CARD", 1), /not upgradeable/i);
  assert.throws(() => upgradeCost("SECOND_WIND", 2), /not upgradeable/i);
  assert.throws(() => upgradeCost("FANNY_PACK", 3), /not upgradeable/i);
});

test("upgradeCost: out-of-range level throws", () => {
  assert.throws(() => upgradeCost("PROTEIN_SHAKE", 4), /level/i);
  assert.throws(() => upgradeCost("PROTEIN_SHAKE", -1), /level/i);
  assert.throws(() => upgradeCost("PROTEIN_SHAKE", 1.5), /level/i);
});

test("upgradeCost: level 0 always returns 0 even for non-upgradeable types", () => {
  // Level 0 = base form; does not require type to be upgradeable
  assert.equal(upgradeCost("RED_CARD", 0), 0);
  assert.equal(upgradeCost("PROTEIN_SHAKE", 0), 0);
});

// ---------------------------------------------------------------------------
// upgradedDuration — duration-based powerups (returns ms)
// ---------------------------------------------------------------------------

test("upgradedDuration: Leg Cramp — 2h / 3h / 4h / 6h", () => {
  assert.equal(upgradedDuration("LEG_CRAMP", 0), 2 * HOUR);
  assert.equal(upgradedDuration("LEG_CRAMP", 1), 3 * HOUR);
  assert.equal(upgradedDuration("LEG_CRAMP", 2), 4 * HOUR);
  assert.equal(upgradedDuration("LEG_CRAMP", 3), 6 * HOUR);
});

test("upgradedDuration: Runner's High — 3h / 4h / 5h / 7h", () => {
  assert.equal(upgradedDuration("RUNNERS_HIGH", 0), 3 * HOUR);
  assert.equal(upgradedDuration("RUNNERS_HIGH", 1), 4 * HOUR);
  assert.equal(upgradedDuration("RUNNERS_HIGH", 2), 5 * HOUR);
  assert.equal(upgradedDuration("RUNNERS_HIGH", 3), 7 * HOUR);
});

test("upgradedDuration: Stealth Mode — 4h / 5h / 6.5h / 8h", () => {
  assert.equal(upgradedDuration("STEALTH_MODE", 0), 4 * HOUR);
  assert.equal(upgradedDuration("STEALTH_MODE", 1), 5 * HOUR);
  assert.equal(upgradedDuration("STEALTH_MODE", 2), 6.5 * HOUR);
  assert.equal(upgradedDuration("STEALTH_MODE", 3), 8 * HOUR);
});

test("upgradedDuration: Wrong Turn — 1h / 1.5h / 2h / 3h", () => {
  assert.equal(upgradedDuration("WRONG_TURN", 0), 1 * HOUR);
  assert.equal(upgradedDuration("WRONG_TURN", 1), 1.5 * HOUR);
  assert.equal(upgradedDuration("WRONG_TURN", 2), 2 * HOUR);
  assert.equal(upgradedDuration("WRONG_TURN", 3), 3 * HOUR);
});

test("upgradedDuration: Detour Sign — 3h / 4h / 5h / 7h", () => {
  assert.equal(upgradedDuration("DETOUR_SIGN", 0), 3 * HOUR);
  assert.equal(upgradedDuration("DETOUR_SIGN", 1), 4 * HOUR);
  assert.equal(upgradedDuration("DETOUR_SIGN", 2), 5 * HOUR);
  assert.equal(upgradedDuration("DETOUR_SIGN", 3), 7 * HOUR);
});

test("upgradedDuration: Compression Socks — 24h / 30h / 36h / 48h", () => {
  assert.equal(upgradedDuration("COMPRESSION_SOCKS", 0), 24 * HOUR);
  assert.equal(upgradedDuration("COMPRESSION_SOCKS", 1), 30 * HOUR);
  assert.equal(upgradedDuration("COMPRESSION_SOCKS", 2), 36 * HOUR);
  assert.equal(upgradedDuration("COMPRESSION_SOCKS", 3), 48 * HOUR);
});

test("upgradedDuration: throws for instant powerups (Protein Shake, Shortcut)", () => {
  assert.throws(() => upgradedDuration("PROTEIN_SHAKE", 1), /no duration/i);
  assert.throws(() => upgradedDuration("SHORTCUT", 1), /no duration/i);
});

test("upgradedDuration: throws for non-upgradeable timed powerups (preserves existing behavior contract)", () => {
  // The 4 non-upgradeable types should not be queried via this helper
  assert.throws(() => upgradedDuration("FANNY_PACK", 1), /not upgradeable|no duration/i);
});

// ---------------------------------------------------------------------------
// upgradedMagnitude — instant-bonus powerups (returns step amount)
// ---------------------------------------------------------------------------

test("upgradedMagnitude: Protein Shake — 1500 / 2250 / 3000 / 4500", () => {
  assert.equal(upgradedMagnitude("PROTEIN_SHAKE", 0), 1500);
  assert.equal(upgradedMagnitude("PROTEIN_SHAKE", 1), 2250);
  assert.equal(upgradedMagnitude("PROTEIN_SHAKE", 2), 3000);
  assert.equal(upgradedMagnitude("PROTEIN_SHAKE", 3), 4500);
});

test("upgradedMagnitude: Shortcut steal cap — 1000 / 1500 / 2000 / 3000", () => {
  assert.equal(upgradedMagnitude("SHORTCUT", 0), 1000);
  assert.equal(upgradedMagnitude("SHORTCUT", 1), 1500);
  assert.equal(upgradedMagnitude("SHORTCUT", 2), 2000);
  assert.equal(upgradedMagnitude("SHORTCUT", 3), 3000);
});

test("upgradedMagnitude: Trail Mix per-type bonus — 100 / 150 / 200 / 300", () => {
  assert.equal(upgradedMagnitude("TRAIL_MIX", 0), 100);
  assert.equal(upgradedMagnitude("TRAIL_MIX", 1), 150);
  assert.equal(upgradedMagnitude("TRAIL_MIX", 2), 200);
  assert.equal(upgradedMagnitude("TRAIL_MIX", 3), 300);
});

test("upgradedMagnitude: throws for non-magnitude powerups (timed effects)", () => {
  assert.throws(() => upgradedMagnitude("LEG_CRAMP", 1), /no magnitude/i);
  assert.throws(() => upgradedMagnitude("RUNNERS_HIGH", 1), /no magnitude/i);
});
