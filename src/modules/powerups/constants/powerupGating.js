// Central CLIENT-FEATURE gating helpers for powerups that must not reach every
// client/version.
//
// SCOPE NOTE: these lists describe which BINARIES may SEE a powerup type. They
// are shared by the shop catalog and daily-box pool so neither surface can hand
// an unknown enum to a frozen client. Product eligibility still comes from the
// balance config and active/testOnly/channel state; these request-scoped gates
// are the final compatibility filter and must not become admin-editable.
//
//   * POWERUPS2_GATED_TYPES — X-Ray (DEFENSE_SCAN). Hidden from the shop catalog
//     unless the client advertises the `powerups2` X-Client-Features token, so
//     old binaries never see a powerup type they can't render/target/use.
//     (Box-prize exclusion now comes from config.storeOnlyTypes — see above.)
//   * IMPOSTER kill switch — Imposter is being DISABLED for now (Item 3). It is
//     env-gated by IMPOSTER_ENABLED so we can flip it back on instantly:
//       - default (env unset / anything but "false") => ENABLED (legacy behavior;
//         keeps every existing test green and lets us stage the change safely).
//       - IMPOSTER_ENABLED="false" => DISABLED: the catalog hides it, the
//         leaderboard slot-swap stops, and new uses are rejected (item kept, not
//         consumed). Held/owned Imposter inventory is left untouched.
//     Set IMPOSTER_ENABLED=false in the prod/staging env to actually kill it.

//   * POWERUPS3_GATED_TYPES — Leech + Hitchhike + Quick Rinse. Same shape and
//     same purpose one generation on: hidden from the shop catalog unless the
//     client advertises the `powerups3` token.
//     LEECH MOVES here from `powerups2` (§7.5): its duration is now
//     capability-versioned, so only a powerups3 build should be able to buy one.
//     NOTE this is catalog VISIBILITY only — an existing owner of a banked Leech
//     can still use it, and an old build's use still creates the 30-minute effect
//     its own copy describes.
const POWERUPS2_GATED_TYPES = ["DEFENSE_SCAN"];
const POWERUPS3_GATED_TYPES = ["LEECH", "HITCHHIKE", "QUICK_RINSE"];
const POWERUPS4_GATED_TYPES = ["QUICKSAND"];
//   * POWERUPS5_GATED_TYPES — the 11 Wave 5 store-only powerups. Same shape and
//     same purpose one generation on: hidden from the shop catalog (and rejected
//     at purchase/use) unless the client advertises the `powerups5` token, so a
//     frozen binary is never offered — nor can it use — a type it cannot
//     render/target. Catalog VISIBILITY only; an existing owner's banked wave-5
//     item is still rejected on use from a non-powerups5 client (UPDATE_REQUIRED).
const POWERUPS5_GATED_TYPES = [
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

function imposterEnabled() {
  return process.env.IMPOSTER_ENABLED !== "false";
}

// Whether IMPOSTER should be filtered OUT of the shop catalog (the read-path
// swap + use rejection are gated by imposterEnabled() at their call sites).
function isImposterDisabledForCatalog(powerupType) {
  return powerupType === "IMPOSTER" && !imposterEnabled();
}

module.exports = {
  POWERUPS2_GATED_TYPES,
  POWERUPS3_GATED_TYPES,
  POWERUPS4_GATED_TYPES,
  POWERUPS5_GATED_TYPES,
  imposterEnabled,
  isImposterDisabledForCatalog,
};
