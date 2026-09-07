const {
  coordinatedOptimizationMetrics: metrics,
} = require("../../../shared/observability/coordinatedOptimizationMetrics");
let lastTraceAt = 0;
function observeExpiryStage(
  kind,
  milliseconds,
  { raceId = null, generation = null, effects = [] } = {},
) {
  const value = Math.max(0, Number(milliseconds) || 0);
  metrics.observe("race_effect_expiry_stage_seconds", value / 1000, { kind });
  // One bounded sampled trace per second per process; IDs are join fields in
  // logs, never metric labels. No user identity, steps or device data.
  const now = Date.now();
  if (now - lastTraceAt < 1000) return;
  lastTraceAt = now;
  console.info("[EFFECT_EXPIRY]", {
    kind,
    at: new Date(now).toISOString(),
    durationMs: value,
    raceId,
    generation,
    effects: effects
      .slice(0, 4)
      .map((e) => ({
        effectId: e.effect_id,
        revision: e.revision,
        deadlineAt: e.deadline_at,
      })),
  });
}
module.exports = { observeExpiryStage };
