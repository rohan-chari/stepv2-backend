const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { StepSample } = require("../models/stepSample");
const { Steps } = require("../models/steps");
const { GlobalStepEvent } = require("../models/globalStepEvent");
const { completeRace } = require("../commands/completeRace");
const {
  calculateBaseAdjusted,
  calculateCurrentTotal,
  determineFinishSnapshot,
} = require("../services/raceStateResolution");
const { raceTimeZone } = require("../utils/raceTimeZone");

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

      // GlobalStepEvents overlapping the race window. Passed into the SHARED
      // resolution so the settled standings match what getRaceProgress showed.
      let globalEvents = [];
      try {
        globalEvents =
          (await GlobalStepEvent.findActiveInRange(
            race.startedAt,
            settlementTime
          )) || [];
      } catch {
        globalEvents = [];
      }

      const standings = [];

      for (const participant of acceptedParticipants) {
        // TR-601: a forfeited team-race member's total is FROZEN at the value
        // snapshotted by the forfeit command — never recomputed (an active
        // debuff at forfeit time bites permanently). It still counts toward
        // the team total below.
        if (participant.forfeitedAt) {
          standings.push({
            participant,
            totalSteps: participant.totalSteps || 0,
            reachedAt: new Date(participant.forfeitedAt),
          });
          continue;
        }

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
            // Seeded races settle in their canonical tz so settled totals match
            // what getRaceProgress showed live; user races keep UTC (legacy).
            timeZone: raceTimeZone(race, "UTC"),
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
            globalEvents,
            now: settlementTime,
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

      // ── Team settlement (TR-401/402/404) ─────────────────────────────────
      // Team total = sum of member effective totals (forfeited members' frozen
      // totals included). Higher total wins; equal totals are a TIE — no
      // sudden death, completeRace refunds every buy-in. Placements (1 for the
      // whole winning team, 2 for the losers, all 1 on tie) are set INSIDE
      // completeRace so the deadline path and the collapse path share it.
      if (race.isTeamRace) {
        const teamTotals = { TEAM_A: 0, TEAM_B: 0 };
        for (const standing of standings) {
          const team = standing.participant.team;
          if (team === "TEAM_A" || team === "TEAM_B") {
            teamTotals[team] += standing.totalSteps || 0;
          }
        }

        const isTie = teamTotals.TEAM_A === teamTotals.TEAM_B;
        const winnerTeam = isTie
          ? null
          : teamTotals.TEAM_A > teamTotals.TEAM_B
            ? "TEAM_A"
            : "TEAM_B";

        await completeRace({
          raceId: race.id,
          winnerUserId: null,
          winnerTeam,
          tie: isTie,
          participantUserIds: acceptedParticipants.map((p) => p.userId),
        });

        console.log(
          `[CRON] Team race ${race.id} ("${race.name}") expired. ` +
            (isTie
              ? `Tie at ${teamTotals.TEAM_A} steps — buy-ins refunded`
              : `Winner: ${winnerTeam} (${teamTotals.TEAM_A} vs ${teamTotals.TEAM_B})`)
        );
        continue;
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
  // Every 5 minutes — matches the seeded-race renewal cadence so a finished
  // daily/weekly race is settled promptly and the next one spins up within
  // minutes (keeps the Featured section from showing a long "starting soon"
  // gap). The check is idempotent (completeRace early-returns on non-ACTIVE).
  const INTERVAL = 5 * 60 * 1000; // every 5 minutes

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
