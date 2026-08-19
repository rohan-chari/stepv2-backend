const { prorateSamplesIntoWindow } = require("../../steps/models/stepSample");
const {
  getTimeZoneParts,
  formatDateString,
} = require("../../../shared/time/week");
const { raceTimeZone } = require("../raceTimeZone");

function localDateKey(instant, timeZone) {
  const parts = getTimeZoneParts(instant, timeZone);
  return formatDateString(parts.year, parts.month, parts.day);
}

function dailyKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function normalizeSample(row) {
  return {
    start: new Date(row.periodStart ?? row.start),
    end: new Date(row.periodEnd ?? row.end),
    steps: row.steps || 0,
  };
}

function buildSampleAdapter(rows) {
  const samples = (rows || []).map(normalizeSample);
  const sum = (start, end) =>
    prorateSamplesIntoWindow(
      samples,
      new Date(start).getTime(),
      new Date(end).getTime()
    );
  return {
    async sumStepsInWindow(_userId, start, end) {
      return sum(start, end);
    },
    async sumStepsInWindows(_userId, windows) {
      return (windows || []).map((window) => sum(window.start, window.end));
    },
    async hasAnyInWindow(_userId, start, end) {
      const startMs = new Date(start).getTime();
      const endMs = new Date(end).getTime();
      return samples.some(
        (sample) => sample.end.getTime() > startMs && sample.start.getTime() < endMs
      );
    },
  };
}

function buildStepsAdapter(rows) {
  const byDate = new Map((rows || []).map((row) => [dailyKey(row.date), row]));
  return {
    async findByUserIdAndDate(_userId, date) {
      return byDate.get(dailyKey(date)) || null;
    },
    async findByUserIdAndDateRange(_userId, start, end) {
      const first = dailyKey(start);
      const last = dailyKey(end);
      return [...byDate.entries()]
        .filter(([key]) => key >= first && key <= last)
        .map(([, row]) => row)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
    },
  };
}

async function prefetchUploaderScoringInputs({
  userId,
  races,
  requestTimeZone,
  asOf,
  Steps,
  StepSample,
  GlobalStepEvent,
}) {
  const candidates = (races || []).filter(
    (race) => race?.status === "ACTIVE" && race.startedAt
  );
  if (candidates.length === 0) {
    return {
      asOf,
      stepsModel: buildStepsAdapter([]),
      stepSampleModel: buildSampleAdapter([]),
      globalEventsForRace: () => [],
    };
  }

  let earliestSample = new Date(asOf);
  let earliestEvent = new Date(asOf);
  const localDates = [];
  for (const race of candidates) {
    const participant = race.participants.find(
      (row) => row.userId === userId && row.status === "ACCEPTED"
    );
    if (!participant) continue;
    const effectiveStart = new Date(
      participant.joinedAt && new Date(participant.joinedAt) > new Date(race.startedAt)
        ? participant.joinedAt
        : race.startedAt
    );
    if (effectiveStart < earliestSample) earliestSample = effectiveStart;
    const raceStart = new Date(race.startedAt);
    if (raceStart < earliestEvent) earliestEvent = raceStart;
    const zones = new Set([
      raceTimeZone(race, requestTimeZone),
      raceTimeZone(race, "UTC"),
    ]);
    for (const zone of zones) {
      localDates.push(localDateKey(effectiveStart, zone));
      localDates.push(localDateKey(asOf, zone));
    }
  }
  const firstDate = localDates.sort()[0];
  const lastDate = localDates[localDates.length - 1];
  const [dailyRows, sampleRows, globalEvents] = await Promise.all([
    firstDate
      ? Steps.findByUserIdAndDateRange(userId, firstDate, lastDate)
      : Promise.resolve([]),
    StepSample.findByUserIdAndTimeRange(userId, earliestSample, asOf),
    GlobalStepEvent.findActiveInRange(earliestEvent, asOf).catch(() => []),
  ]);
  return {
    asOf,
    stepsModel: buildStepsAdapter(dailyRows),
    stepSampleModel: buildSampleAdapter(sampleRows),
    globalEventsForRace(race) {
      const start = new Date(race.startedAt).getTime();
      const end = new Date(asOf).getTime();
      return (globalEvents || []).filter(
        (event) =>
          new Date(event.startsAt).getTime() < end &&
          new Date(event.endsAt).getTime() > start
      );
    },
  };
}

module.exports = { prefetchUploaderScoringInputs };
