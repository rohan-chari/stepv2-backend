const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { StepSample } = require("../models/stepSample");
const { Steps } = require("../models/steps");
const { completeRace } = require("../commands/completeRace");
const {
  calculateBaseAdjusted,
  calculateCurrentTotal,
  determineFinishSnapshot,
} = require("../services/raceStateResolution");

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
      const settlementTime = race.endsAt || now;
      const standings = [];

      for (const participant of acceptedParticipants) {
        if (participant.finishedAt) {
          standings.push({
            participant,
            totalSteps:
              participant.finishTotalSteps ??
              participant.totalSteps ??
              race.targetSteps,
            reachedAt: new Date(participant.finishedAt),
          });
          continue;
        }

        const { baseAdjusted, hasSampleData, effectiveStart } =
          await calculateBaseAdjusted({
            participant,
            raceStartedAt: race.startedAt,
            timeZone: "UTC",
            stepsModel: Steps,
            stepSampleModel: StepSample,
            now: settlementTime,
          });

        const { total, legCramps, runnersHighs, wrongTurns } =
          await calculateCurrentTotal({
            raceId: race.id,
            racePowerupsEnabled: race.powerupsEnabled,
            participant,
            baseAdjusted,
            hasSampleData,
            raceActiveEffectModel: RaceActiveEffect,
            stepSampleModel: StepSample,
          });

        await RaceParticipant.updateTotalSteps(participant.id, total);
        const reachedSnapshot = await determineFinishSnapshot({
          participant,
          currentTotal: total,
          targetSteps: total,
          effectiveStart,
          effectGroups: { legCramps, runnersHighs, wrongTurns },
          stepSampleModel: StepSample,
          powerupEventModel: RacePowerupEvent,
          raceId: race.id,
          now: settlementTime,
        });

        standings.push({
          participant,
          totalSteps: total,
          reachedAt: reachedSnapshot?.finishedAt || settlementTime,
        });
      }

      standings.sort((a, b) => {
        const totalDiff = b.totalSteps - a.totalSteps;
        if (totalDiff !== 0) return totalDiff;

        const reachedDiff =
          new Date(a.reachedAt).getTime() - new Date(b.reachedAt).getTime();
        if (reachedDiff !== 0) return reachedDiff;

        return (a.participant.userId || "").localeCompare(b.participant.userId || "");
      });

      for (let index = 0; index < standings.length; index++) {
        await RaceParticipant.setPlacement(
          standings[index].participant.id,
          index + 1
        );
      }

      const participantUserIds = acceptedParticipants.map((p) => p.userId);
      const topUserId = standings[0]?.participant.userId || null;
      const topSteps = standings[0]?.totalSteps || 0;

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
