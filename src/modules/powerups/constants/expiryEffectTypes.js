// Pure expiry-classification constants. NO imports: this module is required by
// the race-scoring dependency-closure table, which must not transitively load
// the model/eventBus/awardCoins layer at module load. expireEffects.js imports
// and re-exports these; it remains the only place that ACTS on them.

// Types whose EXPIRY needs the target's step total snapshotted (so a later
// EXPIRED-row read scores the closed window with the right end). The four wave-5
// windowed step-modifiers (§6.5) join the existing debuff/buff set.
const SNAPSHOT_AT_EXPIRY_TYPES = Object.freeze([
  "LEG_CRAMP", "QUICKSAND", "RUNNERS_HIGH", "CAMPFIRE_REST", "RAINSTORM",
  "UPRISING", "GHOST_PEPPER", "COIN_FLIP", "RALLY_FLAG",
]);

// Types whose EXPIRY runs a side-effecting consequence (slot revert, dare
// judgement, coin mint) rather than only stamping metadata. Kept in lockstep
// with the branches in expireEffects.js; consumers must not re-list these.
const EXPIRY_CONSEQUENCE_TYPES = Object.freeze([
  "FANNY_PACK", "DRILL_SERGEANT", "PIGGY_BANK",
]);

// Score-changing windows whose resolution may produce an active-race impact
// notice. This is shared by the expiry writer and the C0 scanner so a source
// resolved while the rollout flag is disabled can be durably marked ineligible
// and never be backfilled after a later enable.
const ACTIVE_IMPACT_EXPIRY_TYPES = Object.freeze([
  "LEG_CRAMP", "QUICKSAND", "RUNNERS_HIGH", "WRONG_TURN",
  "CAMPFIRE_REST", "RAINSTORM", "UPRISING", "RALLY_FLAG", "COIN_FLIP",
  "GHOST_PEPPER", "DRILL_SERGEANT", "LEECH", "HITCHHIKE",
]);

module.exports = {
  SNAPSHOT_AT_EXPIRY_TYPES,
  EXPIRY_CONSEQUENCE_TYPES,
  ACTIVE_IMPACT_EXPIRY_TYPES,
};
