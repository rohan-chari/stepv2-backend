const { eventBus } = require("../events/eventBus");
const { Challenge } = require("../models/challenge");
const { ChallengeInstance } = require("../models/challengeInstance");
const { Steps } = require("../models/steps");
const { WeeklyChallenge } = require("../models/weeklyChallenge");
const { resolveChallenge } = require("./challengeResolution");
const { selectWeeklyChallenge } = require("./challengeScheduler");
const { getMondayOfWeek, getNextMonday9amNewYork } = require("../utils/week");

function normalizeStatus(status) {
  return String(status || "").toUpperCase();
}


function serializeWeeklyChallenge(weeklyChallenge) {
  if (!weeklyChallenge) return null;

  return {
    ...weeklyChallenge,
    weekOf:
      weeklyChallenge.weekOf instanceof Date
        ? weeklyChallenge.weekOf.toISOString().slice(0, 10)
        : weeklyChallenge.weekOf,
    droppedAt:
      weeklyChallenge.droppedAt instanceof Date
        ? weeklyChallenge.droppedAt.toISOString()
        : weeklyChallenge.droppedAt,
    resolvedAt:
      weeklyChallenge.resolvedAt instanceof Date
        ? weeklyChallenge.resolvedAt.toISOString()
        : weeklyChallenge.resolvedAt,
  };
}

