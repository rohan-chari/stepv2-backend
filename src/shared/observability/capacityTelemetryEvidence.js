const {
  EVENT,
  QUERY_CAPTURE_ENABLED_SETTING,
  isValidCapacityRepeat,
  isValidCapacityRunId,
} = require("./capacityPhaseMetrics");

const SCHEMA = "capacity-telemetry-server-evidence-v1";

function metricFields(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  if (entry.event === EVENT) return entry;
  if (entry.fields?.event === EVENT) return entry.fields;
  return null;
}

function extractCapacityTelemetryEvidence(entries, { runId, repeat } = {}) {
  if (!isValidCapacityRunId(runId)) throw new Error("invalid capacity runId");
  if (!isValidCapacityRepeat(repeat)) throw new Error("invalid capacity repeat");

  const selected = (entries || [])
    .map(metricFields)
    .filter(Boolean)
    .filter((entry) =>
      entry.dimensions?.runId === runId && entry.dimensions?.repeat === repeat
    );
  if (selected.length === 0) {
    throw new Error(`no capacity telemetry samples for runId=${runId} repeat=${repeat}`);
  }

  for (const entry of selected) {
    if (entry.queryCaptureAvailable !== true) {
      throw new Error("query capture unavailable in capacity telemetry cohort");
    }
    if (entry.measurementGateEligible !== true) {
      throw new Error("measurement gate ineligible in capacity telemetry cohort");
    }
    if (entry.queryCaptureSetting !== QUERY_CAPTURE_ENABLED_SETTING) {
      throw new Error("query capture setting mismatch in capacity telemetry cohort");
    }
  }

  const surfaces = [...new Set(
    selected
      .map((entry) => entry.surface)
      .filter((surface) => typeof surface === "string" && surface.length > 0),
  )].sort();

  return {
    schema: SCHEMA,
    runId,
    repeat,
    event: EVENT,
    sampleCount: selected.length,
    queryCaptureAvailable: true,
    measurementGateEligible: true,
    queryCaptureSetting: QUERY_CAPTURE_ENABLED_SETTING,
    surfaces,
  };
}

module.exports = {
  SCHEMA,
  extractCapacityTelemetryEvidence,
  metricFields,
};
