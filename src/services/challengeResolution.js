function resolveChallenge({
  challenge,
  userAId,
  userBId,
  dailyStepsA,
  dailyStepsB,
  totalReachedAtA,
  totalReachedAtB,
}) {
  const userATotalSteps = dailyStepsA.reduce((sum, d) => sum + d.steps, 0);
  const userBTotalSteps = dailyStepsB.reduce((sum, d) => sum + d.steps, 0);

  let winnerUserId;

  switch (challenge.resolutionRule) {
    case "higher_total":
      winnerUserId = resolveHigherTotal(
        userAId, userBId, userATotalSteps, userBTotalSteps,
        totalReachedAtA, totalReachedAtB
      );
      break;

    default:
      // Fallback: treat any unknown rule as higher_total
      winnerUserId = resolveHigherTotal(
        userAId, userBId, userATotalSteps, userBTotalSteps,
        totalReachedAtA, totalReachedAtB
      );
  }

  return { winnerUserId, userATotalSteps, userBTotalSteps };
}

function resolveHigherTotal(
  userAId, userBId, totalA, totalB, reachedAtA, reachedAtB
) {
  if (totalA > totalB) return userAId;
  if (totalB > totalA) return userBId;

  // Tiebreaker: who reached the tied total first
  if (reachedAtA && reachedAtB) {
    return new Date(reachedAtA) < new Date(reachedAtB) ? userAId : userBId;
  }
  return null;
}

async function resolveWeeklyChallenges({
  findActiveAndPendingInstances,
  getChallenge,
  getDailySteps,
  updateInstance,
  onChallengeWon,
}) {
  const instances = await findActiveAndPendingInstances();

  for (const instance of instances) {
    if (instance.status === "pending_stake") {
      await updateInstance(instance.id, {
        status: "completed",
        stakeStatus: "skipped",
        winnerUserId: null,
        resolvedAt: new Date().toISOString(),
      });
      continue;
    }

    const challenge = await getChallenge(instance.challengeId);
    const dailyStepsA = await getDailySteps(instance.userAId);
    const dailyStepsB = await getDailySteps(instance.userBId);

    const result = resolveChallenge({
      challenge,
      userAId: instance.userAId,
      userBId: instance.userBId,
      dailyStepsA,
      dailyStepsB,
    });

    await updateInstance(instance.id, {
      status: "completed",
      winnerUserId: result.winnerUserId,
      userATotalSteps: result.userATotalSteps,
      userBTotalSteps: result.userBTotalSteps,
      resolvedAt: new Date().toISOString(),
    });

    // Award coins to the winner
    if (result.winnerUserId && onChallengeWon) {
      await onChallengeWon(result.winnerUserId, instance.id);
    }
  }
}

module.exports = { resolveChallenge, resolveWeeklyChallenges };
