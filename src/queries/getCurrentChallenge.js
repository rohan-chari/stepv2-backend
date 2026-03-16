const { ChallengeInstance } = require("../models/challengeInstance");
const {
  ensureWeeklyChallengeForDate,
} = require("../services/weeklyChallengeState");
const { getNextMonday9amNewYork } = require("../utils/week");

function buildGetCurrentChallenge(dependencies = {}) {
  const ensureWeeklyChallenge =
    dependencies.ensureWeeklyChallengeForDate || ensureWeeklyChallengeForDate;
  const instanceModel = dependencies.ChallengeInstance || ChallengeInstance;

  return async function getCurrentChallenge(userId) {
    const { weeklyChallenge } = await ensureWeeklyChallenge();

    if (!weeklyChallenge || weeklyChallenge.resolvedAt) {
      return {
        challenge: null,
        weekOf: null,
        instances: [],
        nextDropAt: getNextMonday9amNewYork(),
      };
    }

    const instances = await instanceModel.findForUser(
      userId,
      weeklyChallenge.weekOf
    );

    return {
      challenge: {
        id: weeklyChallenge.challenge.id,
        title: weeklyChallenge.challenge.title,
        description: weeklyChallenge.challenge.description,
        type: weeklyChallenge.challenge.type,
        resolutionRule: weeklyChallenge.challenge.resolutionRule,
        thresholdValue: weeklyChallenge.challenge.thresholdValue,
      },
      weekOf: weeklyChallenge.weekOf,
      instances,
    };
  };
}

const getCurrentChallenge = buildGetCurrentChallenge();

module.exports = { buildGetCurrentChallenge, getCurrentChallenge };
