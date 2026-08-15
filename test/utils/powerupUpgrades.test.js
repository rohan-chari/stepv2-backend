const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isUpgradeable,
  upgradeCost,
  upgradedDuration,
  upgradedMagnitude,
  MAX_UPGRADE_LEVEL,
  UPGRADEABLE_TYPES,
  formatDuration,
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

// 2026-08-15: Detour Sign joined the 15-min duration ladder and now carries a
// matching byType cost override instead of falling through to byRarity COMMON.
test("upgradeCost: Detour Sign overrides the rarity ladder with byType — 5/10/15", () => {
  assert.equal(upgradeCost("DETOUR_SIGN", 1), 5);
  assert.equal(upgradeCost("DETOUR_SIGN", 2), 10);
  assert.equal(upgradeCost("DETOUR_SIGN", 3), 15);
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
// 2026-08-15: Runner's High joined the 15-min duration ladder and now carries
// a matching byType cost override instead of falling through to byRarity COMMON.
test("upgradeCost: Runner's High overrides the rarity ladder with byType — 5/10/15", () => {
  assert.equal(upgradeCost("RUNNERS_HIGH", 1), 5);
  assert.equal(upgradeCost("RUNNERS_HIGH", 2), 10);
  assert.equal(upgradeCost("RUNNERS_HIGH", 3), 15);
});

// Batch 2026-08-09 item 1 (game-analyst REQUIRED reprice): LEG_CRAMP and
// WRONG_TURN no longer fall through to the byRarity ladder — they now carry a
// byType override, because their upgrades buy 15 minutes each instead of an
// hour. These two tests used LC/WT only as VEHICLES for the UNCOMMON ladder;
// that ladder is still covered, unweakened, by the Stealth Mode test directly
// below (and by the explicit byRarity-fallthrough test added at the end of this
// file). What is asserted here is the override that now takes precedence.
test("upgradeCost: Leg Cramp overrides the rarity ladder with byType", () => {
  assert.equal(upgradeCost("LEG_CRAMP", 1), 10);
  assert.equal(upgradeCost("LEG_CRAMP", 2), 20);
  assert.equal(upgradeCost("LEG_CRAMP", 3), 30);
});

// 2026-08-15: Stealth Mode joined the 15-min duration ladder and now carries
// a matching byType cost override instead of falling through to byRarity UNCOMMON.
test("upgradeCost: Stealth Mode overrides the rarity ladder with byType — 10/20/30", () => {
  assert.equal(upgradeCost("STEALTH_MODE", 1), 10);
  assert.equal(upgradeCost("STEALTH_MODE", 2), 20);
  assert.equal(upgradeCost("STEALTH_MODE", 3), 30);
});

test("upgradeCost: Wrong Turn overrides the rarity ladder with byType", () => {
  assert.equal(upgradeCost("WRONG_TURN", 1), 15);
  assert.equal(upgradeCost("WRONG_TURN", 2), 30);
  assert.equal(upgradeCost("WRONG_TURN", 3), 45);
});

// The byType override must be NARROW. Every other UNCOMMON type still falls
// through to byRarity — this is the assertion the two rewritten tests above
// used to carry, restated so the ladder itself stays pinned independently of
// which types happen to override it.
test("upgradeCost: byRarity UNCOMMON ladder still applies to non-overridden types", () => {
  for (const type of ["CAMPFIRE_REST"]) {
    assert.deepEqual(
      [1, 2, 3].map((lvl) => upgradeCost(type, lvl)),
      [10, 30, 90],
      `${type} must still use the UNCOMMON byRarity ladder`
    );
  }
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

// §3.4 duration standardization (2026-07-25): windowed upgradeable powerups run
// 1h base +1h/level → 1/2/3/4h. (§9-authorized existing-test literal update.)
//
// EXCEPT the two hard CCs. Batch 2026-08-09 item 1 (owner decision): a 4-hour
// Leg Cramp / Wrong Turn is oppressive, so each upgrade adds 15 MINUTES rather
// than an hour → 1h / 1h15 / 1h30 / 1h45. Base is unchanged, so an unupgraded
// cast is exactly as strong as it has always been. Durations are stamped into
// the effect row at use time, so this hits every app version on deploy and
// leaves in-flight effects alone.
const QUARTER = 15 * 60 * 1000;

test("upgradedDuration: Leg Cramp — 1h / 1h15m / 1h30m / 1h45m", () => {
  assert.equal(upgradedDuration("LEG_CRAMP", 0), 1 * HOUR);
  assert.equal(upgradedDuration("LEG_CRAMP", 1), 1 * HOUR + QUARTER);
  assert.equal(upgradedDuration("LEG_CRAMP", 2), 1 * HOUR + 2 * QUARTER);
  assert.equal(upgradedDuration("LEG_CRAMP", 3), 1 * HOUR + 3 * QUARTER);
});

// 2026-08-15 (owner decision): Runner's High joined the 15-minute upgrade
// ladder alongside Leg Cramp / Wrong Turn — 1h base, +15m per level.
test("upgradedDuration: Runner's High — 1h / 1h15m / 1h30m / 1h45m", () => {
  assert.equal(upgradedDuration("RUNNERS_HIGH", 0), 1 * HOUR);
  assert.equal(upgradedDuration("RUNNERS_HIGH", 1), 1 * HOUR + QUARTER);
  assert.equal(upgradedDuration("RUNNERS_HIGH", 2), 1 * HOUR + 2 * QUARTER);
  assert.equal(upgradedDuration("RUNNERS_HIGH", 3), 1 * HOUR + 3 * QUARTER);
});

// 2026-08-15 (owner decision): Stealth Mode joined the 15-minute upgrade
// ladder (supersedes the §3.4 2026-07-25 1/2/3/4h standardization).
test("upgradedDuration: Stealth Mode — 1h / 1h15m / 1h30m / 1h45m", () => {
  assert.equal(upgradedDuration("STEALTH_MODE", 0), 1 * HOUR);
  assert.equal(upgradedDuration("STEALTH_MODE", 1), 1 * HOUR + QUARTER);
  assert.equal(upgradedDuration("STEALTH_MODE", 2), 1 * HOUR + 2 * QUARTER);
  assert.equal(upgradedDuration("STEALTH_MODE", 3), 1 * HOUR + 3 * QUARTER);
});

test("upgradedDuration: Wrong Turn — 1h / 1h15m / 1h30m / 1h45m", () => {
  assert.equal(upgradedDuration("WRONG_TURN", 0), 1 * HOUR);
  assert.equal(upgradedDuration("WRONG_TURN", 1), 1 * HOUR + QUARTER);
  assert.equal(upgradedDuration("WRONG_TURN", 2), 1 * HOUR + 2 * QUARTER);
  assert.equal(upgradedDuration("WRONG_TURN", 3), 1 * HOUR + 3 * QUARTER);
});

// 2026-08-15: the 15-minute ladder now covers every non-shop, timed drop-pool
// powerup. POCKET_WATCH is the one deliberate holdout — it's shop-only
// (`storeOnlyTypes`), not drop-pool, so it was excluded from this change and
// keeps the standard +1h/level ladder. Pinned here so a future "simplify the
// ladder" refactor can't quietly drag it along too.
test("upgradedDuration: the 15-minute ladder excludes shop-only Pocket Watch", () => {
  assert.equal(upgradedDuration("POCKET_WATCH", 3), 4 * HOUR, "POCKET_WATCH keeps 4h at L3");
});

test("upgradedDuration: Detour Sign — 1h / 1h15m / 1h30m / 1h45m", () => {
  assert.equal(upgradedDuration("DETOUR_SIGN", 0), 1 * HOUR);
  assert.equal(upgradedDuration("DETOUR_SIGN", 1), 1 * HOUR + QUARTER);
  assert.equal(upgradedDuration("DETOUR_SIGN", 2), 1 * HOUR + 2 * QUARTER);
  assert.equal(upgradedDuration("DETOUR_SIGN", 3), 1 * HOUR + 3 * QUARTER);
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

// ---------------------------------------------------------------------------
// formatDuration — THE shared duration string (batch 2026-08-09 item 1)
// ---------------------------------------------------------------------------
//
// Before this batch three sites formatted durations independently, and the
// 15-minute ladder broke all three differently: usePowerup's `hoursText` would
// have rendered "1.25 hours", and the push handler's `attackWindowText` fell
// back to "75 minutes" for any non-integer hour count. Both now delegate here,
// so the feed line and the push notification about the SAME cast can no longer
// disagree. Target format is "1h 15m".
test("formatDuration: whole hours read naturally", () => {
  assert.equal(formatDuration(1 * HOUR), "1 hour");
  assert.equal(formatDuration(2 * HOUR), "2 hours");
  assert.equal(formatDuration(4 * HOUR), "4 hours");
  assert.equal(formatDuration(24 * HOUR), "24 hours");
});

test("formatDuration: the new quarter-hour ladder renders as 1h 15m", () => {
  assert.equal(formatDuration(1 * HOUR + 15 * 60 * 1000), "1h 15m");
  assert.equal(formatDuration(1 * HOUR + 30 * 60 * 1000), "1h 30m");
  assert.equal(formatDuration(1 * HOUR + 45 * 60 * 1000), "1h 45m");
});

test("formatDuration: sub-hour durations are plain minutes", () => {
  assert.equal(formatDuration(30 * 60 * 1000), "30 minutes");
  assert.equal(formatDuration(45 * 60 * 1000), "45 minutes");
  assert.equal(formatDuration(1 * 60 * 1000), "1 minute");
});

test("formatDuration: never emits a decimal hour", () => {
  for (let minutes = 1; minutes <= 8 * 60; minutes++) {
    const text = formatDuration(minutes * 60 * 1000);
    assert.ok(!/\d\.\d/.test(text), `decimal leaked for ${minutes}m: ${text}`);
  }
});

// The whole point of the shared helper: every ladder level of the two nerfed
// types must produce a clean string through the SAME function the feed and the
// push both call.
test("formatDuration: every LC/WT upgrade level renders cleanly", () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((lvl) => formatDuration(upgradedDuration("LEG_CRAMP", lvl))),
    ["1 hour", "1h 15m", "1h 30m", "1h 45m"]
  );
  assert.deepEqual(
    [0, 1, 2, 3].map((lvl) => formatDuration(upgradedDuration("WRONG_TURN", lvl))),
    ["1 hour", "1h 15m", "1h 30m", "1h 45m"]
  );
});

// ---------------------------------------------------------------------------
// Upgrade reprice (game-analyst REQUIRED, batch 2026-08-09 item 1)
// ---------------------------------------------------------------------------
//
// WRONG_TURN's canonical rarity is RARE, so without a byType override it would
// charge the RARE ladder [0,15,45,135] for what is now a 45-minute-longer
// freeze — the worst-value purchase in the game, and the death of the WT/LC
// upgrade coin sink. byType gives arithmetic cost for arithmetic duration.
test("upgradeCost: Leg Cramp uses the byType ladder [0,10,20,30]", () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((lvl) => upgradeCost("LEG_CRAMP", lvl)),
    [0, 10, 20, 30]
  );
});

test("upgradeCost: Wrong Turn uses the byType ladder [0,15,30,45]", () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((lvl) => upgradeCost("WRONG_TURN", lvl)),
    [0, 15, 30, 45]
  );
});

// L1 entry price is deliberately unchanged for both, so nothing a player has
// already budgeted for got more expensive.
test("upgradeCost: the L1 entry price is unchanged by the reprice", () => {
  assert.equal(upgradeCost("LEG_CRAMP", 1), 10);
  assert.equal(upgradeCost("WRONG_TURN", 1), 15);
});
