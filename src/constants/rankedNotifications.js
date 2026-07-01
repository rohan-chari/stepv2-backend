// Ranked push notifications are PAUSED. Ranked has no wired push handlers yet
// (the only ranked emits — RANKED_WEEK_SETTLED_FOR_USER and
// SEASON_REWARD_GRANTED — are unconsumed), and the product decision is to keep
// ranked settlement running silently until handlers + copy exist.
//
// This single flag gates BOTH ranked emits so the pause is explicit and
// revertible: flip it to true to re-enable ranked notifications everywhere.
// Settlement, coin awards, and tier/badge updates are NOT gated by this flag —
// they always run.
//
// TODO(ranked): DO NOT set this to true yet. Ranked is intentionally paused
// (product decision 2026-06-30). Turning it on before ranked push handlers AND
// user-facing copy exist would emit RANKED_WEEK_SETTLED_FOR_USER /
// SEASON_REWARD_GRANTED with no consumer, and the app currently suppresses the
// in-app ranked results popup too. Re-enable only as a deliberate ranked relaunch.
const RANKED_NOTIFICATIONS_ENABLED = false;

module.exports = { RANKED_NOTIFICATIONS_ENABLED };
