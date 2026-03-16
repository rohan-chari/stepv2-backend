const { ChallengeInstance } = require("../models/challengeInstance");
const { Steps } = require("../models/steps");

function getMondayOfWeek(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day + 6) % 7;
  d.setDate(d.getDate() - diff);
  return d.toISOString().slice(0, 10);
}

async function getChallengeProgress(userId, instanceId) {
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

  // Compute live step totals for the current week
  const weekOf = getMondayOfWeek();
  let userATotalSteps = 0;
  let userBTotalSteps = 0;

  for (let i = 0; i < 7; i++) {
    const date = new Date(weekOf);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().slice(0, 10);

    const [stepsA, stepsB] = await Promise.all([
      Steps.findByUserIdAndDate(instance.userAId, dateStr),
      Steps.findByUserIdAndDate(instance.userBId, dateStr),
    ]);

    userATotalSteps += stepsA?.steps || 0;
    userBTotalSteps += stepsB?.steps || 0;
  }

  return {
    instanceId: instance.id,
    status: instance.status,
    challenge: {
      id: instance.challenge.id,
      title: instance.challenge.title,
      type: instance.challenge.type,
      resolutionRule: instance.challenge.resolutionRule,
    },
    stake: instance.stake
      ? { id: instance.stake.id, name: instance.stake.name }
      : null,
    userA: {
      userId: instance.userA.id,
      displayName: instance.userA.displayName,
      totalSteps: userATotalSteps,
    },
    userB: {
      userId: instance.userB.id,
      displayName: instance.userB.displayName,
      totalSteps: userBTotalSteps,
    },
    weekOf,
  };
}

module.exports = { getChallengeProgress };
