const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { Steps } = require("../models/steps");
const { StepSample } = require("../models/stepSample");
const { RacePowerup } = require("../models/racePowerup");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { completeRace } = require("../commands/completeRace");
const { rollPowerup } = require("../commands/rollPowerup");
const { expireEffects } = require("../commands/expireEffects");

// Snapshot-based fallback for when StepSample data is unavailable
function computeEffectModifiersFallback(effects, rawTotal) {
  let frozenSteps = 0;
  let buffedSteps = 0;

  for (const effect of effects) {
    const meta = effect.metadata || {};

    if (effect.type === "LEG_CRAMP") {
      const start = meta.stepsAtFreezeStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
        ? meta.stepsAtExpiry
        : rawTotal;
      frozenSteps += Math.max(0, end - start);
    }

    if (effect.type === "RUNNERS_HIGH") {
      const start = meta.stepsAtBuffStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
        ? meta.stepsAtExpiry
        : rawTotal;
      buffedSteps += Math.max(0, end - start);
    }
  }

  return { frozenSteps, buffedSteps };
}

async function computeEffectModifiers(effects, rawTotal, userId, stepSampleModel) {
  let frozenSteps = 0;
  let buffedSteps = 0;

  for (const effect of effects) {
    const windowStart = effect.startsAt;
    const windowEnd = effect.expiresAt || new Date();

    if (effect.type === "LEG_CRAMP") {
      const sampleSteps = await stepSampleModel.sumStepsInWindow(userId, windowStart, windowEnd);
      if (sampleSteps > 0) {
        frozenSteps += sampleSteps;
      } else {
        // Fallback to snapshot approximation
        const meta = effect.metadata || {};
        const start = meta.stepsAtFreezeStart || 0;
        const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
          ? meta.stepsAtExpiry
          : rawTotal;
        frozenSteps += Math.max(0, end - start);
      }
    }

    if (effect.type === "RUNNERS_HIGH") {
      const sampleSteps = await stepSampleModel.sumStepsInWindow(userId, windowStart, windowEnd);
      if (sampleSteps > 0) {
        buffedSteps += sampleSteps;
      } else {
        // Fallback to snapshot approximation
        const meta = effect.metadata || {};
        const start = meta.stepsAtBuffStart || 0;
        const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
          ? meta.stepsAtExpiry
          : rawTotal;
        buffedSteps += Math.max(0, end - start);
      }
    }
  }

  return { frozenSteps, buffedSteps };
}

