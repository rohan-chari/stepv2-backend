const { buildPayoutPlan } = require("./payoutRounding");

function byTopStepper(a, b) {
  const stepDiff = (b?.totalSteps || 0) - (a?.totalSteps || 0);
  if (stepDiff !== 0) return stepDiff;
  const joinDiff =
    new Date(a?.joinedAt || 0).getTime() -
    new Date(b?.joinedAt || 0).getTime();
  if (joinDiff !== 0) return joinDiff;
  return String(a?.userId || "").localeCompare(String(b?.userId || ""));
}

function teamPayoutRecipients({ participants = [], winnerTeam = null, tie = false }) {
  return participants
    .filter(
      (participant) =>
        participant?.status === "ACCEPTED" &&
        participant.forfeitedAt == null &&
        (tie === true || participant.team === winnerTeam),
    )
    .sort(byTopStepper);
}

// Before a result exists, a team-race payout table represents the winning
// side's per-member split. Started team races are balanced at activation; if a
// later partial forfeit makes the surviving side counts differ, use the larger
// possible recipient cohort so payout-v1 never understates rounding liability.
function projectedTeamRecipientCount(participants = []) {
  const counts = new Map();
  for (const participant of participants) {
    if (
      participant?.status !== "ACCEPTED" ||
      participant.forfeitedAt != null ||
      typeof participant.team !== "string"
    ) {
      continue;
    }
    counts.set(participant.team, (counts.get(participant.team) || 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

function buildTeamPayoutPlan({
  recipients = null,
  recipientCount = null,
  prizeCoins = 0,
  payoutRoundingVersion = 0,
} = {}) {
  const concreteRecipients = Array.isArray(recipients) ? recipients : null;
  const count = concreteRecipients
    ? concreteRecipients.length
    : Math.max(0, Math.floor(Number(recipientCount) || 0));
  const prize = Math.max(0, Math.floor(Number(prizeCoins) || 0));
  if (count === 0 || prize === 0) {
    return buildPayoutPlan({ payoutRoundingVersion, awards: [] });
  }
  const share = Math.floor(prize / count);
  const remainder = prize - share * count;
  return buildPayoutPlan({
    payoutRoundingVersion,
    awards: Array.from({ length: count }, (_, index) => ({
      recipientId: concreteRecipients?.[index]?.id || `team-award:${index + 1}`,
      placement: 1,
      rawAwardCoins: share + (index === 0 ? remainder : 0),
    })),
  });
}

module.exports = {
  buildTeamPayoutPlan,
  byTopStepper,
  projectedTeamRecipientCount,
  teamPayoutRecipients,
};
