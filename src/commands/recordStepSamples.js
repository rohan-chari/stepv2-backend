const { StepSample } = require("../models/stepSample");
const {
  resolveRaceState: defaultResolveRaceState,
} = require("../services/raceStateResolution");
const {
  syncRacePowerupState: defaultSyncRacePowerupState,
} = require("../services/racePowerupStateSync");

class StepSampleError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "StepSampleError";
    if (statusCode) this.statusCode = statusCode;
  }
}

const VALID_RECORDING_METHODS = new Set([
  "unknown",
  "active",
  "automatic",
  "manual",
]);

// Remove overlapping samples: if sample A fully contains sample B,
// keep the shorter (more granular) one and discard the broader one.
function removeOverlaps(samples) {
  if (samples.length <= 1) return samples;

  const parsed = samples.map((s) => ({
    ...s,
    _start: new Date(s.periodStart).getTime(),
    _end: new Date(s.periodEnd).getTime(),
  }));

  return parsed
    .filter((sample) => {
      // Drop this sample if any other shorter sample is fully contained within it
      const containsShorter = parsed.some(
        (other) =>
          other !== sample &&
          other._start >= sample._start &&
          other._end <= sample._end &&
          (other._end - other._start) < (sample._end - sample._start)
      );
      return !containsShorter;
    })
    .map(({ _start, _end, ...rest }) => rest);
}

function buildRecordStepSamples(dependencies = {}) {
  const hasInjectedDeps = Object.keys(dependencies).length > 0;
  const stepSampleModel = dependencies.StepSample || StepSample;
  const resolveRaceState = Object.prototype.hasOwnProperty.call(
    dependencies,
    "resolveRaceState"
  )
    ? dependencies.resolveRaceState
    : hasInjectedDeps
      ? async () => {}
      : defaultResolveRaceState;
  const syncRacePowerupState = Object.prototype.hasOwnProperty.call(
    dependencies,
    "syncRacePowerupState"
  )
    ? dependencies.syncRacePowerupState
    : hasInjectedDeps
      ? async () => {}
      : defaultSyncRacePowerupState;

  return async function recordStepSamples({ userId, samples, timeZone }) {
    if (!Array.isArray(samples) || samples.length === 0) {
      throw new StepSampleError("samples must be a non-empty array", 400);
    }

    const normalizedSamples = samples.map((sample) => {
      const normalized = { ...sample };

      if (typeof normalized.recordingMethod === "string") {
        normalized.recordingMethod = normalized.recordingMethod.trim().toLowerCase();

        if (!VALID_RECORDING_METHODS.has(normalized.recordingMethod)) {
          throw new StepSampleError("recordingMethod must be one of unknown, active, automatic, or manual", 400);
        }

        if (normalized.recordingMethod === "manual") {
          throw new StepSampleError("manual step samples are not allowed", 400);
        }
      }

      return normalized;
    });

    for (const s of normalizedSamples) {
      if (!s.periodStart || !s.periodEnd || s.steps == null) {
        throw new StepSampleError("Each sample requires periodStart, periodEnd, and steps", 400);
      }
    }

    const cleaned = removeOverlaps(normalizedSamples);
    await stepSampleModel.upsertBatch(userId, cleaned);
    const raceResults = await resolveRaceState({ userId, timeZone });
    if (Array.isArray(raceResults)) {
      for (const result of raceResults) {
        await syncRacePowerupState({ raceId: result.raceId, userId });
      }
    }

    return { count: cleaned.length };
  };
}

const recordStepSamples = buildRecordStepSamples();

module.exports = { buildRecordStepSamples, recordStepSamples, StepSampleError };
