// Ranked is DEAD for now (product decision 2026-07-01) — not just quiet.
// The earlier pause (see rankedNotifications.js) only silenced the two ranked
// push emits while settlement kept minting ranked_week_reward /
// ranked_promotion_bonus / ranked_season_reward coins every cycle. This flag
// stops the whole pipeline: computeRankedWeeks and computeRanks no-op, so no
// week is opened, nobody is enrolled into cohorts, no standings are written,
// and no ranked coins are ever awarded. Read endpoints (getRanked/getRankedV2)
// are untouched and keep serving the last settled state to old app versions.
//
// TODO(ranked): before flipping this back to true, deal with the backlog —
// computeRankedWeeks settles every past-boundary unsettled week on its first
// enabled tick, which would retroactively pay coins for every week that
// elapsed while ranked was dead. Close/void those weeks first.
const RANKED_SETTLEMENT_ENABLED = false;

module.exports = { RANKED_SETTLEMENT_ENABLED };
