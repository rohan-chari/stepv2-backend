const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createEventSurgeTelemetry,
} = require("../../src/shared/observability/eventSurgeTelemetry");

test("event_surge_v1 emits bounded per-minute aggregates and mirrors them best-effort", async () => {
  let current = Date.parse("2098-08-26T10:01:00.000Z");
  const logs = [];
  const writes = [];
  const telemetry = createEventSurgeTelemetry({
    role: "http",
    instance: "0",
    nowMs: () => current,
    logger: { log(line) { logs.push(JSON.parse(line)); } },
    redisCache: { async setJSON(key, value, ttl) { writes.push({ key, value, ttl }); return true; } },
    getDbPoolPressure: () => ({ max: 10, total: 10, idle: 7, waiting: 0 }),
  });
  telemetry.recordHttpRequest({ endpointClass: "interactive", path: "/auth/me", status: 200, durationMs: 20 });
  telemetry.recordHttpRequest({ endpointClass: "step-intake", path: "/steps", status: 500, durationMs: 250 });
  telemetry.recordStepAdmission({ outcome: "admitted", waitMs: 8, active: 3, queued: 4 });
  telemetry.recordStepAdmission({ outcome: "rejected", waitMs: 250, active: 3, queued: 32 });
  telemetry.recordNotification({ eventId: "event-1", eligible: 5170, materialized: 100, expired: 2, canceled: 3, lagMs: 600 });
  telemetry.recordResolutionLag({ oldestAgeMs: 9000 });
  telemetry.recordHomePhase({ phase: "core", durationMs: 40 });
  telemetry.recordHomePhase({ phase: "core", durationMs: 120 });
  telemetry.recordHomePhase({ phase: "auxiliary", durationMs: 75 });

  const snapshot = await telemetry.flush(current);
  assert.equal(snapshot.schema, "event_surge_v1");
  assert.equal(snapshot.role, "http");
  assert.equal(snapshot.http.interactive.requests, 1);
  assert.equal(snapshot.http.stepIntake.server5xx, 1);
  assert.deepEqual(snapshot.stepAdmission, {
    admitted: 1, rejected: 1, succeeded: 0, failed: 0,
    activeMax: 3, queuedMax: 32, waitMs: { p50: 8, p95: 250, p99: 250 },
  });
  assert.equal(snapshot.notification.eligible, 5170);
  assert.equal(snapshot.notification.canceled, 3);
  assert.equal(snapshot.resolution.oldestAgeMs, 9000);
  assert.deepEqual(snapshot.home.phases.core, {
    requests: 2, latencyMs: { p50: 40, p95: 120, p99: 120 },
  });
  assert.deepEqual(snapshot.home.phases.auxiliary, {
    requests: 1, latencyMs: { p50: 75, p95: 75, p99: 75 },
  });
  assert.deepEqual(snapshot.pool, { max: 10, total: 10, idle: 7, waiting: 0 });
  assert.equal(logs.length, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].ttl, 150);

  current += 60_000;
  const next = await telemetry.flush(current);
  assert.equal(next.http.interactive.requests, 0, "minute counters reset after flush");
});

test("event surge telemetry never fails a request when Redis fails", async () => {
  const logs = [];
  const telemetry = createEventSurgeTelemetry({
    role: "cron",
    instance: "0",
    logger: { log(line) { logs.push(line); } },
    redisCache: { async setJSON() { throw new Error("redis down"); } },
  });
  await assert.doesNotReject(telemetry.flush());
  assert.equal(logs.length, 1);
});
