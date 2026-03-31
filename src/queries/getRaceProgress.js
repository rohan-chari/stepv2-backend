const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { Steps } = require("../models/steps");
const { StepSample } = require("../models/stepSample");
const { RacePowerup } = require("../models/racePowerup");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { completeRace } = require("../commands/completeRace");
const { rollPowerup } = require("../commands/rollPowerup");
const { expireEffects } = require("../commands/expireEffects");
const { getTimeZoneParts, formatDateString, addDaysToDateString, parseDateString, zonedDateTimeToUtc } = require("../utils/week");

// Snapshot-based fallback for when StepSample data is unavailable
function computeEffectModifiersFallback(effects, rawTotal) {
  let frozenSteps = 0;
  let buffedSteps = 0;
  let reversedSteps = 0;

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

    if (effect.type === "WRONG_TURN") {
      const start = meta.stepsAtStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
        ? meta.stepsAtExpiry
        : rawTotal;
      reversedSteps += Math.max(0, end - start);
    }
  }

  return { frozenSteps, buffedSteps, reversedSteps };
}

async function computeEffectModifiers(effects, rawTotal, userId, stepSampleModel) {
  let frozenSteps = 0;
  let buffedSteps = 0;
  let reversedSteps = 0;

  const legCramps = effects.filter((e) => e.type === "LEG_CRAMP");
  const runnersHighs = effects.filter((e) => e.type === "RUNNERS_HIGH");
  const wrongTurns = effects.filter((e) => e.type === "WRONG_TURN");

  for (const effect of legCramps) {
    const windowStart = effect.startsAt;
    const windowEnd = effect.expiresAt || new Date();

    const sampleSteps = await stepSampleModel.sumStepsInWindow(userId, windowStart, windowEnd);
    if (sampleSteps > 0) {
      frozenSteps += sampleSteps;
    } else {
      const meta = effect.metadata || {};
      const start = meta.stepsAtFreezeStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
        ? meta.stepsAtExpiry
        : rawTotal;
      frozenSteps += Math.max(0, end - start);
    }
  }

  for (const effect of runnersHighs) {
    const windowStart = effect.startsAt;
    const windowEnd = effect.expiresAt || new Date();

    const sampleSteps = await stepSampleModel.sumStepsInWindow(userId, windowStart, windowEnd);
    if (sampleSteps > 0) {
      buffedSteps += sampleSteps;
    } else {
      const meta = effect.metadata || {};
      const start = meta.stepsAtBuffStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
        ? meta.stepsAtExpiry
        : rawTotal;
      buffedSteps += Math.max(0, end - start);
    }
  }

  // Subtract overlap: steps during both a freeze and a buff should be frozen, not buffed
  for (const cramp of legCramps) {
    const crampStart = cramp.startsAt.getTime();
    const crampEnd = (cramp.expiresAt || new Date()).getTime();

    for (const buff of runnersHighs) {
      const buffStart = buff.startsAt.getTime();
      const buffEnd = (buff.expiresAt || new Date()).getTime();

      const overlapStart = Math.max(crampStart, buffStart);
      const overlapEnd = Math.min(crampEnd, buffEnd);

      if (overlapStart < overlapEnd) {
        const overlapSteps = await stepSampleModel.sumStepsInWindow(
          userId, new Date(overlapStart), new Date(overlapEnd)
        );
        if (overlapSteps > 0) {
          buffedSteps -= overlapSteps;
        }
      }
    }
  }

  // Wrong Turn: steps during the effect are reversed (subtracted twice — once to undo, once to negate)
  for (const effect of wrongTurns) {
    const windowStart = effect.startsAt;
    const windowEnd = effect.expiresAt || new Date();

    const sampleSteps = await stepSampleModel.sumStepsInWindow(userId, windowStart, windowEnd);
    if (sampleSteps > 0) {
      reversedSteps += sampleSteps;
    }
  }

  // Wrong Turn + Runner's High overlap: steps are doubled AND negated
  for (const wt of wrongTurns) {
    const wtStart = wt.startsAt.getTime();
    const wtEnd = (wt.expiresAt || new Date()).getTime();

    for (const buff of runnersHighs) {
      const buffStart = buff.startsAt.getTime();
      const buffEnd = (buff.expiresAt || new Date()).getTime();

      const overlapStart = Math.max(wtStart, buffStart);
      const overlapEnd = Math.min(wtEnd, buffEnd);

      if (overlapStart < overlapEnd) {
        const overlapSteps = await stepSampleModel.sumStepsInWindow(
          userId, new Date(overlapStart), new Date(overlapEnd)
        );
        if (overlapSteps > 0) {
          // Remove buff credit and negate for doubled reversal
          buffedSteps -= 2 * overlapSteps;
        }
      }
    }
  }

  return { frozenSteps, buffedSteps, reversedSteps };
}

