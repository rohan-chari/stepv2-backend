const { ChallengeInstance } = require("../models/challengeInstance");
const { Steps } = require("../models/steps");
const { getMondayOfWeek } = require("../utils/week");

async function getChallengeProgress(userId, instanceId, timeZone) {
  const instance = await ChallengeInstance.findById(instanceId);

  if (!instance) {
    const error = new Error("Challenge instance not found");
    error.statusCode = 404;
    throw error;
  }

  if (instance.userAId !== userId && instance.userBId !== userId) {
    const error = new Error("You are not a participant in this challenge");
    error.statusCode = 403;
    throw error;
  }

  const weekOf = getMondayOfWeek(new Date(), timeZone);
  const sunday = new Date(weekOf);
  sunday.setDate(sunday.getDate() + 6);
  const endDate = sunday.toISOString().slice(0, 10);

  // 2 queries instead of 14
  const [stepsA, stepsB] = await Promise.all([
    Steps.findByUserIdAndDateRange(instance.userAId, weekOf, endDate),
    Steps.findByUserIdAndDateRange(instance.userBId, weekOf, endDate),
  ]);

  // Index by date string for O(1) lookup
  const stepsAByDate = new Map(
    stepsA.map((s) => [s.date.toISOString().slice(0, 10), s.steps])
  );
  const stepsBByDate = new Map(
    stepsB.map((s) => [s.date.toISOString().slice(0, 10), s.steps])
  );

  let userATotalSteps = 0;
  let userBTotalSteps = 0;
  const dailyStepsA = [];
  const dailyStepsB = [];

  for (let i = 0; i < 7; i++) {
    const date = new Date(weekOf);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().slice(0, 10);

    const a = stepsAByDate.get(dateStr) || 0;
    const b = stepsBByDate.get(dateStr) || 0;
    userATotalSteps += a;
    userBTotalSteps += b;
    dailyStepsA.push({ date: dateStr, steps: a });
    dailyStepsB.push({ date: dateStr, steps: b });
  }

  return {
    instanceId: instance.id,
    status: instance.status,
    challenge: {
      id: instance.challenge.id,
      title: instance.challenge.title,
      type: instance.challenge.type,
      resolutionRule: instance.challenge.resolutionRule,
      thresholdValue: instance.challenge.thresholdValue,
    },
    stake: instance.stake
      ? { id: instance.stake.id, name: instance.stake.name }
      : null,
    userA: {
      userId: instance.userA.id,
      displayName: instance.userA.displayName,
      totalSteps: userATotalSteps,
      dailySteps: dailyStepsA,
    },
    userB: {
      userId: instance.userB.id,
      displayName: instance.userB.displayName,
      totalSteps: userBTotalSteps,
      dailySteps: dailyStepsB,
    },
    weekOf,
  };
}

module.exports = { getChallengeProgress };
