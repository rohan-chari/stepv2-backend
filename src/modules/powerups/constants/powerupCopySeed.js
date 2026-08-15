// Canonical seed copy for the PowerupCopy catalog (§9.5).
//
// One entry per USER-RENDERABLE PowerupType. `MYSTERY_BOX` is deliberately
// absent: it is an unopened-container inventory state, not a usable powerup with
// use-sheet or effect-rail copy.
//
// Provenance: transcribed verbatim from the frontend maps this migration
// replaces (`_powerupNames`, `_powerupDescriptions`,
// `_powerupShortDescriptions`, and the upgrade tier labels), so day-one behavior
// is identical apart from two intentional changes:
//   * LEECH's description now states 60 min (§7.5.1). The backend is the
//     authoritative source for a powerups3 client; the app's BUNDLED emergency
//     copy stays duration-neutral because a new binary can also talk to an OLD
//     backend that still applies 30 minutes.
//   * HITCHHIKE and QUICK_RINSE are new.
//
// `shortDescription` is null wherever no short form existed before — the client
// then omits the effect-rail subtitle entirely rather than substituting a
// truncated description, which would introduce copy that never previously
// existed.
//
// `upgradeTierLabels` has exactly 4 entries for every upgradeable type (see
// UPGRADEABLE_TYPES in src/utils/powerupUpgrades.js) and is empty otherwise.
// Upgrade COSTS are already backend-driven; putting the labels here makes tiers
// fully data-driven, since they encode durations and magnitudes that drift for
// exactly the reason the Leech copy did.