function buildGetRaceProgress(deps = {}) {
  const raceModel = deps.Race || Race;
  const participantModel = deps.RaceParticipant || RaceParticipant;
  const stepsModel = deps.Steps || Steps;
  const stepSampleModel = deps.StepSample || StepSample;
  const racePowerupModel = deps.RacePowerup || RacePowerup;
  const raceActiveEffectModel = deps.RaceActiveEffect || RaceActiveEffect;
  const completeRaceFn = deps.completeRace || completeRace;
  const rollPowerupFn = deps.rollPowerup || rollPowerup;
  const expireEffectsFn = deps.expireEffects || expireEffects;
  const now = deps.now || (() => new Date());

  return async function getRaceProgress(userId, raceId, timeZone) {
    const race = await raceModel.findById(raceId);
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
    const nowParts = getTimeZoneParts(now(), timeZone);
    const today = formatDateString(nowParts.year, nowParts.month, nowParts.day);
    const acceptedParticipants = race.participants.filter((p) => p.status === "ACCEPTED");

    // First pass: calculate raw step totals for expiry snapshots
    const raceStartedAt = race.startedAt;
    const rawStepTotals = await Promise.all(
      acceptedParticipants.map(async (p) => {
        const joinedAt = p.joinedAt || raceStartedAt;
        // Use the later of joinedAt and raceStartedAt (joinedAt could be pre-start for early accepters)
        const effectiveStart = joinedAt > raceStartedAt ? joinedAt : raceStartedAt;

        // Daily Steps queries use timezone-aware dates (steps are stored under local dates)
        const startParts = getTimeZoneParts(effectiveStart, timeZone);
        const startDate = formatDateString(startParts.year, startParts.month, startParts.day);
        const dayAfterStartDate = addDaysToDateString(startDate, 1);

        // StepSample window: from race start to end of the local start day
        // (midnight of the next day in the user's timezone, converted to UTC).
        // Using local midnight instead of UTC midnight ensures steps taken later
        // in the same local day are captured even when the race starts near UTC midnight.
        const dayAfterParsed = parseDateString(dayAfterStartDate);
        const startDayWindowEnd = zonedDateTimeToUtc({
          year: dayAfterParsed.year,
          month: dayAfterParsed.month,
          day: dayAfterParsed.day,
          hour: 0,
          minute: 0,
          second: 0,
        }, timeZone);

        // For the start day: try StepSample for precise post-start steps
        let startDaySteps = 0;
        const startDaySamples = await stepSampleModel.sumStepsInWindow(
          p.userId, effectiveStart, startDayWindowEnd
        );
        if (startDaySamples > 0) {
          startDaySteps = startDaySamples;
        } else if (p.baselineSteps > 0) {
          // Have a reliable baseline snapshot - use daily total minus baseline
          const startDayRecord = await stepsModel.findByUserIdAndDate(p.userId, startDate);
          startDaySteps = Math.max(0, (startDayRecord?.steps || 0) - p.baselineSteps);
        }
        // No samples AND no baseline = 0 for start day (don't over-count)

        // For days after the start day: count full daily totals
        let subsequentSteps = 0;
        if (dayAfterStartDate <= today) {
          const laterSteps = await stepsModel.findByUserIdAndDateRange(p.userId, dayAfterStartDate, today);
          subsequentSteps = laterSteps.reduce((sum, s) => sum + s.steps, 0);
        }

        const baseAdjusted = Math.max(0, startDaySteps + subsequentSteps);
        participantStepsMap[p.id] = baseAdjusted;
        return { participant: p, baseAdjusted };
      })
    );

    await expireEffectsFn({ raceId, participantSteps: participantStepsMap });

    // Second pass: calculate powerup-adjusted totals
    const stepTotals = await Promise.all(
      rawStepTotals.map(async ({ participant, baseAdjusted }) => {
        let total = baseAdjusted;

        if (race.powerupsEnabled) {
          // Fetch all Leg Cramp, Runner's High, and Wrong Turn effects (active + expired) for this participant
          const legCramps = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "LEG_CRAMP");
          const runnersHighs = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "RUNNERS_HIGH");
          const wrongTurns = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "WRONG_TURN");

          const allEffects = [...legCramps, ...runnersHighs, ...wrongTurns];
          const { frozenSteps, buffedSteps, reversedSteps } = await computeEffectModifiers(allEffects, baseAdjusted, participant.userId, stepSampleModel);

          total = Math.max(0, baseAdjusted - frozenSteps + buffedSteps - 2 * reversedSteps + (participant.bonusSteps || 0));
        }

        return { participant, totalSteps: total };
      })
    );

    // Sort by steps to determine positions for powerup rolls
    const sorted = [...stepTotals].sort((a, b) => b.totalSteps - a.totalSteps);

    // Count previously finished participants
    const previouslyFinished = acceptedParticipants.filter((p) => p.finishedAt).length;

    // Find new finishers this tick
    const newFinishers = [];
    for (const { participant, totalSteps } of stepTotals) {
      await participantModel.updateTotalSteps(participant.id, totalSteps);

      if (totalSteps >= race.targetSteps && !participant.finishedAt) {
        await participantModel.markFinished(participant.id, now());
        newFinishers.push({ participant, totalSteps });
      }
    }

    // Assign placements — sort new finishers by steps descending for tiebreaking
    newFinishers.sort((a, b) => b.totalSteps - a.totalSteps);
    for (let i = 0; i < newFinishers.length; i++) {
      const placement = previouslyFinished + i + 1;
      await participantModel.setPlacement(newFinishers[i].participant.id, placement);
    }

    // Determine if race should complete: need top 3 finished, or 1st if <3 participants
    const totalFinished = previouslyFinished + newFinishers.length;
    const finishThreshold = acceptedParticipants.length < 3 ? 1 : 3;

    if (newFinishers.length > 0 && totalFinished >= finishThreshold && previouslyFinished < finishThreshold) {
      // Winner is the participant with placement 1
      // Could be from a prior tick or the top new finisher
      let winnerUserId;
      const priorWinner = acceptedParticipants.find((p) => p.placement === 1);
      if (priorWinner) {
        winnerUserId = priorWinner.userId;
      } else {
        // First finisher(s) this tick — highest steps among new finishers is placement 1
        winnerUserId = newFinishers[0].participant.userId;
      }

      const allUserIds = acceptedParticipants.map((p) => p.userId);
      await completeRaceFn({
        raceId,
        winnerUserId,
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

        const rollResults = await rollPowerupFn({
          raceId,
          participantId: myP.id,
          userId,
          currentSteps: myStepEntry.totalSteps,
          nextBoxAtSteps: myP.nextBoxAtSteps,
          position,
          totalParticipants: sorted.length,
          powerupStepInterval: race.powerupStepInterval,
          displayName: myP.user.displayName,
          powerupSlots: myP.powerupSlots,
        });

        const newBoxes = rollResults.filter((r) => r.mysteryBox);

        powerupData = {
          enabled: true,
          newMysteryBoxes: newBoxes.map((r) => r.mysteryBox),
        };
      }

      // Always include inventory and active effects
      if (!powerupData) {
        powerupData = { enabled: true, newMysteryBoxes: [] };
      }

      const allMysteryBoxes = await racePowerupModel.findMysteryBoxesByParticipant(myParticipant.id);
      powerupData.mysteryBoxCount = allMysteryBoxes.length;
      powerupData.mysteryBoxIds = allMysteryBoxes.map((p) => p.id);

      powerupData.powerupSlots = myParticipant.powerupSlots || 3;

      const inventory = await racePowerupModel.findHeldByParticipant(myParticipant.id);
      powerupData.inventory = inventory.map((p) => ({
        id: p.id,
        type: p.type,
        rarity: p.rarity,
      }));

      const myActiveEffects = await raceActiveEffectModel.findActiveForParticipant(myParticipant.id);
      const raceActiveEffects = await raceActiveEffectModel.findActiveForRace(raceId);

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
      const activeEffects = await raceActiveEffectModel.findActiveForRace(raceId);
      for (const e of activeEffects) {
        if (e.type === "STEALTH_MODE") {
          stealthedUserIds.add(e.targetUserId);
        }
      }
    }

    const leaderboard = stepTotals
      .map(({ participant, totalSteps }) => {
        const isStealthed = stealthedUserIds.has(participant.userId)
          && participant.userId !== userId
          && !participant.finishedAt;
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
        // Stealthed users always appear at the top
        if (a.stealthed && !b.stealthed) return -1;
        if (!a.stealthed && b.stealthed) return 1;
        const aSteps = a.totalSteps ?? 0;
        const bSteps = b.totalSteps ?? 0;
        return bSteps - aSteps;
      });

    const updatedRace = await raceModel.findById(raceId);

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
  };
}

const getRaceProgress = buildGetRaceProgress();

module.exports = { getRaceProgress, buildGetRaceProgress, computeEffectModifiers };
