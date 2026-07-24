// Item 9 (2026-07-24): a stable, code-level category for every powerup, surfaced
// additively on the powerup shop catalog so the store can offer
// All / Offense / Defense / Utility pills. No migration — this is a pure map.
//
// Buckets (owner spec, finalized against the live catalog):
//   * offense = anything that hits another racer — the TARGETED_TYPES set
//     (LEG_CRAMP, SHORTCUT, WRONG_TURN, DETOUR_SIGN, SNEAKY_SWAP, IMPOSTER,
//     SIGNAL_JAMMER, LEECH, HITCHHIKE, DRILL_SERGEANT, BOUNTY) plus the
//     auto-targeted RED_CARD / PINECONE_TOSS and the AoE attacks
//     RAINSTORM / POWER_OUTAGE / QUICKSAND.
//   * defense = self-protection / counter-play: COMPRESSION_SOCKS, MIRROR,
//     CLEANSE, STEALTH_MODE, UMBRELLA, QUICK_RINSE, DECOY, DEFENSE_SCAN.
//   * utility = everything else — self-buffs and economy (PROTEIN_SHAKE,
//     RUNNERS_HIGH, SECOND_WIND, FANNY_PACK, TRAIL_MIX, LUCKY_HORSESHOE,
//     CAMPFIRE_REST, TRAIL_MAGNET, POCKET_WATCH, TRAIL_MINE, UPRISING,
//     GHOST_PEPPER, COIN_FLIP, MYSTERY_POTION, RALLY_FLAG, PIGGY_BANK,
//     MYSTERY_BOX).
//
// The three sets are disjoint; anything unmapped (a future enum value added
// ahead of this map) defaults to "utility", so every catalog item always has
// exactly one category and the client's own missing-category → "utility"
// fallback agrees with the server.

const OFFENSE_TYPES = new Set([
  "LEG_CRAMP",
  "SHORTCUT",
  "WRONG_TURN",
  "DETOUR_SIGN",
  "SNEAKY_SWAP",
  "IMPOSTER",
  "SIGNAL_JAMMER",
  "LEECH",
  "HITCHHIKE",
  "DRILL_SERGEANT",
  "BOUNTY",
  "RED_CARD",
  "PINECONE_TOSS",
  "RAINSTORM",
  "POWER_OUTAGE",
  "QUICKSAND",
]);

const DEFENSE_TYPES = new Set([
  "COMPRESSION_SOCKS",
  "MIRROR",
  "CLEANSE",
  "STEALTH_MODE",
  "UMBRELLA",
  "QUICK_RINSE",
  "DECOY",
  "DEFENSE_SCAN",
]);

function categoryForPowerup(powerupType) {
  if (OFFENSE_TYPES.has(powerupType)) return "offense";
  if (DEFENSE_TYPES.has(powerupType)) return "defense";
  return "utility";
}

module.exports = { categoryForPowerup, OFFENSE_TYPES, DEFENSE_TYPES };
