// Balance-config CODE DEFAULTS + soft bounds.
//
// This file and `balanceConfig.js` are the ONLY two modules permitted to define
// a rarity map, an upgrade cost ladder, or an odds table. Everything else
// (powerupOdds, powerupUpgrades, dailyBoxOdds, getEligiblePowerupPool, …) is a
// thin consumer of `getConfig()`. A structural guard test enforces this — if you
// are about to paste a table somewhere else, that test will fail, and it is
// right and you are wrong. Nine duplicated definitions across two repos is the
// problem this whole build exists to remove.
//
// The DB is authoritative (an admin edits it without a deploy). These defaults
// exist so a DB failure, a rolled-back migration, or a fresh environment still
// rolls sane boxes instead of throwing (D4).
//
// WHY BOUNDS LIVE HERE AND NOT IN THE CONFIG (§3.2): if an admin could edit the
// bounds, they could raise a bound and then exceed it — the guardrail would be
// circular and worthless. Changing a bound requires a deploy and a review.

// Every PowerupType enum value that can carry balance meaning. MYSTERY_BOX is
// deliberately excluded: it is the *unopened* placeholder status, never a rolled
// or purchasable powerup, so it has no rarity and must not be required to.
const BALANCE_POWERUP_TYPES = [
  "LEG_CRAMP",
  "RED_CARD",
  "SHORTCUT",
  "COMPRESSION_SOCKS",
  "PROTEIN_SHAKE",
  "RUNNERS_HIGH",
  "SECOND_WIND",
  "STEALTH_MODE",
  "WRONG_TURN",
  "FANNY_PACK",
  "TRAIL_MIX",
  "DETOUR_SIGN",
  "LUCKY_HORSESHOE",
  "CAMPFIRE_REST",
  "TRAIL_MAGNET",
  "POCKET_WATCH",
  "TRAIL_MINE",
  "PINECONE_TOSS",
  "SNEAKY_SWAP",
  "MIRROR",
  "CLEANSE",
  "IMPOSTER",
  "RAINSTORM",
  "SIGNAL_JAMMER",
  "LEECH",
  "DEFENSE_SCAN",
  "HITCHHIKE",
  "QUICK_RINSE",
  // Powerups Wave 5 (store-only) — carry balance meaning (rarity is cosmetic
  // only since none are droppable), so they must be present here and in
  // rarityByType below.
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

const RARITIES = ["COMMON", "UNCOMMON", "RARE"];

const ACCESSORY_WEIGHT_MODES = ["inverse", "uniform", "legacy"];

const SCHEMA_VERSION = 1;

// Config v1 == the live values at the time of this build, with exactly two
// deliberate corrections (D5):
//   * SHORTCUT is RARE. It was RARE in the drop table and COMMON in the upgrade
//     table; conflicts resolve toward the drop table (D7), which prod drop
//     history shows holds the newer intentional values. This raises SHORTCUT's
//     upgrade ladder from [0,5,15,45] to [0,15,45,135] going forward. Existing
//     upgradeLevel values are NOT recomputed — everything is forward-only.
//   * accessoryWeightMode is "inverse". The historical "legacy" mode weighted
//     accessories by price^(1+streakProgress), i.e. a 1500-coin accessory was up
//     to ~36x MORE likely than a cheap one — a prestige inversion currently
//     masked only because just 5 cosmetics are purchasable. It must be corrected
//     BEFORE the 61 testOnly cosmetics are flipped active.
//
// Note: aligning rarity on the drop table also moves RUNNERS_HIGH and
// PINECONE_TOSS from UNCOMMON to COMMON (they were already COMMON in the drop
// table). Their ladders get cheaper, forward-only.
const DEFAULT_CONFIG = {
  schemaVersion: SCHEMA_VERSION,

  // Canonical rarity for EVERY powerup — the single answer to "how rare is X?".
  // Covers the full enum so no lookup silently defaults to COMMON (audit
  // registers #11/#12: RED_CARD/SECOND_WIND/FANNY_PACK were missing, and
  // LEECH/DEFENSE_SCAN/HITCHHIKE/QUICK_RINSE had no rarity anywhere at all).
  rarityByType: {
    PROTEIN_SHAKE: "COMMON",
    TRAIL_MIX: "COMMON",
    DETOUR_SIGN: "COMMON",
    RUNNERS_HIGH: "COMMON",
    PINECONE_TOSS: "COMMON",
    TRAIL_MAGNET: "COMMON",

    LEG_CRAMP: "UNCOMMON",
    STEALTH_MODE: "UNCOMMON",
    WRONG_TURN: "UNCOMMON",
    CAMPFIRE_REST: "UNCOMMON",

    SHORTCUT: "RARE",
    COMPRESSION_SOCKS: "RARE",
    LUCKY_HORSESHOE: "RARE",
    POCKET_WATCH: "RARE",
    TRAIL_MINE: "RARE",
    SNEAKY_SWAP: "RARE",
    MIRROR: "RARE",
    CLEANSE: "RARE",
    RED_CARD: "RARE",
    SECOND_WIND: "RARE",
    FANNY_PACK: "RARE",

    IMPOSTER: "RARE",
    RAINSTORM: "RARE",
    SIGNAL_JAMMER: "RARE",
    LEECH: "RARE",
    DEFENSE_SCAN: "RARE",
    HITCHHIKE: "RARE",
    QUICK_RINSE: "RARE",

    // Powerups Wave 5 — rarity is COSMETIC only (none are droppable), so these
    // values just drive icon tinting. Per spec §5.
    UPRISING: "RARE",
    DECOY: "RARE",
    POWER_OUTAGE: "RARE",
    RALLY_FLAG: "UNCOMMON",
    DRILL_SERGEANT: "UNCOMMON",
    BOUNTY: "UNCOMMON",
    GHOST_PEPPER: "COMMON",
    COIN_FLIP: "COMMON",
    MYSTERY_POTION: "COMMON",
    UMBRELLA: "COMMON",
    PIGGY_BANK: "COMMON",
  },

  // What a mystery box may actually roll, per tier. A type having a rarity does
  // NOT make it droppable — it must be listed here. CAMPFIRE_REST and
  // TRAIL_MAGNET intentionally have a rarity but no drop slot (retired from
  // generation in 1.1.7; their effect code stays for in-flight effects).
  dropPool: {
    COMMON: [
      "PROTEIN_SHAKE",
      "TRAIL_MIX",
      "DETOUR_SIGN",
      "RUNNERS_HIGH",
      "PINECONE_TOSS",
    ],
    // RALLY_FLAG (2026-07-26, docs/team-only-drop-pool-requirements.md): moved
    // OUT of storeOnlyTypes and into the drop pool, but it is TEAM-ONLY — see
    // `teamOnlyTypes` below. Its rarity was already UNCOMMON, which is the tier
    // it has to sit in for rarityByType and dropPool to agree.
    UNCOMMON: ["LEG_CRAMP", "STEALTH_MODE", "WRONG_TURN", "RALLY_FLAG"],
    RARE: [
      "RED_CARD",
      "SECOND_WIND",
      "COMPRESSION_SOCKS",
      // FANNY_PACK REMOVED from generation (batch 2026-08-09 item 8a). It keeps
      // its rarityByType entry — validateConfig requires rarity coverage, and
      // rarity-without-a-drop-slot is the established retirement pattern
      // (CAMPFIRE_REST / TRAIL_MAGNET). Held copies still work and the
      // slot-revert on expiry is untouched; the auto-activate and re-roll
      // special cases in openMysteryBox become dead code and are left in place
      // to keep the diff minimal.
      "LUCKY_HORSESHOE",
      "TRAIL_MINE",
      "SNEAKY_SWAP",
      "SHORTCUT",
      "CLEANSE",
      "MIRROR",
      // POWER_OUTAGE joins the RARE tier (batch 2026-08-09 item 6). A
      // slot-for-slot swap with the Fanny Pack removed above: the RARE tier
      // weight stays 9.5, so every other type's odds are byte-identical.
      // Also removed from storeOnlyTypes below — the two lists are the
      // disjoint authorities and BOTH had to change (D13).
      "POWER_OUTAGE",
    ],
  },

  // THE single drop-exclusion authority (D13). Store-only powerups: buyable with
  // coins, never awarded by a mystery box or a daily box. Previously this lived
  // as hardcoded POWERUPS2/3_GATED_TYPES lists inside getEligiblePowerupPool —
  // a second authority, which is the exact class of bug being removed.
  //
  // NOTE this is *drop* exclusion only. Which CLIENTS may see a type in the shop
  // is a frozen-binary compatibility question and stays hardcoded in
  // constants/powerupGating.js. That must never become admin-editable: an admin
  // toggle there would expose a type to a build that cannot render it.
  storeOnlyTypes: [
    // Pocket Watch (2026-07-24, owner decision): pulled OUT of the in-race
    // mystery-box drop pool and sold in the shop at the cheapest tier instead.
    // Store-only, NOT retired — every already-owned copy still works, and like
    // every shop item it stays winnable from the DAILY spin (the spin pool IS
    // the shop catalog since 2026-07-28).
    "POCKET_WATCH",
    "IMPOSTER",
    "RAINSTORM",
    "SIGNAL_JAMMER",
    "LEECH",
    "DEFENSE_SCAN",
    "HITCHHIKE",
    "QUICK_RINSE",
    // Powerups Wave 5 — all store-only, never rolled from an in-race mystery box.
    "UPRISING",
    "GHOST_PEPPER",
    "COIN_FLIP",
    "MYSTERY_POTION",
    "DECOY",
    // POWER_OUTAGE deliberately ABSENT (batch 2026-08-09 item 6): it is now
    // box-droppable as a RARE. This list and the code default are UNIONED by
    // enforceStoreOnlyExclusion on every config load, so leaving it here would
    // silently re-strip it from the drop pool after any deploy no matter what
    // the live config says. Its shop row is hidden separately, at deploy time.
    "UMBRELLA",
    // RALLY_FLAG deliberately ABSENT (2026-07-26): it is now droppable, but only
    // in a team race. See `teamOnlyTypes`.
    "DRILL_SERGEANT",
    "PIGGY_BANK",
    "BOUNTY",
  ],

  // Droppable, but ONLY when the race is a team race
  // (docs/team-only-drop-pool-requirements.md).
  //
  // This is a SECOND question, distinct from the list above, and the two must
  // not be conflated (the D13 rule):
  //   storeOnlyTypes -> can an in-race mystery box roll this at all?
  //   teamOnlyTypes  -> …but only when the race is a team race?
  // (The daily spin is a third surface but no longer configured here: its
  // prize pool is the shop catalog as the client sees it, since 2026-07-28.)
  //
  // Rally Flag is the first member because its EFFECT is exclusively a team
  // effect — usePowerup hard-rejects it in a solo race with 400 INVALID_TARGET,
  // so dropping one into a solo race would be a dead inventory slot. Uprising
  // and Power Outage are the obvious next two; the seam is general, not
  // special-cased to Rally Flag.
  //
  // Reading this key is default-safe: absent or not an array means "no team
  // restriction", i.e. exactly the pre-2026-07-26 behaviour.
  teamOnlyTypes: ["RALLY_FLAG"],

  // Coins paid for discarding a HELD in-race powerup, by rarity (batch
  // 2026-08-08 item 1). Lives here rather than in an env so the prices are
  // admin-tunable without an App Store release, exactly like the other balance
  // numbers.
  //
  // OPTIONAL KEY, following the `teamOnlyTypes` precedent above: a config
  // stored before this key existed simply has none and resolves to these code
  // defaults through mergeOverDefaults, so `undefined` MUST stay valid.
  // SCHEMA_VERSION is deliberately NOT bumped — stored rows predate the key and
  // a version bump would hard-reject every one of them.
  //
  // Reading this key is default-safe: a missing rarity, or a missing block
  // entirely, falls back to the COMMON price (the floor). An UNOPENED
  // MYSTERY_BOX is priced at 0 in code, not here — that is a rule, not a knob
  // (paying for unopened boxes makes never-opening dominant, exploit S4).
  discardPrices: {
    COMMON: 2,
    UNCOMMON: 5,
    RARE: 10,
  },

  // `dailyBoxExcludedTypes` REMOVED 2026-07-28 (owner decision). The daily-spin
  // prize pool is now the shop catalog exactly as the spinning client sees it
  // (isPowerupVisibleToClient over findActive rows — see
  // getEligiblePowerupPool). "Available in the shop ⟺ winnable from the daily
  // spin" holds by construction; hiding an item (`active=false` / `testOnly`)
  // is the one and only disable switch for both surfaces. A stored config that
  // still carries the old key is ignored.

  // Mystery Potion (§3.4): weighted outcome pool rolled at use-time. Weights are
  // relative; the roller normalizes by their sum. Outcome tokens:
  //   * a bare PowerupType routes through that type's normal apply path
  //     (PROTEIN_SHAKE/RUNNERS_HIGH/COMPRESSION_SOCKS on self; PINECONE_TOSS/
  //     LEG_CRAMP/SHORTCUT on a random alive enemy),
  //   * "*_SELF" applies the debuff to the caster (self-sourced → not
  //     Cleanse/Quick-Rinse removable),
  //   * "COIN_REFUND" refunds 2x the potion price.
  // Owner mix (D4): 50% helpful / 25% attack a random enemy / 15% defense-jackpot
  // / 10% self-harm.
  mysteryPotion: {
    pool: [
      { outcome: "PROTEIN_SHAKE", weight: 30 },
      { outcome: "RUNNERS_HIGH", weight: 20 },
      { outcome: "PINECONE_TOSS", weight: 10 },
      { outcome: "LEG_CRAMP", weight: 10 },
      { outcome: "SHORTCUT", weight: 5 },
      { outcome: "COMPRESSION_SOCKS", weight: 10 },
      { outcome: "COIN_REFUND", weight: 5 },
      { outcome: "LEG_CRAMP_SELF", weight: 5 },
      { outcome: "WRONG_TURN_SELF", weight: 5 },
    ],
  },

  // Relative weight WITHIN a tier once the tier has been chosen. Absent == 1.0.
  // RED_CARD at 0.5 is the "red card nerf": half as likely as a uniform rare
  // pick, with the freed mass spread evenly over the other rares. The tier's
  // total probability and the position curve are untouched.
  typeWeights: {
    RED_CARD: 0.5,
  },

  // Position-aware drop rules. These act STRICTLY WITHIN an already-chosen
  // rarity tier — the tier distribution from `positionOdds` below is never
  // touched by them. That is a hard invariant, not a nicety: the shipped odds
  // sheet hides itself entirely if the `rarity` block stops summing to 1.0.
  //
  // Clearing all four lists restores exact pre-2026-07-26 behaviour with no
  // deploy, which is this feature's kill switch.
  positionRules: {
    // HARD EXCLUSIONS. Only for items the server refuses to let this player use,
    // or that are mechanically incapable of firing. Nothing else belongs here.
    //
    // Excluded when the player is at/tied for the most steps — both throw a 400
    // at use time for a leader, so dropping them hands out a brick.
    leaderExcluded: ["RED_CARD", "SECOND_WIND"],
    // Excluded when nobody is behind the player — Trail Mine can only detonate
    // on a player crossing the planter's step total from below.
    lastPlaceExcluded: ["TRAIL_MINE"],

    // DOWN-WEIGHTS. Relative weight multipliers for items that still function
    // but are low-value at one end of the field. 1.0 == no change. All four
    // entries below are owner-approved judgment calls, not defect fixes, and a
    // down-weight must NEVER become a removal.
    //
    // Applied toward the FRONT. Runner's High works fine in first place, it just
    // feels flat when you have already won the position.
    // POWER_OUTAGE (batch 2026-08-09 item 6, game-analyst REQUIRED). Without
    // it, leaders net 5.34x more Power Outages per race than last place —
    // box-VOLUME dominance swamps the per-box trailer bias — and a field-wide
    // 30-minute freeze becomes a lead-preservation tool. At 0.3 the per-race
    // ratio is 1.76:1 and the peak holder is mid-pack. A flat type-weight cut
    // was rejected: it scales BOTH ends and fixes nothing.
    leadingDownweight: { RUNNERS_HIGH: 0.5, POWER_OUTAGE: 0.3 },
    // Applied toward the BACK. These depend on being attacked, which is rare at
    // the back of the field.
    trailingDownweight: { CLEANSE: 0.5, MIRROR: 0.5, STEALTH_MODE: 0.5 },

    // Normalized position (0 = leader, 1 = last) at which each down-weight group
    // reaches full strength. Between the threshold and mid-field the multiplier
    // lerps toward 1.0, so there is no cliff at any position.
    leadingDownweightFrom: 0.4, // full strength at/below this
    trailingDownweightFrom: 0.6, // full strength at/above this
  },

  // [COMMON, UNCOMMON, RARE] by race position. `first` = leader, `last` = last
  // place; intermediate positions interpolate linearly. Trailing players get
  // better odds — this is the catch-up mechanic.
  positionOdds: {
    first: [0.48, 0.25, 0.27],
    last: [0.2, 0.35, 0.45],
  },

  // Coin cost to upgrade, indexed by level. Index 0 is the base form and is
  // always free. byType overrides byRarity for a single type.
  upgradeCosts: {
    byRarity: {
      COMMON: [0, 5, 15, 45],
      UNCOMMON: [0, 10, 30, 90],
      RARE: [0, 15, 45, 135],
    },
    // byType overrides (batch 2026-08-09, game-analyst REQUIRED). These are
    // config, not code: they can be re-tuned with a PUT and no deploy, and they
    // have no soft-bound coverage.
    byType: {
      // Item 1 — the WT/LC duration nerf makes each upgrade worth 15 minutes
      // instead of an hour, so the geometric byRarity ladders would leave L3 as
      // the worst-value purchase in the game and kill the WT/LC upgrade sink
      // (18.7% of the total upgrade sink). Note WRONG_TURN's canonical rarity
      // is RARE, so without this it would charge [0,15,45,135] — not the
      // UNCOMMON ladder one might assume from its drop tier.
      //
      // Arithmetic cost for arithmetic duration: flat 43 / 58 steps per coin at
      // every level, and the L1 entry price is unchanged for both, so nothing a
      // player already budgeted for got more expensive.
      LEG_CRAMP: [0, 10, 20, 30],
      WRONG_TURN: [0, 15, 30, 45],
      // Item 8b — the Horseshoe upgrade ladder is RETIRED, but the type stays
      // in `upgradeableTypes` on purpose. A client's "is this upgradeable?"
      // decision is BUNDLED in the app binary, so removing it here would leave
      // every frozen build still offering levels 1-3 and taking a permanent 400
      // ("not upgradeable"). Zeroing the cost instead makes those upgrades free
      // and inert; the new build hides the UI. No refund for the 4 upgrades ever
      // purchased (owner decision) — all were consumed, zero upgraded copies are
      // currently held.
      LUCKY_HORSESHOE: [0, 0, 0, 0],
    },
  },

  // Which types have an upgrade ladder at all. Everything else is level 0 only.
  upgradeableTypes: [
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
  ],

  // Probability that a Lucky Horseshoe forces the next box to RARE, by upgrade
  // level. The floor is always UNCOMMON. Index 0 = unupgraded.
  //
  // This replaces a binary cliff (`level >= 3 ? RARE : UNCOMMON`) under which
  // levels 1 and 2 were literally no-ops — players paid 15 and 45 coins for zero
  // change in outcome. Forward-only: rarity is rolled at USE time and frozen
  // into the effect's metadata, so effects already in flight resolve on the
  // value they were created with and need no migration.
  // Batch 2026-08-09 item 8b: 100% RARE at EVERY level. The ramp is retired —
  // the Horseshoe is now simply "your next box is rare", which is what players
  // always assumed it did. Levels 1-3 buy nothing, which is why the cost ladder
  // is zeroed in upgradeCosts.byType above rather than the type being pulled
  // from upgradeableTypes (that would 400 every frozen client that still offers
  // the upgrade).
  //
  // EV note, for copy and expectations: a forced-rare box is worth 0.94-1.01x a
  // normal box mid-pack but only 0.51x for the LEADER, because leaderExcluded
  // strips the high-swing rares (Red Card, Second Wind) from their pool.
  // "Guaranteed rare" is a feel upgrade, not an EV upgrade. Accepted.
  luckyHorseshoe: {
    rareChanceByLevel: [1, 1, 1, 1],
  },

  dailyBox: {
    // Streak length at which odds stop improving.
    streakCap: 30,
    // `first` = a 1-day streak, `last` = at/above the cap.
    odds: {
      first: [0.7, 0.25, 0.05],
      last: [0.2, 0.35, 0.45],
    },
    // [min, max] coins, interpolated by streak progress. RARE_FALLBACK applies
    // when RARE cannot pay a prize (every accessory owned, no powerup pool).
    coinRanges: {
      COMMON: [10, 30],
      UNCOMMON: [40, 80],
      RARE_FALLBACK: [100, 200],
    },
    // Share of RARE hits paying coins instead of a powerup. 0 == legacy.
    rareCoinsShare: 0,
    // How an accessory is chosen from the unowned pool:
    //   "inverse" — cheaper items are MORE likely (correct prestige gradient),
    //   "uniform" — every unowned accessory equally likely,
    //   "legacy"  — price^(1+streakProgress): pricier items up to ~36x MORE
    //               likely. Retained ONLY so a rollback can reproduce historical
    //               behaviour. It must never be the active value in prod.
    accessoryWeightMode: "inverse",
  },
};

// Soft bounds (D11): a save outside these warns and requires an explicit
// override, which is recorded in history as boundOverride. They are NOT hard
// limits — deliberate experiments are allowed, typos are not silent.
//
// Each entry: { path, min, max, rationale }. `path` supports a single `*`
// wildcard segment for map keys.
const SOFT_BOUNDS = [
  {
    path: "dailyBox.coinRanges.*",
    min: 5,
    max: 500,
    rationale:
      "the daily box is the largest recurring income source; [0,0] silently zeroes it",
  },
  {
    path: "positionOdds.*.RARE",
    min: 0,
    max: 0.6,
    rationale: "above ~60% rare, rares stop meaning anything",
  },
  {
    path: "upgradeCosts.byRarity.*.3",
    min: 10,
    max: 1000,
    rationale: "max-out cost sanity",
  },
  {
    path: "dailyBox.streakCap",
    min: 7,
    max: 90,
    rationale: "a cap outside this makes the streak curve meaningless or unreachable",
  },
  // luckyHorseshoe.rareChanceByLevel.1 bound DELETED (batch 2026-08-09 item
  // 8b). It guarded a RAMP that no longer exists. Widening it was rejected:
  // [1,1,1,1] trips the level-1 bound, which would force every future save of
  // this config through `acknowledgeBoundWarnings` — and that stamps a sticky
  // boundOverride=true on the row, masking genuine warnings from then on. A
  // bound protecting a retired mechanic is worse than no bound.
  {
    path: "discardPrices.*",
    min: 0,
    max: 50,
    rationale:
      "discarding is a coin FAUCET gated only by a 40/day cap; a price above ~50 makes farming boxes for coins beat playing the race",
  },
];

// The `bounds` block served by GET /admin/balance-config so the UI can warn
// BEFORE submitting (D11/D12) rather than only on a rejected save.
function serializeBounds() {
  const out = {};
  for (const b of SOFT_BOUNDS) out[b.path] = [b.min, b.max];
  return out;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultConfig() {
  return deepClone(DEFAULT_CONFIG);
}

module.exports = {
  BALANCE_POWERUP_TYPES,
  RARITIES,
  ACCESSORY_WEIGHT_MODES,
  SCHEMA_VERSION,
  DEFAULT_CONFIG,
  SOFT_BOUNDS,
  serializeBounds,
  defaultConfig,
  deepClone,
};