async function getRaceProgress(userId, raceId, timeZone) {
  const race = await Race.findById(raceId);
  if (!race) {
    const error = new Error("Race not found");
    error.statusCode = 404;
    throw error;
  }

  const myParticipant = race.participants.find((p) => p.userId === userId);
  if (!myParticipant) {
    const error = new Error("You are not a participant in this race");
    error.statusCode = 403;
    throw error;
  }

  if (race.status !== "ACTIVE") {
    const acceptedParticipants = race.participants.filter((p) => p.status === "ACCEPTED");
    return {
      raceId: race.id,
      status: race.status,
      targetSteps: race.targetSteps,
      endsAt: race.endsAt,
      participants: acceptedParticipants.map((p) => ({
        userId: p.userId,
        displayName: p.user.displayName,
        totalSteps: p.totalSteps,
        progress: Math.min(p.totalSteps / race.targetSteps, 1),
        finishedAt: p.finishedAt,
      })),
    };
  }

  // Expire timed effects before calculating
  const participantStepsMap = {};
  const today = new Date().toISOString().slice(0, 10);
  const acceptedParticipants = race.participants.filter((p) => p.status === "ACCEPTED");

  // First pass: calculate raw step totals for expiry snapshots
  const raceStartedAt = race.startedAt;
  const rawStepTotals = await Promise.all(
    acceptedParticipants.map(async (p) => {
      const joinedAt = p.joinedAt || raceStartedAt;
      // Use the later of joinedAt and raceStartedAt (joinedAt could be pre-start for early accepters)
      const effectiveStart = joinedAt > raceStartedAt ? joinedAt : raceStartedAt;
      const startDate = effectiveStart.toISOString().slice(0, 10);
      const nextDay = new Date(effectiveStart);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const dayAfterStartDate = nextDay.toISOString().slice(0, 10);

      // For the start day: try StepSample for precise post-start steps
      let startDaySteps = 0;
      const startDaySamples = await StepSample.sumStepsInWindow(
        p.userId, effectiveStart, new Date(dayAfterStartDate)
      );
      if (startDaySamples > 0) {
        startDaySteps = startDaySamples;
      } else if (p.baselineSteps > 0) {
        // Have a reliable baseline snapshot - use daily total minus baseline
        const startDayRecord = await Steps.findByUserIdAndDate(p.userId, startDate);
        startDaySteps = Math.max(0, (startDayRecord?.steps || 0) - p.baselineSteps);
      }
      // No samples AND no baseline = 0 for start day (don't over-count)

      // For days after the start day: count full daily totals
      let subsequentSteps = 0;
      if (dayAfterStartDate <= today) {
        const laterSteps = await Steps.findByUserIdAndDateRange(p.userId, dayAfterStartDate, today);
        subsequentSteps = laterSteps.reduce((sum, s) => sum + s.steps, 0);
      }

      const baseAdjusted = Math.max(0, startDaySteps + subsequentSteps);
      participantStepsMap[p.id] = baseAdjusted;
      return { participant: p, baseAdjusted };
    })
  );

  await expireEffects({ raceId, participantSteps: participantStepsMap });

  // Second pass: calculate powerup-adjusted totals
  const stepTotals = await Promise.all(
    rawStepTotals.map(async ({ participant, baseAdjusted }) => {
      let total = baseAdjusted;

      if (race.powerupsEnabled) {
        // Fetch all Leg Cramp and Runner's High effects (active + expired) for this participant
        const legCramps = await RaceActiveEffect.findEffectsForRaceByType(raceId, participant.id, "LEG_CRAMP");
        const runnersHighs = await RaceActiveEffect.findEffectsForRaceByType(raceId, participant.id, "RUNNERS_HIGH");

        const allEffects = [...legCramps, ...runnersHighs];
        const { frozenSteps, buffedSteps } = await computeEffectModifiers(allEffects, baseAdjusted, participant.userId, StepSample);

        total = Math.max(0, baseAdjusted - frozenSteps + buffedSteps + (participant.bonusSteps || 0));
      }

      return { participant, totalSteps: total };
    })
  );

  // Check for powerup thresholds and first finisher
  let firstFinisher = null;

  // Sort by steps to determine positions for powerup rolls
  const sorted = [...stepTotals].sort((a, b) => b.totalSteps - a.totalSteps);

  for (const { participant, totalSteps } of stepTotals) {
    await RaceParticipant.updateTotalSteps(participant.id, totalSteps);

    if (totalSteps >= race.targetSteps && !participant.finishedAt) {
      await RaceParticipant.markFinished(participant.id, new Date());
      if (!firstFinisher || totalSteps > firstFinisher.totalSteps) {
        firstFinisher = { userId: participant.userId, totalSteps };
      }
    }
  }

  if (firstFinisher) {
    const allUserIds = acceptedParticipants.map((p) => p.userId);
    await completeRace({
      raceId,
      winnerUserId: firstFinisher.userId,
      participantUserIds: allUserIds,
    });
  }

  // Roll powerups for the requesting user if they crossed a threshold
  let powerupData = null;

  if (race.powerupsEnabled && race.powerupStepInterval) {
    const myStepEntry = stepTotals.find((s) => s.participant.userId === userId);
    const myP = myStepEntry?.participant;

    if (myP && myP.nextBoxAtSteps > 0 && myStepEntry.totalSteps >= myP.nextBoxAtSteps) {
      const position = sorted.findIndex((s) => s.participant.userId === userId) + 1;

      const rollResults = await rollPowerup({
        raceId,
        participantId: myP.id,
        userId,
        currentSteps: myStepEntry.totalSteps,
        nextBoxAtSteps: myP.nextBoxAtSteps,
        position,
        totalParticipants: sorted.length,
        powerupStepInterval: race.powerupStepInterval,
        displayName: myP.user.displayName,
      });

      const newBoxes = rollResults.filter((r) => r.powerup);
      const inventoryFull = rollResults.some((r) => r.inventoryFull);

      powerupData = {
        enabled: true,
        newBoxesEarned: newBoxes.map((r) => r.powerup),
        inventoryFull,
      };
    }

    // Always include inventory and active effects
    if (!powerupData) {
      powerupData = { enabled: true, newBoxesEarned: [], inventoryFull: false };
    }

    const inventory = await RacePowerup.findHeldByParticipant(myParticipant.id);
    powerupData.inventory = inventory.map((p) => ({
      id: p.id,
      type: p.type,
      rarity: p.rarity,
    }));

    const myActiveEffects = await RaceActiveEffect.findActiveForParticipant(myParticipant.id);
    const raceActiveEffects = await RaceActiveEffect.findActiveForRace(raceId);

    powerupData.activeEffects = raceActiveEffects.map((e) => ({
      type: e.type,
      expiresAt: e.expiresAt,
      onSelf: e.targetUserId === userId,
      targetUserId: e.targetUserId,
      sourceUserId: e.sourceUserId,
    }));
  }

  // Build leaderboard with stealth mode applied
  const stealthedUserIds = new Set();
  if (race.powerupsEnabled) {
    const activeEffects = await RaceActiveEffect.findActiveForRace(raceId);
    for (const e of activeEffects) {
      if (e.type === "STEALTH_MODE") {
        stealthedUserIds.add(e.targetUserId);
      }
    }
  }

  const leaderboard = stepTotals
    .map(({ participant, totalSteps }) => {
      const isStealthed = stealthedUserIds.has(participant.userId) && participant.userId !== userId;
      return {
        userId: participant.userId,
        displayName: isStealthed ? "???" : participant.user.displayName,
        totalSteps: isStealthed ? null : totalSteps,
        progress: isStealthed ? null : Math.min(totalSteps / race.targetSteps, 1),
        finishedAt: participant.finishedAt,
        stealthed: isStealthed,
      };
    })
    .sort((a, b) => {
      // Sort stealthed players to an arbitrary position (treat null as 0 for sorting)
      const aSteps = a.totalSteps ?? 0;
      const bSteps = b.totalSteps ?? 0;
      return bSteps - aSteps;
    });

  const updatedRace = await Race.findById(raceId);

  const result = {
    raceId: race.id,
    status: updatedRace.status,
    targetSteps: race.targetSteps,
    endsAt: race.endsAt,
    participants: leaderboard,
  };

  if (powerupData) {
    result.powerupData = powerupData;
  }

  return result;
}

module.exports = { getRaceProgress, computeEffectModifiers };
