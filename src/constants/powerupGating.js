// Central gating helpers for powerups that must not reach every client/version.
//
//   * POWERUPS2_GATED_TYPES — Leech + X-Ray (DEFENSE_SCAN). Hidden from the shop
//     catalog and never awarded as a mystery-box / daily-box prize unless the
//     client advertises the `powerups2` X-Client-Features token, so old binaries
//     never see a powerup type they can't render/target/use.
//   * IMPOSTER kill switch — Imposter is being DISABLED for now (Item 3). It is
//     env-gated by IMPOSTER_ENABLED so we can flip it back on instantly:
//       - default (env unset / anything but "false") => ENABLED (legacy behavior;
//         keeps every existing test green and lets us stage the change safely).
//       - IMPOSTER_ENABLED="false" => DISABLED: the catalog hides it, the
//         leaderboard slot-swap stops, and new uses are rejected (item kept, not
//         consumed). Held/owned Imposter inventory is left untouched.
//     Set IMPOSTER_ENABLED=false in the prod/staging env to actually kill it.

const POWERUPS2_GATED_TYPES = ["LEECH", "DEFENSE_SCAN"];

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
  imposterEnabled,
  isImposterDisabledForCatalog,
};
