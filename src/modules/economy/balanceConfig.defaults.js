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
    POWER_OUTAGE: "UNCOMMON",
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
    "POWER_OUTAGE",
    "UMBRELLA",
    "RALLY_FLAG",
    "DRILL_SERGEANT",
    "PIGGY_BANK",
    "BOUNTY",
  ],

  // Which store-only types are ALSO barred from the DAILY reward box.
  //
  // These are two different questions and the spec's §4.3 literal conflated
  // them. `storeOnlyTypes` answers "can an in-race mystery box roll this?" —
  // no, for all seven. This key answers "can the daily spin award this as a
  // RARE prize?" — which was only ever no for these four (the old
  // POWERUPS2/3_GATED_TYPES lists). Imposter, Rainstorm and Signal Jammer HAVE
  // been winnable daily-box prizes for spinpowerups-capable clients all along.
  //
  // Using the seven-item list here would silently delete the daily box's entire
  // powerup prize pool — and the spec's own §5.3 example advertises
  // `itemOdds.powerups: [{ "type": "SIGNAL_JAMMER", "p": 0.5 }]`, which is only
  // possible if Signal Jammer remains daily-box winnable. Splitting the keys
  // keeps ONE authority per question, which is what D13 is actually after.
  dailyBoxExcludedTypes: [
    // Powerups Wave 5 are store-only and must never be awarded as a daily-box
    // prize either (they carry use-time validation the daily box can't satisfy).
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
  ],

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

  // [COMMON, UNCOMMON, RARE] by race position. `first` = leader, `last` = last
  // place; intermediate positions interpolate linearly. Trailing players get
  // better odds — this is the catch-up mechanic.
  positionOdds: {
    first: [0.48, 0.25, 0.27],
    last: [0.2, 0.35, 0.45],
  },

  // Coin cost to upgrade, indexed by level. Index 0 is the base form and is
  // always free. byType overrides byRarity for a single type (currently unused —
  // LUCKY_HORSESHOE's premium ladder was retired 2026-07-14).
  upgradeCosts: {
    byRarity: {
      COMMON: [0, 5, 15, 45],
      UNCOMMON: [0, 10, 30, 90],
      RARE: [0, 15, 45, 135],
    },
    byType: {},
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
  luckyHorseshoe: {
    rareChanceByLevel: [0, 0.2, 0.45, 1.0],
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
  {
    path: "luckyHorseshoe.rareChanceByLevel.1",
    min: 0,
    max: 0.5,
    rationale: "level 1 should not near-guarantee a rare",
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
