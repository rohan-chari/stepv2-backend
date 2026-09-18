const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PROFILE_NAMES,
  DEFAULT_GLOBAL_EVENT_SYNC_CONFIG,
  buildArrivalPlan,
  buildIdempotencyKey,
  buildSyncBody,
  normalizeGlobalEventSyncConfig,
} = require("../../../src/modules/loadTesting/globalEventSyncProfiles");

test("global-event sync profiles expose all production-shaped scenarios", () => {
  assert.deepEqual(PROFILE_NAMES, [
    "idle-baseline", "ordinary-sync", "eligible-nonoverlap", "eligible-overlap",
    "android-periodic", "android-synchronized", "android-jittered",
    "foreground-five-minute", "expedited-over-periodic", "mixed-production",
    "event-end-worst-case", "drain",
  ]);
  assert.equal(DEFAULT_GLOBAL_EVENT_SYNC_CONFIG.schema, "global-event-step-sync-config-v1");
  assert.equal(DEFAULT_GLOBAL_EVENT_SYNC_CONFIG.topology.httpWorkers, 2);
  const defaults = normalizeGlobalEventSyncConfig({});
  assert.equal(defaults.controlUsers, 10);
  assert.equal(defaults.eligibleSummaryCount, 90);
});

test("config validation rejects unsafe fixture sizes and normalizes durations", () => {
  const config = normalizeGlobalEventSyncConfig({
    profile: "eligible-overlap", users: 60, arrivalRate: 3, duration: "7s",
    participantsPerRace: 50, racesPerUser: 2, overlap: 0.75, samplesPerParticipant: 4,
    sampleHistoryMinutes: 60, powerupEventDensity: 0.2, eligibleSummaryCount: 1,
  });
  assert.equal(config.durationSeconds, 7);
  assert.equal(config.overlap, 0.75);
  assert.throws(() => normalizeGlobalEventSyncConfig({ participantsPerRace: 10001 }), /budget/i);
  assert.throws(() => normalizeGlobalEventSyncConfig({ users: 20, eligibleSummaryCount: 5, overlap: 1.2 }), /overlap/i);
  assert.equal(normalizeGlobalEventSyncConfig({ capacityMetricsEnabled: "false" }).capacityMetricsEnabled, false);
  assert.equal(normalizeGlobalEventSyncConfig({ capacityMetricsEnabled: "1" }).capacityMetricsEnabled, true);
  assert.throws(() => normalizeGlobalEventSyncConfig({ capacityMetricsEnabled: "yes" }), /boolean/i);
  assert.throws(() => normalizeGlobalEventSyncConfig({ externalDelivery: "enabled" }), /disabled/i);
});

test("synchronized and jittered arrival plans preserve exact volume", () => {
  const synchronized = buildArrivalPlan({ rate: 5, durationSeconds: 10, mode: "synchronized", seed: "a" });
  const jittered = buildArrivalPlan({ rate: 5, durationSeconds: 10, mode: "jittered", jitterMs: 200, seed: "a" });
  assert.equal(synchronized.length, 50);
  assert.equal(jittered.length, 50);
  assert.deepEqual(synchronized.map((item) => item.second), jittered.map((item) => item.second));
  assert.notDeepEqual(synchronized.map((item) => item.atMs), jittered.map((item) => item.atMs));
  assert.equal(synchronized.filter((item) => item.second === 3).length, 5);
});

test("idempotency keys and sync payloads are deterministic and bounded", () => {
  const key = buildIdempotencyKey({ runId: "sync-run-1", repeat: 2, userId: "u-1", iteration: 4 });
  assert.match(key, /^[0-9a-f-]{36}$/);
  assert.equal(key, buildIdempotencyKey({ runId: "sync-run-1", repeat: 2, userId: "u-1", iteration: 4 }));
  const body = buildSyncBody({ date: "2026-09-04", steps: 1200, sampleCount: 4, seed: "x" });
  assert.equal(body.samples.length, 4);
  assert.ok(body.samples.every((sample) => sample.periodEnd > sample.periodStart));
  assert.throws(() => buildSyncBody({ sampleCount: 101 }), /samples/i);
});
