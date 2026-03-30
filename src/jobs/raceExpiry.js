const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { StepSample } = require("../models/stepSample");
const { Steps } = require("../models/steps");
const { completeRace } = require("../commands/completeRace");
const { computeEffectModifiers } = require("../queries/getRaceProgress");

async function resolveExpiredRaces() {
  console.log("[CRON] Checking for expired races...");

  const now = new Date();
  const expiredRaces = await Race.findActiveExpired(now);

  if (expiredRaces.length === 0) {
    console.log("[CRON] No expired races found");
    return;
  }

  console.log(`[CRON] Found ${expiredRaces.length} expired race(s)`);

  for (const race of expiredRaces) {
    try {
      const acceptedParticipants = race.participants.filter(
        (p) => p.status === "ACCEPTED"
      );
      const today = now.toISOString().slice(0, 10);

      let topUserId = null;
      let topSteps = 0;

      const raceStartedAt = race.startedAt;

      for (const p of acceptedParticipants) {
        const joinedAt = p.joinedAt || raceStartedAt;
        const effectiveStart = joinedAt > raceStartedAt ? joinedAt : raceStartedAt;
        const startDate = effectiveStart.toISOString().slice(0, 10);
        const nextDay = new Date(effectiveStart);
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
        const dayAfterStartDate = nextDay.toISOString().slice(0, 10);

        // Start day: use StepSample for precision, fallback to baseline
        let startDaySteps = 0;
        const startDaySamples = await StepSample.sumStepsInWindow(
          p.userId, effectiveStart, new Date(dayAfterStartDate)
        );
        if (startDaySamples > 0) {
          startDaySteps = startDaySamples;
        } else if (p.baselineSteps > 0) {
          const startDayRecord = await Steps.findByUserIdAndDate(p.userId, startDate);
          startDaySteps = Math.max(0, (startDayRecord?.steps || 0) - p.baselineSteps);
        }

        // Subsequent days: full daily totals
        let subsequentSteps = 0;
        if (dayAfterStartDate <= today) {
          const laterSteps = await Steps.findByUserIdAndDateRange(p.userId, dayAfterStartDate, today);
          subsequentSteps = laterSteps.reduce((sum, s) => sum + s.steps, 0);
        }

        let total = Math.max(0, startDaySteps + subsequentSteps);

        // Apply powerup modifiers if enabled
        if (race.powerupsEnabled) {
          const legCramps = await RaceActiveEffect.findEffectsForRaceByType(race.id, p.id, "LEG_CRAMP");
          const runnersHighs = await RaceActiveEffect.findEffectsForRaceByType(race.id, p.id, "RUNNERS_HIGH");
          const allEffects = [...legCramps, ...runnersHighs];
          const baseAdjusted = total;
          const { frozenSteps, buffedSteps } = await computeEffectModifiers(allEffects, baseAdjusted, p.userId, StepSample);
          total = Math.max(0, baseAdjusted - frozenSteps + buffedSteps + (p.bonusSteps || 0));
        }

        await RaceParticipant.updateTotalSteps(p.id, total);

        if (total > topSteps) {
          topSteps = total;
          topUserId = p.userId;
        }
      }

      const participantUserIds = acceptedParticipants.map((p) => p.userId);

      await completeRace({
        raceId: race.id,
        winnerUserId: topUserId,
        participantUserIds,
      });

      console.log(
        `[CRON] Race ${race.id} ("${race.name}") expired. Winner: ${topUserId || "none"} with ${topSteps} steps`
      );
    } catch (error) {
      console.error(`[CRON] Failed to resolve expired race ${race.id}:`, error);
    }
  }
}

function scheduleRaceExpiryCheck() {
  const INTERVAL = 60 * 60 * 1000; // every hour

  async function run() {
    try {
      await resolveExpiredRaces();
    } catch (error) {
      console.error("[CRON] Race expiry check error:", error);
    }
  }

  setInterval(run, INTERVAL);
  console.log("[CRON] Race expiry check scheduled (hourly)");
}

module.exports = { resolveExpiredRaces, scheduleRaceExpiryCheck };