async function getDailyStepsForWeek(userId, weekOf, stepsModel = Steps) {
  const steps = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(`${weekOf}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + i);
    const dateStr = date.toISOString().slice(0, 10);
    const record = await stepsModel.findByUserIdAndDate(userId, dateStr);
    steps.push({ date: dateStr, steps: record?.steps || 0 });
  }
  return steps;
}

function countInstancesByStatus(instances) {
  return instances.reduce(
    (counts, instance) => {
      const status = normalizeStatus(instance.status);
      if (status === "PENDING_STAKE") counts.pendingStake += 1;
      if (status === "ACTIVE") counts.active += 1;
      if (status === "COMPLETED") counts.completed += 1;
      counts.total += 1;
      return counts;
    },
    { total: 0, pendingStake: 0, active: 0, completed: 0 }
  );
}

function buildEnsureWeeklyChallengeForDate(dependencies = {}) {
  const weeklyChallengeModel = dependencies.WeeklyChallenge || WeeklyChallenge;
  const selectChallenge =
    dependencies.selectWeeklyChallenge || selectWeeklyChallenge;
  const events = dependencies.eventBus || eventBus;
  const challengeModel = dependencies.Challenge || Challenge;

  return async function ensureWeeklyChallengeForDate({
    now = new Date(),
  } = {}) {
    const weekOf = getMondayOfWeek(now);
    const existing = await weeklyChallengeModel.findByWeek(weekOf);

    if (existing) {
      return {
        created: false,
        weeklyChallenge: serializeWeeklyChallenge(existing),
      };
    }

    const selected = await selectChallenge({
      async findActiveChallenges() {
        return challengeModel.findActive();
      },
      async markChallengeUsed(challengeId) {
        return challengeModel.markUsed(challengeId);
      },
      now,
    });

    try {
      const weeklyChallenge = await weeklyChallengeModel.create({
        weekOf,
        challengeId: selected.id,
      });

      events.emit("CHALLENGE_DROPPED", {
        challengeId: selected.id,
        title: selected.title,
        weekOf,
      });

      return {
        created: true,
        weeklyChallenge: serializeWeeklyChallenge(weeklyChallenge),
      };
    } catch (error) {
      if (error?.code === "P2002") {
        const existingAfterConflict = await weeklyChallengeModel.findByWeek(weekOf);
        return {
          created: false,
          weeklyChallenge: serializeWeeklyChallenge(existingAfterConflict),
        };
      }

      throw error;
    }
  };
}

function buildResolveWeekInstances(dependencies = {}) {
  const instanceModel = dependencies.ChallengeInstance || ChallengeInstance;
  const stepsModel = dependencies.Steps || Steps;
  const resolve = dependencies.resolveChallenge || resolveChallenge;
  const events = dependencies.eventBus || eventBus;

  return async function resolveWeekInstances({ weekOf }) {
    const instances = await instanceModel.findActiveAndPending(weekOf);
    let resolvedInstances = 0;
    let skippedInstances = 0;

    for (const instance of instances) {
      if (normalizeStatus(instance.status) === "PENDING_STAKE") {
        await instanceModel.update(instance.id, {
          status: "COMPLETED",
          stakeStatus: "SKIPPED",
          resolvedAt: new Date(),
        });
        skippedInstances += 1;
        continue;
      }

      const dailyStepsA = await getDailyStepsForWeek(
        instance.userAId,
        weekOf,
        stepsModel
      );
      const dailyStepsB = await getDailyStepsForWeek(
        instance.userBId,
        weekOf,
        stepsModel
      );

      const result = resolve({
        challenge: instance.challenge,
        userAId: instance.userAId,
        userBId: instance.userBId,
        dailyStepsA,
        dailyStepsB,
      });

      await instanceModel.update(instance.id, {
        status: "COMPLETED",
        winnerUserId: result.winnerUserId,
        userATotalSteps: result.userATotalSteps,
        userBTotalSteps: result.userBTotalSteps,
        resolvedAt: new Date(),
      });

      events.emit("CHALLENGE_RESOLVED", {
        instanceId: instance.id,
        winnerUserId: result.winnerUserId,
        userAId: instance.userAId,
        userBId: instance.userBId,
      });

      resolvedInstances += 1;
    }

    return {
      totalInstances: instances.length,
      resolvedInstances,
      skippedInstances,
    };
  };
}

function buildResolveWeeklyChallengeForDate(dependencies = {}) {
  const weeklyChallengeModel = dependencies.WeeklyChallenge || WeeklyChallenge;
  const resolveWeekInstances =
    dependencies.runSundayResolution || buildResolveWeekInstances(dependencies);

  return async function resolveWeeklyChallengeForDate({
    now = new Date(),
  } = {}) {
    const weekOf = getMondayOfWeek(now);
    const weeklyChallenge = await weeklyChallengeModel.findByWeek(weekOf);

    if (!weeklyChallenge) {
      const error = new Error("No weekly challenge exists for the current week");
      error.statusCode = 404;
      throw error;
    }

    if (weeklyChallenge.resolvedAt) {
      return {
        resolved: false,
        weeklyChallenge: serializeWeeklyChallenge(weeklyChallenge),
        summary: {
          totalInstances: 0,
          resolvedInstances: 0,
          skippedInstances: 0,
        },
      };
    }

    const summary = await resolveWeekInstances({ weekOf });
    const updated = await weeklyChallengeModel.markResolved(weekOf, new Date());

    return {
      resolved: true,
      weeklyChallenge: serializeWeeklyChallenge(updated),
      summary,
    };
  };
}

function buildResetWeeklyChallengeForDate(dependencies = {}) {
  const weeklyChallengeModel = dependencies.WeeklyChallenge || WeeklyChallenge;
  const instanceModel = dependencies.ChallengeInstance || ChallengeInstance;

  return async function resetWeeklyChallengeForDate({
    now = new Date(),
  } = {}) {
    const weekOf = getMondayOfWeek(now);
    const weeklyChallenge = await weeklyChallengeModel.findByWeek(weekOf);

    if (!weeklyChallenge) {
      const error = new Error("No weekly challenge exists for the current week");
      error.statusCode = 404;
      throw error;
    }

    const deletedInstances = await instanceModel.deleteByWeek(weekOf);
    const updated = await weeklyChallengeModel.markUnresolved(weekOf);

    return {
      reset: true,
      deletedInstances,
      weeklyChallenge: serializeWeeklyChallenge(updated),
    };
  };
}

function buildGetWeeklyChallengeAdminState(dependencies = {}) {
  const weeklyChallengeModel = dependencies.WeeklyChallenge || WeeklyChallenge;
  const instanceModel = dependencies.ChallengeInstance || ChallengeInstance;

  return async function getWeeklyChallengeAdminState({
    now = new Date(),
  } = {}) {
    const weekOf = getMondayOfWeek(now);
    const weeklyChallenge = await weeklyChallengeModel.findByWeek(weekOf);

    if (!weeklyChallenge) {
      return {
        weeklyChallenge: null,
        instances: [],
        instanceCounts: {
          total: 0,
          pendingStake: 0,
          active: 0,
          completed: 0,
        },
        nextDropAt: getNextMonday9amNewYork(now),
      };
    }

    const instances = await instanceModel.findByWeek(weekOf);

    return {
      weeklyChallenge: serializeWeeklyChallenge(weeklyChallenge),
      instances,
      instanceCounts: countInstancesByStatus(instances),
    };
  };
}

const ensureWeeklyChallengeForDate = buildEnsureWeeklyChallengeForDate();
const resolveWeeklyChallengeForDate = buildResolveWeeklyChallengeForDate();
const resetWeeklyChallengeForDate = buildResetWeeklyChallengeForDate();
const getWeeklyChallengeAdminState = buildGetWeeklyChallengeAdminState();

module.exports = {
  buildEnsureWeeklyChallengeForDate,
  buildResolveWeeklyChallengeForDate,
  buildResetWeeklyChallengeForDate,
  buildGetWeeklyChallengeAdminState,
  ensureWeeklyChallengeForDate,
  resolveWeeklyChallengeForDate,
  resetWeeklyChallengeForDate,
  getWeeklyChallengeAdminState,
};
