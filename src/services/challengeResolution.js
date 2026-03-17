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
  // Extra data for specific rules
  baselineA, // weekly average for improvement_over_baseline
  baselineB,
  stepGoalA, // personal step goal for close_the_rings
  stepGoalB,
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

    case "first_to_threshold":
      winnerUserId = resolveFirstToThreshold(
        userAId, userBId, userATotalSteps, userBTotalSteps,
        thresholdCrossedAtA, thresholdCrossedAtB
      );
      break;

    case "daily_majority":
      winnerUserId = resolveDailyMajority(userAId, userBId, dailyStepsA, dailyStepsB);
      break;

    case "highest_single_day":
      winnerUserId = resolveHighestSingleDay(userAId, userBId, dailyStepsA, dailyStepsB);
      break;

    case "lowest_variance":
      winnerUserId = resolveLowestVariance(userAId, userBId, dailyStepsA, dailyStepsB);
      break;

    case "weekend_warrior":
      winnerUserId = resolveWeekendWarrior(userAId, userBId, dailyStepsA, dailyStepsB);
      break;

    case "streak_days":
      winnerUserId = resolveStreakDays(
        userAId, userBId, dailyStepsA, dailyStepsB, challenge.thresholdValue
      );
      break;

    case "comeback_king":
      winnerUserId = resolveComebackKing(
        userAId, userBId, dailyStepsA, dailyStepsB, userATotalSteps, userBTotalSteps
      );
      break;

    case "close_the_rings":
      winnerUserId = resolveCloseTheRings(
        userAId, userBId, dailyStepsA, dailyStepsB, stepGoalA, stepGoalB
      );
      break;

    case "progressive_target":
      winnerUserId = resolveProgressiveTarget(
        userAId, userBId, dailyStepsA, dailyStepsB, challenge.thresholdValue
      );
      break;

    case "rest_day_penalty":
      winnerUserId = resolveRestDayPenalty(
        userAId, userBId, dailyStepsA, dailyStepsB
      );
      break;

    case "hot_start":
      winnerUserId = resolveHotStart(userAId, userBId, dailyStepsA, dailyStepsB);
      break;

    case "strong_finish":
      winnerUserId = resolveStrongFinish(userAId, userBId, dailyStepsA, dailyStepsB);
      break;

    case "daily_minimum":
      winnerUserId = resolveDailyMinimum(
        userAId, userBId, dailyStepsA, dailyStepsB, challenge.thresholdValue
      );
      break;

    case "improvement_over_baseline":
      winnerUserId = resolveImprovementOverBaseline(
        userAId, userBId, userATotalSteps, userBTotalSteps, baselineA, baselineB
      );
      break;

    default:
      winnerUserId = null;
  }

  return { winnerUserId, userATotalSteps, userBTotalSteps };
}

// --- Existing rules ---

function resolveHigherTotal(
  userAId, userBId, totalA, totalB, reachedAtA, reachedAtB
) {
  if (totalA > totalB) return userAId;
  if (totalB > totalA) return userBId;
  if (reachedAtA && reachedAtB) {
    return new Date(reachedAtA) < new Date(reachedAtB) ? userAId : userBId;
  }
  return null;
}

