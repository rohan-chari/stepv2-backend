const TEAM_PAYOUT_VERSION_V1 = 1;

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveTeamWinnerRewardCoins(durationDays) {
  const days = positiveInteger(durationDays) || 1;
  if (days <= 1) return 100;
  if (days <= 3) return 200;
  if (days <= 7) return 500;
  return 1000;
}

function newTeamPayoutStamp({
  fundedPrize = false,
  isTeamRace = false,
  durationDays,
} = {}) {
  if (fundedPrize !== true || isTeamRace !== true) {
    return { teamPayoutVersion: null, teamWinnerRewardCoins: null };
  }
  return {
    teamPayoutVersion: TEAM_PAYOUT_VERSION_V1,
    teamWinnerRewardCoins: resolveTeamWinnerRewardCoins(durationDays),
  };
}

function resolveFixedTeamPayoutStamp(race = {}) {
  const reward = positiveInteger(race.teamWinnerRewardCoins);
  if (
    race.fundedPrize !== true ||
    race.isTeamRace !== true ||
    race.teamPayoutVersion !== TEAM_PAYOUT_VERSION_V1 ||
    reward == null
  ) {
    return null;
  }
  return {
    teamPayoutVersion: TEAM_PAYOUT_VERSION_V1,
    teamWinnerRewardCoins: reward,
  };
}

// Public wire contract: the two fields are an inseparable pair. A partial,
// unknown, or otherwise invalid database stamp is deliberately collapsed to
// two nulls so clients cannot mistake a legacy race for fixed-reward mode.
function serializeTeamPayoutStamp(race = {}) {
  const stamp = resolveFixedTeamPayoutStamp(race);
  return {
    teamPayoutVersion: stamp?.teamPayoutVersion ?? null,
    teamWinnerRewardCoins: stamp?.teamWinnerRewardCoins ?? null,
  };
}

// Deployment A compatibility writer: an A worker must not activate fixed
// payouts for a legacy NULL row, but it must keep a V1 row internally
// consistent if a B worker created it and a custom duration is later edited or
// re-priced at start during the mixed-worker window.
function repriceExistingTeamPayoutStamp(race = {}, durationDays) {
  if (resolveFixedTeamPayoutStamp(race) == null) return null;
  return {
    teamPayoutVersion: TEAM_PAYOUT_VERSION_V1,
    teamWinnerRewardCoins: resolveTeamWinnerRewardCoins(durationDays),
  };
}

module.exports = {
  TEAM_PAYOUT_VERSION_V1,
  newTeamPayoutStamp,
  repriceExistingTeamPayoutStamp,
  resolveFixedTeamPayoutStamp,
  resolveTeamWinnerRewardCoins,
  serializeTeamPayoutStamp,
};
