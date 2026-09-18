const assert = require("node:assert/strict");
const test = require("node:test");

const cacheKeys = require("../../src/shared/cache/cacheKeys");
const {
  SNAPSHOT_WRITE_LUA,
  STEP_HISTORY_WRITE_LUA,
  SNAPSHOT_SERIALIZED_CAP_BYTES,
  buildStepMinuteEmission,
} = require("../../src/shared/observability/telemetryRedisContract");

test("telemetry logical keys are exact and never contain identity data", () => {
  assert.equal(cacheKeys.databasePoolTelemetry("http", "0"), "v1:ops:db-pool:http:0");
  assert.equal(cacheKeys.databasePoolTelemetry("cron", "0"), "v1:ops:db-pool:cron:0");
  assert.equal(cacheKeys.stepIngestionHour(Date.parse("2026-08-29T19:05:00Z")), "v1:ops:step-ingestion-hour:2026-08-29T19");
  assert.equal(cacheKeys.stepIngestionHistoryStart(), "v1:ops:step-ingestion-history-start");
  assert.throws(() => cacheKeys.databasePoolTelemetry("worker", "7"));
});

test("snapshot Lua orders by boot then capture and renews accepted TTL", () => {
  assert.equal(SNAPSHOT_SERIALIZED_CAP_BYTES, 512 * 1024);
  assert.match(SNAPSHOT_WRITE_LUA, /bootStartedAtMs/);
  assert.match(SNAPSHOT_WRITE_LUA, /capturedAtMs/);
  assert.match(SNAPSHOT_WRITE_LUA, /setex/i);
  assert.match(SNAPSHOT_WRITE_LUA, /cjson\.decode/);
});

test("history payload is compact, invariant-checked, and contains no raw failures", () => {
  const emission = buildStepMinuteEmission({
    minuteStartedAtMs: Date.parse("2026-08-29T19:29:00Z"),
    role: "http",
    instance: "0",
    bootId: "opaque-boot",
    endpoints: {
      steps: { requests: 10, successes: 9, validation4xx: 1, auth4xx: 0, poolCheckoutTimeouts: 0, transactionErrors: 0, server5xx: 0 },
      samples: { requests: 0, successes: 0, validation4xx: 0, auth4xx: 0, poolCheckoutTimeouts: 0, transactionErrors: 0, server5xx: 0 },
      "sync-v2": { requests: 0, successes: 0, validation4xx: 0, auth4xx: 0, poolCheckoutTimeouts: 0, transactionErrors: 0, server5xx: 0 },
    },
  });
  assert.deepEqual(emission.endpoints.steps, [10, 9, 1, 0, 0, 0, 0]);
  assert.doesNotMatch(JSON.stringify(emission), /error|message|user|token|sql/i);
  assert.throws(() => buildStepMinuteEmission({ ...emission, endpoints: { ...emission.endpoints, steps: [10, 10, 1, 0, 0, 0, 0] } }));
  assert.match(STEP_HISTORY_WRITE_LUA, /duplicate/);
  assert.match(STEP_HISTORY_WRITE_LUA, /overflow/);
  assert.match(STEP_HISTORY_WRITE_LUA, /schema_error/);
});