const POWERUP_COPY_SEED = [
  {
    powerupType: "LEG_CRAMP",
    name: "Leg Cramp",
    description: "Freeze a rival's steps for 1 hour",
    shortDescription: "Steps frozen",
    // Batch 2026-08-09 item 1: +15m per level, not +1h.
    upgradeTierLabels: [
      "Freeze 1h",
      "Freeze 1h 15m",
      "Freeze 1h 30m",
      "Freeze 1h 45m",
    ],
  },
  {
    powerupType: "RED_CARD",
    name: "Red Card",
    description: "Remove 10% of the leader's steps",
    shortDescription: null,
    upgradeTierLabels: [],
  },
  {
    powerupType: "SHORTCUT",
    name: "Shortcut",
    description: "Steal 1,000 steps from a rival",
    shortDescription: null,
    upgradeTierLabels: [
      "Steal up to 1,000 steps",
      "Steal up to 1,500 steps",
      "Steal up to 2,000 steps",
      "Steal up to 3,000 steps",
    ],
  },
  {
    powerupType: "COMPRESSION_SOCKS",
    name: "Compression Socks",
    description: "Shield against the next attack",
    shortDescription: "Shielded from next attack",
    upgradeTierLabels: ["Shield 24h", "Shield 30h", "Shield 36h", "Shield 48h"],
  },
  {
    powerupType: "PROTEIN_SHAKE",
    name: "Protein Shake",
    description: "+1,500 bonus steps instantly",
    shortDescription: null,
    upgradeTierLabels: [
      "+1,500 steps",
      "+2,250 steps",
      "+3,000 steps",
      "+4,500 steps",
    ],
  },
  {
    powerupType: "RUNNERS_HIGH",
    name: "Runner's High",
    description: "2x steps for 1 hour",
    shortDescription: "2x steps",
    // 2026-08-15: joined the 15-min upgrade ladder, +15m per level not +1h.
    upgradeTierLabels: [
      "2x for 1h",
      "2x for 1h 15m",
      "2x for 1h 30m",
      "2x for 1h 45m",
    ],
  },
  {
    powerupType: "SECOND_WIND",
    name: "Second Wind",
    description: "Bonus steps based on how far behind you are",
    shortDescription: null,
    upgradeTierLabels: [],
  },
  {
    powerupType: "STEALTH_MODE",
    name: "Stealth Mode",
    description:
      "Hide your name, steps, and position on the track for 1 hour",
    shortDescription: "Progress hidden",
    // 2026-08-15: joined the 15-min upgrade ladder, +15m per level not +1h.
    upgradeTierLabels: [
      "Hide 1h",
      "Hide 1h 15m",
      "Hide 1h 30m",
      "Hide 1h 45m",
    ],
  },
  {
    powerupType: "WRONG_TURN",
    name: "Wrong Turn",
    description: "Reverse a rival's steps for 1 hour",
    shortDescription: "Steps reversed",
    // Batch 2026-08-09 item 1: +15m per level, not +1h.
    upgradeTierLabels: [
      "Reverse 1h",
      "Reverse 1h 15m",
      "Reverse 1h 30m",
      "Reverse 1h 45m",
    ],
  },
  {
    powerupType: "FANNY_PACK",
    name: "Fanny Pack",
    description: "Unlock an extra powerup slot",
    shortDescription: "Extra powerup slot",
    upgradeTierLabels: [],
  },
  {
    powerupType: "TRAIL_MIX",
    name: "Trail Mix",
    description: "+100 steps per unique powerup type used",
    shortDescription: null,
    upgradeTierLabels: [
      "+100 steps per unique type",
      "+150 steps per unique type",
      "+200 steps per unique type",
      "+300 steps per unique type",
    ],
  },
  {
    powerupType: "DETOUR_SIGN",
    name: "Detour Sign",
    description: "Hide the entire leaderboard from a rival for 1 hour",
    shortDescription: "Leaderboard hidden",
    // 2026-08-15: joined the 15-min upgrade ladder, +15m per level not +1h.
    upgradeTierLabels: [
      "Hide leaderboard 1h",
      "Hide leaderboard 1h 15m",
      "Hide leaderboard 1h 30m",
      "Hide leaderboard 1h 45m",
    ],
  },
  {
    powerupType: "LUCKY_HORSESHOE",
    name: "Lucky Horseshoe",
    // Batch 2026-08-09 item 8b: the guarantee is now unconditional at every
    // level, and a forced box can no longer hand back another Horseshoe.
    description: "Guarantees a rare powerup from your next box; can't grant another Horseshoe",
    shortDescription: "Next box rare",
    // DELIBERATELY EMPTY while LUCKY_HORSESHOE is still in `upgradeableTypes` —
    // the one type where those two things disagree, and on purpose:
    //   * it must STAY upgradeable, because a frozen binary decides "is this
    //     upgradeable?" from its BUNDLED table and would take a permanent 400
    //     if the server dropped it (upgradeCosts.byType zeroes the price at
    //     every level instead, making those upgrades free and inert — the
    //     numbers live in balanceConfig.defaults, not here, and must not be
    //     restated as a bracketed ladder literal or the balanceConfig
    //     structural guard reads this comment as a duplicated cost table);
    //   * but it must ship NO tier labels, because the server snapshot wins
    //     over the client's bundled fallback, and a NEW build hides the upgrade
    //     UI precisely when the label list comes back empty. Leaving the four
    //     labels here would make new builds render a free, inert upgrade UI for
    //     a ladder that no longer does anything.
    // The 4-entries-per-upgradeable-type invariant carries an explicit
    // exception for this type; see getPowerupCopyCatalog.test.js.
    upgradeTierLabels: [],
  },
  {
    powerupType: "CAMPFIRE_REST",
    name: "Campfire Rest",
    description: "Freeze for 30 min, then multiply steps for up to 90 min",
    shortDescription: "Frozen, then boosted",
    upgradeTierLabels: [
      "2.25x boost",
      "2.5x boost",
      "2.75x boost",
      "3x boost",
    ],
  },
  {
    powerupType: "TRAIL_MAGNET",
    name: "Trail Magnet",
    description: "Pull your next mystery box 1,000 steps closer",
    shortDescription: null,
    upgradeTierLabels: [
      "Box 1,000 steps closer",
      "Box 1,500 steps closer",
      "Box 2,000 steps closer",
      "Box 3,000 steps closer",
    ],
  },
  {
    powerupType: "POCKET_WATCH",
    name: "Pocket Watch",
    description: "Extend all active timed buffs",
    shortDescription: "Buffs extended",
    upgradeTierLabels: ["Extend 1h", "Extend 2h", "Extend 3h", "Extend 4h"],
  },
  {
    powerupType: "TRAIL_MINE",
    name: "Trail Mine",
    // Item 4 (2026-07-26) — comms fix. The old copy never said the trap sits at
    // YOUR OWN step count, so a runaway leader would plant one far above the
    // whole field, nobody would ever cross it, and it read as "broken".
    description:
      "Buries a trap at your current step count. It detonates on the first rival whose step total crosses that number. If you're way out front, nobody may ever reach it.",
    shortDescription: "Mine planted at your step count",
    upgradeTierLabels: [
      "3% penalty",
      "5% penalty",
      "8% penalty",
      "12% penalty",
    ],
  },
  {
    powerupType: "PINECONE_TOSS",
    name: "Pinecone Toss",
    description: "Hit the runner directly ahead or behind you",
    shortDescription: null,
    upgradeTierLabels: [
      "-750 steps",
      "-1,000 steps",
      "-1,500 steps",
      "-2,250 steps",
    ],
  },
  {
    powerupType: "SNEAKY_SWAP",
    name: "Sneaky Swap",
    description: "Steal a random powerup from a rival",
    shortDescription: null,
    upgradeTierLabels: [],
  },
  {
    powerupType: "MIRROR",
    name: "Mirror",
    description: "Reflect the next attack back at the attacker",
    shortDescription: "Reflects next attack",
    upgradeTierLabels: [],
  },
  {
    powerupType: "CLEANSE",
    name: "Cleanse",
    description: "Remove all debuffs an opponent placed on you",
    shortDescription: null,
    upgradeTierLabels: [],
  },
  {
    powerupType: "IMPOSTER",
    name: "Imposter",
    description:
      "Swap leaderboard positions with a rival for 1 hour (cosmetic). Mirrors can't reflect it; Compression Socks block it",
    shortDescription: null,
    upgradeTierLabels: [],
  },
  {
    powerupType: "RAINSTORM",
    name: "Rainstorm",
    description:
      "Everyone else's steps count for half for 1 hour. Mirrors can't reflect it; Compression Socks keep a racer dry",
    shortDescription: "Steps halved by rain",
    upgradeTierLabels: [],
  },
  {
    powerupType: "SIGNAL_JAMMER",
    name: "Signal Jammer",
    description:
      "Jam a rival's signal. They can't use any powerups for 1 hour. Mirrors can't reflect it; Compression Socks block it",
    shortDescription: "Powerups jammed",
    upgradeTierLabels: [],
  },
  {
    // §7.5.1 — the ONE intentional copy change to a pre-existing type. The
    // backend is authoritative and always describes the 60-minute product it
    // creates for a powerups3 request. A frozen binary never reads this row; it
    // renders its own bundled 30-minute string and receives a 30-minute effect.
    powerupType: "LEECH",
    name: "Leech",
    description:
      "For 60 min, every 2 steps you take steals 1 step from a chosen rival and adds it to your score. Compression Socks block it; Mirrors can't reflect it",
    shortDescription: "Steps being stolen",
    upgradeTierLabels: [],
  },
  {
    powerupType: "DEFENSE_SCAN",
    name: "X-Ray",
    description:
      "Instantly reveal every opponent's active defenses (shields, mirrors, and decoys)",
    shortDescription: null,
    upgradeTierLabels: [],
  },
  {
    powerupType: "HITCHHIKE",
    name: "Hitchhike",
    description:
      "For 60 min, every step a chosen rival takes is copied into your score. They lose nothing. Compression Socks block it; Mirrors can't reflect it",
    shortDescription: "Steps being copied",
    upgradeTierLabels: [],
  },
  {
    powerupType: "QUICK_RINSE",
    name: "Quick Rinse",
    description:
      "Cut the remaining time on every opponent effect currently on you in half. Your own buffs stay put",
    shortDescription: null,
    upgradeTierLabels: [],
  },
  {
    powerupType: "QUICKSAND",
    name: "Quicksand",
    description: "Freeze the steps of up to three rivals for 1 hour. Compression Socks block each target independently; Mirrors can't reflect it",
    shortDescription: "Steps frozen",
    upgradeTierLabels: [],
  },
  // ── Powerups Wave 5 (store-only, `powerups5`-gated). All new; never
  // upgradeable this wave, so upgradeTierLabels is empty for each. ──────────
  {
    powerupType: "UPRISING",
    name: "Uprising",
    description:
      "While you're in the bottom half of the standings, you and every racer below the midpoint get 2x steps for 1 hour",
    shortDescription: "2x steps",
    upgradeTierLabels: [],
  },
  {
    powerupType: "GHOST_PEPPER",
    name: "Ghost Pepper",
    description:
      "3x steps for 30 min, then a 30-min burnout where your steps are frozen. Self-inflicted, so Cleanse and Quick Rinse can't remove it",
    shortDescription: "Boosted, then frozen",
    upgradeTierLabels: [],
  },
  {
    powerupType: "COIN_FLIP",
    name: "Coin Flip",
    description:
      "Flip a coin: heads doubles your steps for 1 hour, tails halves them. Self-inflicted, so no shield or cleanse changes it",
    shortDescription: "Steps doubled or halved",
    upgradeTierLabels: [],
  },
  {
    powerupType: "MYSTERY_POTION",
    name: "Mystery Potion",
    description:
      "Drink for a random effect: it might help you, hit a rival, or backfire",
    shortDescription: null,
    upgradeTierLabels: [],
  },
  {
    powerupType: "DECOY",
    name: "Decoy",
    description:
      "The next single-target attack aimed at you is redirected to a random rival. Lasts until it triggers or 24 hours",
    shortDescription: "Redirects next attack",
    upgradeTierLabels: [],
  },
  {
    powerupType: "POWER_OUTAGE",
    name: "Power Outage",
    description:
      "Jam every rival. They can't use powerups for 30 minutes. Compression Socks keep one racer online; Mirrors can't reflect it",
    shortDescription: "Powerups jammed",
    upgradeTierLabels: [],
  },
  {
    powerupType: "UMBRELLA",
    name: "Umbrella",
    description:
      "Immune to area attacks like Rainstorm and Power Outage for 12 hours. Doesn't stop targeted hits",
    shortDescription: "Area attacks blocked",
    upgradeTierLabels: [],
  },
  {
    powerupType: "RALLY_FLAG",
    name: "Rally Flag",
    description:
      "Team races only: give every teammate 1.25x steps for 1 hour",
    shortDescription: "Team boosted",
    upgradeTierLabels: [],
  },
  {
    powerupType: "DRILL_SERGEANT",
    name: "Drill Sergeant",
    description:
      "Dare a rival to hit 3,000 steps in 1 hour or lose 1,500. Mirrors reflect it; Compression Socks block it",
    shortDescription: "Dare or lose steps",
    upgradeTierLabels: [],
  },
  {
    powerupType: "PIGGY_BANK",
    name: "Piggy Bank",
    description:
      "For 24 hours, bank 1 coin per 300 steps (up to 80). Paid out when it fills or the race ends",
    shortDescription: "Banking coins",
    upgradeTierLabels: [],
  },
  {
    powerupType: "BOUNTY",
    name: "Bounty",
    description:
      "Put a bounty on a rival ahead of you: out-place them by race end to collect 150 coins. Not for team races",
    shortDescription: "Bounty placed",
    upgradeTierLabels: [],
  },
];

// Every user-renderable type, in catalog order. MYSTERY_BOX is excluded.
const POWERUP_COPY_TYPES = POWERUP_COPY_SEED.map((row) => row.powerupType);

module.exports = { POWERUP_COPY_SEED, POWERUP_COPY_TYPES };
