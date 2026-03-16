const { Challenge } = require("../models/challenge");
const { ChallengeInstance } = require("../models/challengeInstance");

function getMondayOfWeek(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day + 6) % 7;
  d.setDate(d.getDate() - diff);
  return d.toISOString().slice(0, 10);
}

function getNextMonday9amEST() {
  const now = new Date();
  const day = now.getDay();
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  const next = new Date(now);
  next.setDate(next.getDate() + daysUntilMonday);
  next.setHours(14, 0, 0, 0); // 9 AM EST = 14:00 UTC
  return next.toISOString();
}

async function getCurrentChallenge(userId) {
  const challenge = await Challenge.findCurrentWeek();

  if (!challenge) {
    return {
      challenge: null,
      weekOf: null,
      instances: [],
      nextDropAt: getNextMonday9amEST(),
    };
  }

  const weekOf = getMondayOfWeek();
  const instances = await ChallengeInstance.findForUser(userId, weekOf);

  return {
    challenge: {
      id: challenge.id,
      title: challenge.title,
      description: challenge.description,
      type: challenge.type,
      resolutionRule: challenge.resolutionRule,
      thresholdValue: challenge.thresholdValue,
    },
    weekOf,
    instances,
  };
}

module.exports = { getCurrentChallenge };
