const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createCoordinatedOptimizationMetrics,
} = require("../../src/shared/observability/coordinatedOptimizationMetrics");

test("coordinated optimization metrics expose aggregate-only counters and histograms", () => {
  const metrics = createCoordinatedOptimizationMetrics();
  metrics.increment("durable_queue_wake_received_total", { queue: "resolution" });
  metrics.increment("durable_queue_wake_received_total", { queue: "resolution" }, 2);
  metrics.observe("race_resolution_participants", 50);
  metrics.observe("race_resolution_batch_bytes", 1024, { kind: "samples" });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters["durable_queue_wake_received_total{queue=resolution}"], 3);
  assert.deepEqual(snapshot.histograms.race_resolution_participants, {
    count: 1, sum: 50, min: 50, max: 50,
  });
  assert.equal(snapshot.histograms["race_resolution_batch_bytes{kind=samples}"].sum, 1024);
  assert.doesNotMatch(JSON.stringify(snapshot), /userId|raceId|payload|token/i);
});

test("coordinated optimization metrics reject PII-like labels and unknown metric names", () => {
  const metrics = createCoordinatedOptimizationMetrics();
  assert.throws(
    () => metrics.increment("durable_queue_wake_received_total", { userId: "u1" }),
    /label/i,
  );
  assert.throws(() => metrics.increment("not_approved"), /metric/i);
});
