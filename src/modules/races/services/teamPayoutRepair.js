const { buildRaceMoneyView } = require("../racePrizePool");
const { buildTeamPayoutPlan } = require("./teamPayoutPlan");
const { resolveTeamWinnerRewardCoins } = require("./teamWinnerReward");

function acceptedNonForfeitedCounts(participants = []) {
  const counts = { TEAM_A: 0, TEAM_B: 0 };
  for (const participant of participants) {
    if (
      participant?.status !== "ACCEPTED" ||
      participant.forfeitedAt != null ||
      !Object.prototype.hasOwnProperty.call(counts, participant.team)
    ) continue;
    counts[participant.team] += 1;
  }
  return counts;
}

function fixedLiability({ count, rewardCoins, payoutRoundingVersion }) {
  return buildTeamPayoutPlan({
    recipientCount: count,
    fixedWinnerRewardCoins: rewardCoins,
    payoutRoundingVersion,
  }).totals.awardCoins;
}

function evaluateOpenTeamPayoutRepair(race) {
  const participants = race?.participants || [];
  const acceptedCount = participants.filter(
    (participant) => participant.status === "ACCEPTED",
  ).length;
  const counts = acceptedNonForfeitedCounts(participants);
  const rewardCoins = resolveTeamWinnerRewardCoins(race?.maxDurationDays);
  const sideALiabilityCoins = fixedLiability({
    count: counts.TEAM_A,
    rewardCoins,
    payoutRoundingVersion: race?.payoutRoundingVersion,
  });
  const sideBLiabilityCoins = fixedLiability({
    count: counts.TEAM_B,
    rewardCoins,
    payoutRoundingVersion: race?.payoutRoundingVersion,
  });
  const repairedProjectionCoins = Math.max(
    sideALiabilityCoins,
    sideBLiabilityCoins,
  );
  const currentProjectionCoins = buildRaceMoneyView({
    race,
    participants,
    acceptedCount,
  }).prizePool?.coins || 0;
  return {
    rewardCoins,
    acceptedCount,
    eligibleTeamACount: counts.TEAM_A,
    eligibleTeamBCount: counts.TEAM_B,
    sideALiabilityCoins,
    sideBLiabilityCoins,
    currentProjectionCoins,
    repairedProjectionCoins,
    deltaCoins: repairedProjectionCoins - currentProjectionCoins,
    increasesProjection: repairedProjectionCoins > currentProjectionCoins,
  };
}

module.exports = {
  acceptedNonForfeitedCounts,
  evaluateOpenTeamPayoutRepair,
  fixedLiability,
};
