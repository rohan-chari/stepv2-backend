// Central CLIENT-FEATURE gating helpers for powerups that must not reach every
// client/version.
//
// SCOPE NOTE (balance-config D13): these lists are about which BINARIES may SEE
// a powerup type, and nothing else. They are no longer consulted for drop
// eligibility — `storeOnlyTypes` in the balance config is the single authority
// on what a mystery box or daily box may award (see getEligiblePowerupPool).
// Keep it that way: this is a frozen-client compatibility concern, and it must
// NOT become admin-editable. An admin toggling visibility here would expose a
// type to a build that cannot render, target, or use it.
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
  imposterEnabled,
  isImposterDisabledForCatalog,
};
