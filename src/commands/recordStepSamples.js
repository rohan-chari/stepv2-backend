const { StepSample } = require("../models/stepSample");

class StepSampleError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "StepSampleError";
    if (statusCode) this.statusCode = statusCode;
  }
}

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
  const stepSampleModel = dependencies.StepSample || StepSample;

  return async function recordStepSamples({ userId, samples }) {
    if (!Array.isArray(samples) || samples.length === 0) {
      throw new StepSampleError("samples must be a non-empty array", 400);
    }

    for (const s of samples) {
      if (!s.periodStart || !s.periodEnd || s.steps == null) {
        throw new StepSampleError("Each sample requires periodStart, periodEnd, and steps", 400);
      }
    }

    const cleaned = removeOverlaps(samples);
    await stepSampleModel.upsertBatch(userId, cleaned);

    return { count: cleaned.length };
  };
}

const recordStepSamples = buildRecordStepSamples();

module.exports = { buildRecordStepSamples, recordStepSamples, StepSampleError };
