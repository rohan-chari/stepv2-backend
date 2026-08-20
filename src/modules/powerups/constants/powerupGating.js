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
//   * IMPOSTER is permanently retired. Historical enum/activity parsing stays,
//     but no environment value can restore catalog, reward, or use behavior.

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
  return false;
}

// Whether IMPOSTER should be filtered OUT of the shop catalog (the read-path
// swap + use rejection are gated by imposterEnabled() at their call sites).
function isImposterDisabledForCatalog(powerupType) {
  return powerupType === "IMPOSTER";
}

// THE single client-visibility rule for a shop powerup (2026-07-28). Both the
// shop catalog (getPowerupShopCatalog) and the daily-spin prize pool
// (getEligiblePowerupPool) apply exactly this predicate over findActive rows,
// which is what makes "visible in the shop ⟺ winnable from the daily spin"
// hold by construction. There is no separate spin-exclusion list anymore —
// hiding an item (`active=false`, or `testOnly` per channel) removes it from
// both surfaces at once. Do not fork this logic back into the call sites.
function isPowerupVisibleToClient(
  powerupType,
  {
    supportsJammer = false,
    supportsPowerups2 = false,
    supportsPowerups3 = false,
    supportsPowerups4 = false,
    supportsPowerups5 = false,
  } = {}
) {
  if (isImposterDisabledForCatalog(powerupType)) return false;
  if (!supportsJammer && powerupType === "SIGNAL_JAMMER") return false;
  if (!supportsPowerups2 && POWERUPS2_GATED_TYPES.includes(powerupType)) return false;
  if (!supportsPowerups3 && POWERUPS3_GATED_TYPES.includes(powerupType)) return false;
  if (!supportsPowerups4 && POWERUPS4_GATED_TYPES.includes(powerupType)) return false;
  if (!supportsPowerups5 && POWERUPS5_GATED_TYPES.includes(powerupType)) return false;
  return true;
}

module.exports = {
  POWERUPS2_GATED_TYPES,
  POWERUPS3_GATED_TYPES,
  POWERUPS4_GATED_TYPES,
  POWERUPS5_GATED_TYPES,
  imposterEnabled,
  isImposterDisabledForCatalog,
  isPowerupVisibleToClient,
};
