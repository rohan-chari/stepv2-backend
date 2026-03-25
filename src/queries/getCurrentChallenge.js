const { ChallengeInstance } = require("../models/challengeInstance");
const { Steps } = require("../models/steps");
const {
  ensureWeeklyChallengeForDate,
} = require("../services/weeklyChallengeState");
const {
  computeRankings: defaultComputeRankings,
} = require("../utils/rankings");
const {
  getChallengeEndsAtForWeek,
  getChallengeSyncDaysForWeek,
  getNextMonday9amNewYork,
} = require("../utils/week");

function buildGetCurrentChallenge(dependencies = {}) {
  const ensureWeeklyChallenge =
    dependencies.ensureWeeklyChallengeForDate || ensureWeeklyChallengeForDate;
  const instanceModel = dependencies.ChallengeInstance || ChallengeInstance;
  const stepsModel = dependencies.Steps || Steps;
  const computeRankings =
    dependencies.computeRankings || defaultComputeRankings;
  const now = dependencies.now || (() => new Date());

  return async function getCurrentChallenge(userId) {
    const { weeklyChallenge } = await ensureWeeklyChallenge();

    if (!weeklyChallenge || weeklyChallenge.resolvedAt) {
      return {
        challenge: null,
        weekOf: null,
        instances: [],
        syncDays: [],
        nextDropAt: getNextMonday9amNewYork(),
      };
    }

    const instances = await instanceModel.findForUser(
      userId,
      weeklyChallenge.weekOf
    );

    const syncDays = getChallengeSyncDaysForWeek(
      weeklyChallenge.weekOf,
      now()
    );

    // Compute rankings for active instances
    const activeInstances = instances.filter((i) => i.status === "ACTIVE");

    if (activeInstances.length > 0) {
      const userIdSet = new Set();
      for (const inst of activeInstances) {
        userIdSet.add(inst.userAId);
        userIdSet.add(inst.userBId);
      }

      const endDate =
        syncDays.length > 0
          ? syncDays[syncDays.length - 1].date
          : weeklyChallenge.weekOf;

      const stepTotals = await stepsModel.sumStepsForUsers(
        [...userIdSet],
        weeklyChallenge.weekOf,
        endDate
      );

      for (const inst of activeInstances) {
        const participants = [
          { id: inst.userAId, totalSteps: stepTotals.get(inst.userAId) || 0 },
          { id: inst.userBId, totalSteps: stepTotals.get(inst.userBId) || 0 },
        ];
        const rankings = computeRankings(participants);
        const myRanking = rankings.find((r) => r.id === userId);

        inst.ranking = {
          rank: myRanking ? myRanking.rank : 1,
          totalParticipants: participants.length,
        };
      }
    }

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
      endsAt: getChallengeEndsAtForWeek(weeklyChallenge.weekOf),
      syncDays,
      instances,
    };
  };
}

const getCurrentChallenge = buildGetCurrentChallenge();

module.exports = { buildGetCurrentChallenge, getCurrentChallenge };
