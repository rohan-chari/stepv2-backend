const { prorateSamplesIntoWindow } = require("../../steps/models/stepSample");
const { SETTLEMENT_EFFECT_TYPES } = require("./raceScoringEffectTypes");

const DAY_MS = 24 * 60 * 60 * 1000;
const PREFETCH_EFFECT_TYPES = [...SETTLEMENT_EFFECT_TYPES, "HITCHHIKE"];

function inCoveredRange(start, end, rangeStartMs, rangeEndMs) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  return startMs >= rangeStartMs && endMs <= rangeEndMs;
}

// Fetch the race-wide scoring inputs once, then expose the same model methods
// the canonical scoring helpers already use. This changes query round-trips,
// not scoring math: every sum still runs through prorateSamplesIntoWindow and
// every out-of-range request falls back to the real model.
async function prefetchRaceScoringModels({
  races,
  now,
  stepsModel,
  stepSampleModel,
  raceActiveEffectModel,
  scoringParticipantIds = null,
}) {
  const started = (races || []).filter((race) => race?.startedAt);
  if (started.length === 0) return null;
  if (
    typeof stepSampleModel?.findRowsForUsersInRange !== "function" ||
    typeof stepsModel?.findByUserIdsAndDateRange !== "function" ||
    typeof raceActiveEffectModel?.findEffectsForRaceParticipantsByTypes !==
      "function"
  ) {
    return null;
  }

  const currentTime = new Date(now);
  const earliestStartMs = Math.min(
    ...started.map((race) => new Date(race.startedAt).getTime())
  );
  const sampleRangeStart = new Date(earliestStartMs);
  const sampleRangeEnd = new Date(currentTime.getTime() + 7 * DAY_MS);
  const dailyRangeStart = new Date(earliestStartMs - 3 * DAY_MS);
  const dailyRangeEnd = new Date(currentTime.getTime() + 3 * DAY_MS);
  const scoringIds = Array.isArray(scoringParticipantIds)
    ? new Set(scoringParticipantIds)
    : null;
  const scoringParticipants = started.flatMap((race) =>
    (race.participants || []).filter((participant) =>
      !scoringIds || scoringIds.has(participant.id)
    )
  );
  if (scoringIds && scoringParticipants.length !== scoringIds.size) return null;
  const userIds = [
    ...new Set(
      scoringParticipants.map((participant) => participant.userId)
    ),
  ];
  const powerupRaces = started.filter((race) => race.powerupsEnabled);
  const participantIds = powerupRaces.flatMap((race) =>
    (race.participants || [])
      .filter((participant) => !scoringIds || scoringIds.has(participant.id))
      .map((participant) => participant.id)
  );
  const raceIds = powerupRaces.map((race) => race.id);

  const [sampleRows, dailyRows, effectsByParticipant] = await Promise.all([
    stepSampleModel.findRowsForUsersInRange(
      userIds,
      sampleRangeStart,
      sampleRangeEnd
    ),
    stepsModel.findByUserIdsAndDateRange(
      userIds,
      dailyRangeStart,
      dailyRangeEnd
    ),
    participantIds.length > 0
      ? raceActiveEffectModel.findEffectsForRaceParticipantsByTypes(
          raceIds,
          participantIds,
          PREFETCH_EFFECT_TYPES
        )
      : Promise.resolve({}),
  ]);

  const samplesByUser = new Map();
  for (const row of sampleRows || []) {
    const list = samplesByUser.get(row.userId) || [];
    list.push(row);
    samplesByUser.set(row.userId, list);
  }
  const dailyByUser = new Map();
  for (const row of dailyRows || []) {
    const list = dailyByUser.get(row.userId) || [];
    list.push(row);
    dailyByUser.set(row.userId, list);
  }

  const sampleStartMs = sampleRangeStart.getTime();
  const sampleEndMs = sampleRangeEnd.getTime();
  const dailyStartMs = dailyRangeStart.getTime();
  const dailyEndMs = dailyRangeEnd.getTime();
  const prefetchedTypes = new Set(PREFETCH_EFFECT_TYPES);

  const scopedStepSamples = {
    ...stepSampleModel,
    async sumStepsInWindows(userId, windows) {
      if (!windows || windows.length === 0) return [];
      if (
        !windows.every((window) =>
          inCoveredRange(
            window.start,
            window.end,
            sampleStartMs,
            sampleEndMs
          )
        )
      ) {
        return stepSampleModel.sumStepsInWindows(userId, windows);
      }
      const rows = samplesByUser.get(userId) || [];
      return windows.map((window) =>
        prorateSamplesIntoWindow(
          rows,
          new Date(window.start).getTime(),
          new Date(window.end).getTime()
        )
      );
    },
    async sumStepsInWindow(userId, start, end) {
      const [sum] = await this.sumStepsInWindows(userId, [{ start, end }]);
      return sum || 0;
    },
    async sumClosedStepsInWindows(userId, windows, closedAt) {
      if (!windows || windows.length === 0) return [];
      if (
        !windows.every((window) =>
          inCoveredRange(
            window.start,
            window.end,
            sampleStartMs,
            sampleEndMs
          )
        )
      ) {
        return stepSampleModel.sumClosedStepsInWindows(
          userId,
          windows,
          closedAt
        );
      }
      const closedAtMs = new Date(closedAt).getTime();
      const rows = (samplesByUser.get(userId) || []).filter(
        (row) => new Date(row.end).getTime() <= closedAtMs
      );
      return windows.map((window) =>
        prorateSamplesIntoWindow(
          rows,
          new Date(window.start).getTime(),
          new Date(window.end).getTime()
        )
      );
    },
    async sumClosedStepsInWindow(userId, start, end, closedAt) {
      const [sum] = await this.sumClosedStepsInWindows(
        userId,
        [{ start, end }],
        closedAt
      );
      return sum || 0;
    },
    async hasAnyInWindow(userId, start, end) {
      if (!inCoveredRange(start, end, sampleStartMs, sampleEndMs)) {
        return stepSampleModel.hasAnyInWindow(userId, start, end);
      }
      const startMs = new Date(start).getTime();
      const endMs = new Date(end).getTime();
      return (samplesByUser.get(userId) || []).some(
        (row) =>
          new Date(row.end).getTime() > startMs &&
          new Date(row.start).getTime() < endMs
      );
    },
  };

  const scopedSteps = {
    ...stepsModel,
    async findByUserIdAndDate(userId, date) {
      const dateMs = new Date(date).getTime();
      if (dateMs < dailyStartMs || dateMs > dailyEndMs) {
        return stepsModel.findByUserIdAndDate(userId, date);
      }
      return (
        (dailyByUser.get(userId) || []).find(
          (row) => new Date(row.date).getTime() === dateMs
        ) || null
      );
    },
    async findByUserIdAndDateRange(userId, start, end) {
      const startMs = new Date(start).getTime();
      const endMs = new Date(end).getTime();
      if (startMs < dailyStartMs || endMs > dailyEndMs) {
        return stepsModel.findByUserIdAndDateRange(userId, start, end);
      }
      return (dailyByUser.get(userId) || []).filter((row) => {
        const dateMs = new Date(row.date).getTime();
        return dateMs >= startMs && dateMs <= endMs;
      });
    },
  };

  const allEffects = Object.values(effectsByParticipant || {}).flatMap(
    (byType) => Object.values(byType || {}).flat()
  );
  const scopedEffects = {
    ...raceActiveEffectModel,
    async findEffectsForRaceByTypes(raceId, participantId, types) {
      if (!types.every((type) => prefetchedTypes.has(type))) {
        return raceActiveEffectModel.findEffectsForRaceByTypes(
          raceId,
          participantId,
          types
        );
      }
      const source = effectsByParticipant?.[participantId] || {};
      return Object.fromEntries(
        types.map((type) => [type, source[type] || []])
      );
    },
    async findEffectsForRaceByType(raceId, participantId, type) {
      if (!prefetchedTypes.has(type)) {
        return raceActiveEffectModel.findEffectsForRaceByType(
          raceId,
          participantId,
          type
        );
      }
      return effectsByParticipant?.[participantId]?.[type] || [];
    },
    async findRaceEffectsByType(raceId, type) {
      if (!prefetchedTypes.has(type)) {
        return raceActiveEffectModel.findRaceEffectsByType(raceId, type);
      }
      return allEffects.filter(
        (effect) => effect.raceId === raceId && effect.type === type
      );
    },
  };

  return {
    stepsModel: scopedSteps,
    stepSampleModel: scopedStepSamples,
    raceActiveEffectModel: scopedEffects,
  };
}

module.exports = {
  PREFETCH_EFFECT_TYPES,
  prefetchRaceScoringModels,
};
