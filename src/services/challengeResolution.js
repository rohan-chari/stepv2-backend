function resolveChallenge({
  challenge,
  userAId,
  userBId,
  dailyStepsA,
  dailyStepsB,
  thresholdCrossedAtA,
  thresholdCrossedAtB,
  totalReachedAtA,
  totalReachedAtB,
}) {
  const userATotalSteps = dailyStepsA.reduce((sum, d) => sum + d.steps, 0);
  const userBTotalSteps = dailyStepsB.reduce((sum, d) => sum + d.steps, 0);

  let winnerUserId;

  switch (challenge.resolutionRule) {
    case "higher_total":
      winnerUserId = resolveHigherTotal(
        userAId,
        userBId,
        userATotalSteps,
        userBTotalSteps,
        totalReachedAtA,
        totalReachedAtB
      );
      break;

    case "first_to_threshold":
      winnerUserId = resolveFirstToThreshold(
        userAId,
        userBId,
        userATotalSteps,
        userBTotalSteps,
        thresholdCrossedAtA,
        thresholdCrossedAtB
      );
      break;

    case "daily_majority":
      winnerUserId = resolveDailyMajority(
        userAId,
        userBId,
        dailyStepsA,
        dailyStepsB
      );
      break;

    case "highest_single_day":
      winnerUserId = resolveHighestSingleDay(
        userAId,
        userBId,
        dailyStepsA,
        dailyStepsB
      );
      break;

    case "lowest_variance":
      winnerUserId = resolveLowestVariance(
        userAId,
        userBId,
        dailyStepsA,
        dailyStepsB
      );
      break;

    case "weekend_warrior":
      winnerUserId = resolveWeekendWarrior(
        userAId,
        userBId,
        dailyStepsA,
        dailyStepsB
      );
      break;

    default:
      winnerUserId = null;
  }

  return { winnerUserId, userATotalSteps, userBTotalSteps };
}

function resolveHigherTotal(
  userAId,
  userBId,
  totalA,
  totalB,
  reachedAtA,
  reachedAtB
) {
  if (totalA > totalB) return userAId;
  if (totalB > totalA) return userBId;

  // Tiebreaker: who reached the tied total first
  if (reachedAtA && reachedAtB) {
    return new Date(reachedAtA) < new Date(reachedAtB) ? userAId : userBId;
  }
  return null;
}

function resolveFirstToThreshold(
  userAId,
  userBId,
  totalA,
  totalB,
  crossedAtA,
  crossedAtB
) {
  const tA = crossedAtA ? new Date(crossedAtA) : null;
  const tB = crossedAtB ? new Date(crossedAtB) : null;

  if (tA && tB) return tA < tB ? userAId : userBId;
  if (tA) return userAId;
  if (tB) return userBId;

  // Neither crossed — fall back to higher total
  if (totalA > totalB) return userAId;
  if (totalB > totalA) return userBId;
  return null;
}

function resolveDailyMajority(userAId, userBId, dailyA, dailyB) {
  let winsA = 0;
  let winsB = 0;

  for (let i = 0; i < 7; i++) {
    const stepsA = dailyA[i]?.steps || 0;
    const stepsB = dailyB[i]?.steps || 0;
    if (stepsA > stepsB) winsA++;
    else if (stepsB > stepsA) winsB++;
  }

  if (winsA > winsB) return userAId;
  if (winsB > winsA) return userBId;
  return null;
}

function resolveHighestSingleDay(userAId, userBId, dailyA, dailyB) {
  const bestA = Math.max(...dailyA.map((d) => d.steps));
  const bestB = Math.max(...dailyB.map((d) => d.steps));

  if (bestA > bestB) return userAId;
  if (bestB > bestA) return userBId;
  return null;
}

function resolveLowestVariance(userAId, userBId, dailyA, dailyB) {
  const sdA = stdDev(dailyA.map((d) => d.steps));
  const sdB = stdDev(dailyB.map((d) => d.steps));

  if (sdA < sdB) return userAId;
  if (sdB < sdA) return userBId;
  return null;
}

function resolveWeekendWarrior(userAId, userBId, dailyA, dailyB) {
  // Week array is Mon(0)..Sun(6), so Sat=5, Sun=6
  const weekendA = (dailyA[5]?.steps || 0) + (dailyA[6]?.steps || 0);
  const weekendB = (dailyB[5]?.steps || 0) + (dailyB[6]?.steps || 0);

  if (weekendA > weekendB) return userAId;
  if (weekendB > weekendA) return userBId;
  return null;
}

function stdDev(values) {
  const n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((sum, val) => sum + (val - mean) ** 2, 0) / n;
  return Math.sqrt(variance);
}

async function resolveWeeklyChallenges({
  findActiveAndPendingInstances,
  getChallenge,
  getDailySteps,
  updateInstance,
  updateStreak,
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

    await updateStreak(instance.userAId, instance.userBId, result.winnerUserId);
  }
}

module.exports = { resolveChallenge, resolveWeeklyChallenges };
