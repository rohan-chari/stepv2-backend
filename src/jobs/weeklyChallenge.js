const { Challenge } = require("../models/challenge");
const { ChallengeInstance } = require("../models/challengeInstance");
const { ChallengeStreak } = require("../models/challengeStreak");
const { Steps } = require("../models/steps");
const {
  selectWeeklyChallenge,
} = require("../services/challengeScheduler");
const {
  resolveChallenge,
} = require("../services/challengeResolution");
const {
  updateStreak,
} = require("../services/streakTracking");
const { eventBus } = require("../events/eventBus");

function getMondayOfWeek(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day + 6) % 7;
  d.setDate(d.getDate() - diff);
  return d.toISOString().slice(0, 10);
}

async function getDailyStepsForWeek(userId, weekOf) {
  const steps = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(weekOf);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().slice(0, 10);
    const record = await Steps.findByUserIdAndDate(userId, dateStr);
    steps.push({ date: dateStr, steps: record?.steps || 0 });
  }
  return steps;
}

async function runMondayChallengeDrop() {
  console.log("[CRON] Running Monday challenge drop...");

  try {
    const selected = await selectWeeklyChallenge({
      async findActiveChallenges() {
        return Challenge.findActive();
      },
      async markChallengeUsed(challengeId) {
        return Challenge.markUsed(challengeId);
      },
      now: new Date(),
    });

    console.log(
      `[CRON] Selected challenge for this week: "${selected.title}" (${selected.id})`
    );

    eventBus.emit("CHALLENGE_DROPPED", {
      challengeId: selected.id,
      title: selected.title,
    });

    return selected;
  } catch (error) {
    console.error("[CRON] Challenge drop failed:", error);
    throw error;
  }
}

async function runSundayResolution() {
  console.log("[CRON] Running Sunday challenge resolution...");

  const weekOf = getMondayOfWeek();
  const instances = await ChallengeInstance.findActiveAndPending(weekOf);

  console.log(`[CRON] Found ${instances.length} instances to resolve`);

  for (const instance of instances) {
    try {
      if (instance.status === "PENDING_STAKE") {
        await ChallengeInstance.update(instance.id, {
          status: "COMPLETED",
          stakeStatus: "SKIPPED",
          resolvedAt: new Date(),
        });
        console.log(`[CRON] Skipped instance ${instance.id} (no stake agreed)`);
        continue;
      }

      const dailyStepsA = await getDailyStepsForWeek(instance.userAId, weekOf);
      const dailyStepsB = await getDailyStepsForWeek(instance.userBId, weekOf);

      const result = resolveChallenge({
        challenge: instance.challenge,
        userAId: instance.userAId,
        userBId: instance.userBId,
        dailyStepsA,
        dailyStepsB,
      });

      await ChallengeInstance.update(instance.id, {
        status: "COMPLETED",
        winnerUserId: result.winnerUserId,
        userATotalSteps: result.userATotalSteps,
        userBTotalSteps: result.userBTotalSteps,
        resolvedAt: new Date(),
      });

      // Update streak
      await updateStreak(
        {
          participantAId: instance.userAId,
          participantBId: instance.userBId,
          winnerUserId: result.winnerUserId,
        },
        {
          async findStreak(userAId, userBId) {
            return ChallengeStreak.findByPair(userAId, userBId);
          },
          async createStreak(data) {
            return ChallengeStreak.create(data);
          },
          async saveStreak(streak) {
            return ChallengeStreak.save(streak);
          },
        }
      );

      console.log(
        `[CRON] Resolved instance ${instance.id}: winner=${result.winnerUserId} (A:${result.userATotalSteps} B:${result.userBTotalSteps})`
      );

      eventBus.emit("CHALLENGE_RESOLVED", {
        instanceId: instance.id,
        winnerUserId: result.winnerUserId,
        userAId: instance.userAId,
        userBId: instance.userBId,
      });
    } catch (error) {
      console.error(
        `[CRON] Failed to resolve instance ${instance.id}:`,
        error
      );
    }
  }

  console.log("[CRON] Sunday resolution complete");
}

function scheduleCronJobs() {
  function msUntilNext(dayOfWeek, hour, minute, tz = "America/New_York") {
    const now = new Date();
    const target = new Date(
      now.toLocaleString("en-US", { timeZone: tz })
    );
    target.setHours(hour, minute, 0, 0);

    // Set to the right day of week
    const currentDay = target.getDay();
    let daysAhead = dayOfWeek - currentDay;
    if (daysAhead < 0) daysAhead += 7;
    if (daysAhead === 0 && now >= target) daysAhead = 7;
    target.setDate(target.getDate() + daysAhead);

    // Convert back: compute the offset between local tz time and UTC
    const tzNow = new Date(
      now.toLocaleString("en-US", { timeZone: tz })
    );
    const offset = tzNow.getTime() - now.getTime();

    return target.getTime() - offset - now.getTime();
  }

  function scheduleWeekly(dayOfWeek, hour, minute, fn, label) {
    function run() {
      fn().catch((err) => console.error(`[CRON] ${label} error:`, err));
      // Schedule next week
      setTimeout(run, 7 * 24 * 60 * 60 * 1000);
    }

    const ms = msUntilNext(dayOfWeek, hour, minute);
    const hours = (ms / 1000 / 60 / 60).toFixed(1);
    console.log(`[CRON] ${label} scheduled in ${hours}h`);
    setTimeout(run, ms);
  }

  // Monday 9:00 AM EST
  scheduleWeekly(1, 9, 0, runMondayChallengeDrop, "Monday challenge drop");

  // Sunday 11:59 PM EST
  scheduleWeekly(0, 23, 59, runSundayResolution, "Sunday resolution");
}

module.exports = { scheduleCronJobs, runMondayChallengeDrop, runSundayResolution };
