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

      for (const p of acceptedParticipants) {
        const startDate = (p.joinedAt || race.startedAt)
          .toISOString()
          .slice(0, 10);
        const steps = await Steps.findByUserIdAndDateRange(
          p.userId,
          startDate,
          today
        );
        const raw = steps.reduce((sum, s) => sum + s.steps, 0);
        let total = Math.max(0, raw - (p.baselineSteps || 0));

        // Apply powerup modifiers if enabled
        if (race.powerupsEnabled) {
          const legCramps = await RaceActiveEffect.findEffectsForRaceByType(race.id, p.id, "LEG_CRAMP");
          const runnersHighs = await RaceActiveEffect.findEffectsForRaceByType(race.id, p.id, "RUNNERS_HIGH");
          const allEffects = [...legCramps, ...runnersHighs];
          const baseAdjusted = Math.max(0, raw - (p.baselineSteps || 0));
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