function resolveFirstToThreshold(
  userAId, userBId, totalA, totalB, crossedAtA, crossedAtB
) {
  const tA = crossedAtA ? new Date(crossedAtA) : null;
  const tB = crossedAtB ? new Date(crossedAtB) : null;
  if (tA && tB) return tA < tB ? userAId : userBId;
  if (tA) return userAId;
  if (tB) return userBId;
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

// --- New rules ---

function resolveStreakDays(userAId, userBId, dailyA, dailyB, threshold) {
  const countA = dailyA.filter((d) => d.steps >= threshold).length;
  const countB = dailyB.filter((d) => d.steps >= threshold).length;
  if (countA > countB) return userAId;
  if (countB > countA) return userBId;
  return null;
}

function resolveComebackKing(userAId, userBId, dailyA, dailyB, totalA, totalB) {
  // Mon(0), Tue(1), Wed(2) = first half
  const midA = (dailyA[0]?.steps || 0) + (dailyA[1]?.steps || 0) + (dailyA[2]?.steps || 0);
  const midB = (dailyB[0]?.steps || 0) + (dailyB[1]?.steps || 0) + (dailyB[2]?.steps || 0);

  // A comeback = behind at midweek AND ahead by end
  const aCameBack = midA < midB && totalA > totalB;
  const bCameBack = midB < midA && totalB > totalA;

  if (aCameBack) return userAId;
  if (bCameBack) return userBId;

  // No comeback — fallback to higher total
  if (totalA > totalB) return userAId;
  if (totalB > totalA) return userBId;
  return null;
}

function resolveCloseTheRings(userAId, userBId, dailyA, dailyB, goalA, goalB) {
  // If a user has no goal set, default to 10000
  const targetA = goalA || 10000;
  const targetB = goalB || 10000;
  const countA = dailyA.filter((d) => d.steps >= targetA).length;
  const countB = dailyB.filter((d) => d.steps >= targetB).length;
  if (countA > countB) return userAId;
  if (countB > countA) return userBId;
  return null;
}

function resolveProgressiveTarget(userAId, userBId, dailyA, dailyB, startingTarget) {
  let countA = 0;
  let countB = 0;
  for (let i = 0; i < 7; i++) {
    const target = startingTarget + i * 1000;
    if ((dailyA[i]?.steps || 0) >= target) countA++;
    if ((dailyB[i]?.steps || 0) >= target) countB++;
  }
  if (countA > countB) return userAId;
  if (countB > countA) return userBId;
  return null;
}

function resolveRestDayPenalty(userAId, userBId, dailyA, dailyB) {
  const stepsA = dailyA.map((d) => d.steps);
  const stepsB = dailyB.map((d) => d.steps);
  const adjustedA = stepsA.reduce((s, v) => s + v, 0) - Math.min(...stepsA);
  const adjustedB = stepsB.reduce((s, v) => s + v, 0) - Math.min(...stepsB);
  if (adjustedA > adjustedB) return userAId;
  if (adjustedB > adjustedA) return userBId;
  return null;
}

function resolveHotStart(userAId, userBId, dailyA, dailyB) {
  // Mon(0) + Tue(1) + Wed(2)
  const firstA = (dailyA[0]?.steps || 0) + (dailyA[1]?.steps || 0) + (dailyA[2]?.steps || 0);
  const firstB = (dailyB[0]?.steps || 0) + (dailyB[1]?.steps || 0) + (dailyB[2]?.steps || 0);
  if (firstA > firstB) return userAId;
  if (firstB > firstA) return userBId;
  return null;
}

function resolveStrongFinish(userAId, userBId, dailyA, dailyB) {
  // Thu(3) + Fri(4) + Sat(5) + Sun(6)
  const backA = (dailyA[3]?.steps || 0) + (dailyA[4]?.steps || 0) +
    (dailyA[5]?.steps || 0) + (dailyA[6]?.steps || 0);
  const backB = (dailyB[3]?.steps || 0) + (dailyB[4]?.steps || 0) +
    (dailyB[5]?.steps || 0) + (dailyB[6]?.steps || 0);
  if (backA > backB) return userAId;
  if (backB > backA) return userBId;
  return null;
}

function resolveDailyMinimum(userAId, userBId, dailyA, dailyB, threshold) {
  const adjustedA = dailyA.reduce((s, d) => s + (d.steps >= threshold ? d.steps : 0), 0);
  const adjustedB = dailyB.reduce((s, d) => s + (d.steps >= threshold ? d.steps : 0), 0);
  if (adjustedA > adjustedB) return userAId;
  if (adjustedB > adjustedA) return userBId;
  return null;
}

function resolveImprovementOverBaseline(userAId, userBId, totalA, totalB, baselineA, baselineB) {
  // % improvement = (current - baseline) / baseline
  // If no baseline (new user), treat as 0% improvement
  const improvA = baselineA > 0 ? (totalA - baselineA) / baselineA : 0;
  const improvB = baselineB > 0 ? (totalB - baselineB) / baselineB : 0;
  if (improvA > improvB) return userAId;
  if (improvB > improvA) return userBId;
  return null;
}

// --- Helpers ---

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
