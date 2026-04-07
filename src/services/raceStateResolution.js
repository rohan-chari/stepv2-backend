const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { Steps } = require("../models/steps");
const { StepSample } = require("../models/stepSample");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { completeRace } = require("../commands/completeRace");
const { computeEffectModifiers } = require("../queries/getRaceProgress");
const {
  getTimeZoneParts,
  formatDateString,
  addDaysToDateString,
  parseDateString,
  zonedDateTimeToUtc,
} = require("../utils/week");

function getEffectiveStart(participant, raceStartedAt) {
  const joinedAt = participant.joinedAt || raceStartedAt;
  return joinedAt > raceStartedAt ? joinedAt : raceStartedAt;
}

async function calculateBaseAdjusted({
  participant,
  raceStartedAt,
  timeZone,
  stepsModel,
  stepSampleModel,
  now,
}) {
  const effectiveStart = getEffectiveStart(participant, raceStartedAt);
  const startParts = getTimeZoneParts(effectiveStart, timeZone);
  const startDate = formatDateString(
    startParts.year,
    startParts.month,
    startParts.day
  );
  const nowParts = getTimeZoneParts(now, timeZone);
  const today = formatDateString(nowParts.year, nowParts.month, nowParts.day);
  const dayAfterStartDate = addDaysToDateString(startDate, 1);
  const dayAfterParsed = parseDateString(dayAfterStartDate);
  const startDayWindowEnd = zonedDateTimeToUtc(
    {
      year: dayAfterParsed.year,
      month: dayAfterParsed.month,
      day: dayAfterParsed.day,
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone
  );

  let startDaySteps = 0;
  const startDaySamples = await stepSampleModel.sumStepsInWindow(
    participant.userId,
    effectiveStart,
    startDayWindowEnd
  );

  if (startDaySamples > 0) {
    startDaySteps = startDaySamples;
  } else if (participant.baselineSteps > 0) {
    const startDayRecord = await stepsModel.findByUserIdAndDate(
      participant.userId,
      startDate
    );
    startDaySteps = Math.max(
      0,
      (startDayRecord?.steps || 0) - participant.baselineSteps
    );
  }

  let subsequentSteps = 0;
  if (dayAfterStartDate <= today) {
    const subsequentSamples = await stepSampleModel.sumStepsInWindow(
      participant.userId,
      startDayWindowEnd,
      now
    );
    if (subsequentSamples > 0) {
      subsequentSteps = subsequentSamples;
    } else {
      const laterSteps = await stepsModel.findByUserIdAndDateRange(
        participant.userId,
        dayAfterStartDate,
        today
      );
      subsequentSteps = laterSteps.reduce((sum, s) => sum + s.steps, 0);
    }
  }

  return {
    baseAdjusted: Math.max(0, startDaySteps + subsequentSteps),
    hasSampleData: startDaySamples > 0,
    effectiveStart,
  };
}

async function calculateCurrentTotal({
  raceId,
  racePowerupsEnabled,
  participant,
  baseAdjusted,
  hasSampleData,
  raceActiveEffectModel,
  stepSampleModel,
}) {
  let total = baseAdjusted;

  if (racePowerupsEnabled) {
    const legCramps = await raceActiveEffectModel.findEffectsForRaceByType(
      raceId,
      participant.id,
      "LEG_CRAMP"
    );
    const runnersHighs = await raceActiveEffectModel.findEffectsForRaceByType(
      raceId,
      participant.id,
      "RUNNERS_HIGH"
    );
    const wrongTurns = await raceActiveEffectModel.findEffectsForRaceByType(
      raceId,
      participant.id,
      "WRONG_TURN"
    );

    const allEffects = [...legCramps, ...runnersHighs, ...wrongTurns];
    const { frozenSteps, buffedSteps, reversedSteps } =
      await computeEffectModifiers(
        allEffects,
        baseAdjusted,
        participant.userId,
        stepSampleModel,
        hasSampleData
      );

    total = Math.max(
      0,
      baseAdjusted -
        frozenSteps +
        buffedSteps -
        2 * reversedSteps +
        (participant.bonusSteps || 0)
    );

    return { total, legCramps, runnersHighs, wrongTurns };
  }

  return {
    total,
    legCramps: [],
    runnersHighs: [],
    wrongTurns: [],
  };
}

function buildBonusTimeline(events, participantUserId, effectiveStart, now) {
  const startMs = effectiveStart.getTime();
  const endMs = now.getTime();
  const bonuses = [];

  for (const event of events) {
    const eventTime = new Date(event.createdAt);
    const eventMs = eventTime.getTime();
    if (eventMs < startMs || eventMs > endMs) continue;

    const metadata = event.metadata || {};
    let delta = 0;

    if (
      event.actorUserId === participantUserId &&
      ["PROTEIN_SHAKE", "SECOND_WIND", "TRAIL_MIX"].includes(event.powerupType) &&
      typeof metadata.bonus === "number"
    ) {
      delta += metadata.bonus;
    }

    if (event.powerupType === "SHORTCUT" && typeof metadata.stolen === "number") {
      if (event.actorUserId === participantUserId) {
        delta += metadata.stolen;
      }
      if (event.targetUserId === participantUserId) {
        delta -= metadata.stolen;
      }
    }

    if (event.powerupType === "RED_CARD" && typeof metadata.penalty === "number") {
      if (event.targetUserId === participantUserId) {
        delta -= metadata.penalty;
      }
    }

    if (delta !== 0) {
      bonuses.push({ time: eventTime, delta });
    }
  }

  bonuses.sort((a, b) => a.time - b.time);
  return bonuses;
}

function multiplierForTime(timeMs, { legCramps, runnersHighs, wrongTurns }) {
  const isActive = (effect) => {
    const startMs = new Date(effect.startsAt).getTime();
    const endMs = effect.expiresAt ? new Date(effect.expiresAt).getTime() : Infinity;
    return startMs <= timeMs && timeMs < endMs;
  };

  const frozen = legCramps.some(isActive);
  if (frozen) return 0;

  const buffed = runnersHighs.some(isActive);
  const reversed = wrongTurns.some(isActive);

  if (reversed && buffed) return -2;
  if (reversed) return -1;
  if (buffed) return 2;
  return 1;
}

async function determineFinishSnapshot({
  participant,
  currentTotal,
  targetSteps,
  effectiveStart,
  effectGroups,
  stepSampleModel,
  powerupEventModel,
  raceId,
  now,
}) {
  if (currentTotal < targetSteps) {
    return null;
  }

  const samples = await stepSampleModel.findByUserIdAndTimeRange(
    participant.userId,
    effectiveStart,
    now
  );
  const events = await powerupEventModel.findByRaceAsc(raceId);
  const bonusTimeline = buildBonusTimeline(
    events,
    participant.userId,
    effectiveStart,
    now
  );

  if (samples.length === 0 && bonusTimeline.length === 0) {
    return { finishedAt: now, finishTotalSteps: currentTotal };
  }

  const boundaries = new Set([
    effectiveStart.getTime(),
    now.getTime(),
    ...bonusTimeline.map((b) => b.time.getTime()),
  ]);

  for (const sample of samples) {
    const sampleStart = Math.max(
      effectiveStart.getTime(),
      new Date(sample.periodStart).getTime()
    );
    const sampleEnd = Math.min(now.getTime(), new Date(sample.periodEnd).getTime());
    if (sampleEnd > sampleStart) {
      boundaries.add(sampleStart);
      boundaries.add(sampleEnd);
    }
  }

  for (const effect of [
    ...effectGroups.legCramps,
    ...effectGroups.runnersHighs,
    ...effectGroups.wrongTurns,
  ]) {
    const startMs = Math.max(
      effectiveStart.getTime(),
      new Date(effect.startsAt).getTime()
    );
    const endMs = Math.min(
      now.getTime(),
      effect.expiresAt ? new Date(effect.expiresAt).getTime() : now.getTime()
    );
    if (endMs > startMs) {
      boundaries.add(startMs);
      boundaries.add(endMs);
    }
  }

  const ordered = [...boundaries].sort((a, b) => a - b);
  let score = 0;
  let bonusIndex = 0;

  for (let i = 0; i < ordered.length; i++) {
    const boundary = ordered[i];

    while (
      bonusIndex < bonusTimeline.length &&
      bonusTimeline[bonusIndex].time.getTime() === boundary
    ) {
      score += bonusTimeline[bonusIndex].delta;
      if (score >= targetSteps) {
        return {
          finishedAt: new Date(boundary),
          finishTotalSteps: score,
        };
      }
      bonusIndex += 1;
    }

    const nextBoundary = ordered[i + 1];
    if (!nextBoundary || nextBoundary <= boundary) continue;

    const segmentDuration = nextBoundary - boundary;
    let stepRate = 0;

    for (const sample of samples) {
      const sampleStart = new Date(sample.periodStart).getTime();
      const sampleEnd = new Date(sample.periodEnd).getTime();
      if (sampleStart <= boundary && sampleEnd >= nextBoundary) {
        const sampleDuration = sampleEnd - sampleStart;
        if (sampleDuration > 0) {
          stepRate += sample.steps / sampleDuration;
        }
      }
    }

    if (stepRate <= 0) continue;

    const multiplier = multiplierForTime(boundary, effectGroups);
    const scoreRate = stepRate * multiplier;

    if (scoreRate > 0 && score < targetSteps) {
      const segmentGain = scoreRate * segmentDuration;
      if (score + segmentGain >= targetSteps) {
        const msToFinish = ((targetSteps - score) / scoreRate);
        return {
          finishedAt: new Date(boundary + msToFinish),
          finishTotalSteps: targetSteps,
        };
      }
    }

    score += scoreRate * segmentDuration;
  }

  return { finishedAt: now, finishTotalSteps: currentTotal };
}

function buildResolveRaceState(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const stepsModel = dependencies.Steps || Steps;
  const stepSampleModel = dependencies.StepSample || StepSample;
  const raceActiveEffectModel =
    dependencies.RaceActiveEffect || RaceActiveEffect;
  const powerupEventModel =
    dependencies.RacePowerupEvent || RacePowerupEvent;
  const completeRaceFn = dependencies.completeRace || completeRace;
  const now = dependencies.now || (() => new Date());

  return async function resolveRaceState({
    raceId,
    userId,
    timeZone = "UTC",
  } = {}) {
    let races = [];

    if (raceId) {
      const race = await raceModel.findById(raceId);
      if (race) races = [race];
    } else if (userId) {
      races = await raceModel.findActiveForUser(userId);
    }

    const results = [];

    for (const race of races) {
      if (race.status !== "ACTIVE" || !race.startedAt) {
        continue;
      }

      const acceptedParticipants = race.participants.filter(
        (p) => p.status === "ACCEPTED"
      );
      const currentTime = now();
      const stepTotals = [];
      const newFinishers = [];
      let previouslyFinished = 0;

      for (const participant of acceptedParticipants) {
        if (participant.finishedAt) {
          previouslyFinished += 1;
          stepTotals.push({
            participant,
            totalSteps: participant.finishTotalSteps ?? participant.totalSteps,
          });
          continue;
        }

        const { baseAdjusted, hasSampleData, effectiveStart } =
          await calculateBaseAdjusted({
            participant,
            raceStartedAt: race.startedAt,
            timeZone,
            stepsModel,
            stepSampleModel,
            now: currentTime,
          });

        const { total, legCramps, runnersHighs, wrongTurns } =
          await calculateCurrentTotal({
            raceId: race.id,
            racePowerupsEnabled: race.powerupsEnabled,
            participant,
            baseAdjusted,
            hasSampleData,
            raceActiveEffectModel,
            stepSampleModel,
          });

        await participantModel.updateTotalSteps(participant.id, total);
        stepTotals.push({ participant, totalSteps: total });

        if (total >= race.targetSteps) {
          const snapshot = await determineFinishSnapshot({
            participant,
            currentTotal: total,
            targetSteps: race.targetSteps,
            effectiveStart,
            effectGroups: { legCramps, runnersHighs, wrongTurns },
            stepSampleModel,
            powerupEventModel,
            raceId: race.id,
            now: currentTime,
          });

          const finishTotalSteps =
            snapshot?.finishTotalSteps ?? total;
          const finishedAt = snapshot?.finishedAt ?? currentTime;

          await participantModel.markFinished(
            participant.id,
            finishedAt,
            finishTotalSteps
          );

          newFinishers.push({
            participant,
            totalSteps: finishTotalSteps,
            finishedAt,
          });
        }
      }

      newFinishers.sort((a, b) => {
        const timeDiff = a.finishedAt - b.finishedAt;
        if (timeDiff !== 0) return timeDiff;
        return b.totalSteps - a.totalSteps;
      });

      for (let i = 0; i < newFinishers.length; i++) {
        const placement = previouslyFinished + i + 1;
        await participantModel.setPlacement(newFinishers[i].participant.id, placement);
      }

      const totalFinished = previouslyFinished + newFinishers.length;
      const finishThreshold = acceptedParticipants.length <= 3 ? 1 : 3;

      if (
        newFinishers.length > 0 &&
        totalFinished >= finishThreshold &&
        previouslyFinished < finishThreshold
      ) {
        const priorWinner = acceptedParticipants.find((p) => p.placement === 1);
        const winnerUserId = priorWinner
          ? priorWinner.userId
          : newFinishers[0].participant.userId;

        await completeRaceFn({
          raceId: race.id,
          winnerUserId,
          participantUserIds: acceptedParticipants.map((p) => p.userId),
        });
      }

      results.push({
        raceId: race.id,
        updatedParticipants: stepTotals.length,
        newFinishers: newFinishers.length,
      });
    }

    return results;
  };
}

const resolveRaceState = buildResolveRaceState();

module.exports = {
  buildResolveRaceState,
  resolveRaceState,
};
