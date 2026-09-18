const assert = require("node:assert/strict");
const test = require("node:test");

const { PROFILES, validateProfileRegistry } = require("../../../src/modules/loadTesting/contract");
const {
  eventOpenSessionEntries,
  payloadFor,
  runEventOpenSession,
  runPacedBackgroundProducer,
  assertEventOpenSurgeGates,
  assertAcceptedStepSourcePersistence,
} = require("../../../src/modules/loadTesting/runner");

test("event-open surge models the complete app-open fan-out and the frozen-client mix", () => {
  assert.equal(validateProfileRegistry(), true);
  const profile = PROFILES["event-open-surge"];
  assert.ok(profile);
  assert.deepEqual(profile.surgeGate, {
    incidentEligibleCohort: 517,
    sustainedSessionsPerSecond: 100,
    sustainedSeconds: 300,
    shockSessionsPerSecond: 200,
    shockSeconds: 60,
    scaleMultiplier: 10,
    requiredHeadroom: 0.4,
    poolBudget: { http0: 10, http1: 10, resolution: 8, cron: 4, total: 32 },
  });
  assert.deepEqual(profile.eventOpenFixture, {
    fixtureUsers: 10_000,
    warmupSeconds: 120,
    timezone: "America/New_York",
    activatesBoundary: true,
    deterministicProvider: true,
  });
  assert.equal(profile.defaults.users, 10_000);
  const endpoints = profile.entries.map((row) => `${row.method} ${row.path}`);
  for (const expected of [
    "GET /auth/me",
    "POST /notifications/device-token",
    "POST /analytics/activation-events",
    "POST /steps",
    "POST /steps/samples",
    "POST /steps/sync-v2",
    "GET /home/race-card",
    "GET /races/discovery-summary",
    "GET /races",
    "GET /inbox/alerts",
    "GET /races/:raceId/progress",
    "GET /races/:raceId/bootstrap",
  ]) assert.ok(endpoints.includes(expected), expected);
  assert.ok(profile.entries.some((row) => row.persona === "legacy"));
  assert.ok(profile.entries.some((row) => row.persona === "current"));
});

test("accepted source persistence compares final canonical rows and sync receipts", async () => {
  const completedAtMs = Date.now();
  const result = await assertAcceptedStepSourcePersistence({
    prisma: {
      step: { findMany: async () => [{ userId: "u1", date: new Date("2026-08-30"), steps: 123 }] },
      stepSample: { findMany: async () => [{
        userId: "u1", periodStart: new Date("2026-08-30T10:00:00.000Z"),
        periodEnd: new Date("2026-08-30T10:10:00.000Z"), steps: 99, sourceId: "source",
      }] },
      stepSyncRequest: { findMany: async () => [{ userId: "u1", idempotencyKey: "key" }] },
    },
    samples: [{
      endpoint: "POST /steps/sync-v2", status: 202, completedAtMs,
      sourceExpectation: { userId: "u1", idempotencyKey: "key", payload: {
        date: "2026-08-30", steps: 123, samples: [{
          periodStart: "2026-08-30T10:00:00.000Z", periodEnd: "2026-08-30T10:10:00.000Z",
          steps: 99, sourceId: "source",
        }],
      } },
    }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.acceptedWrites, 1);
  assert.equal(result.persistedWrites, 1);
});

test("one offered event-open session executes the whole graph and exactly one observed step path", async () => {
  const entries = eventOpenSessionEntries(PROFILES["event-open-surge"], () => 0.5);
  assert.equal(entries.filter((entry) => entry.path.startsWith("/steps")).length, 1);
  assert.deepEqual(entries.map((entry) => `${entry.method} ${entry.path}`), [
    "GET /auth/me",
    "POST /notifications/device-token",
    "POST /analytics/activation-events",
    "POST /steps/sync-v2",
    "GET /home/race-card",
    "GET /races/discovery-summary",
    "GET /races",
    "GET /inbox/alerts",
    "GET /races/:raceId/progress",
    "GET /races/:raceId/bootstrap",
  ]);
  const calls = [];
  const result = await runEventOpenSession({
    profile: PROFILES["event-open-surge"], random: () => 0.5,
    context: {}, sequence: 7,
    requestOne: async ({ entry }) => {
      calls.push(entry.path);
      return { endpoint: `${entry.method} ${entry.path}`, status: entry.allowedStatuses[0], unexpectedStatus: false, timeout: false };
    },
  });
  assert.equal(result.successful, true);
  assert.equal(result.samples.length, 10);
  assert.equal(calls[0], "/auth/me", "auth completes before the remaining fan-out");
});

test("the session-rate producer counts unscheduled capacity as offered failed work", async () => {
  let current = 0;
  const result = await runPacedBackgroundProducer({
    rate: 2, durationSeconds: 1, startedAtMs: 0, maxInFlight: 0,
    clock: () => current,
    wait: async (milliseconds) => { current += milliseconds; },
    runOne: async () => true,
  });
  assert.equal(result.offered, 2);
  assert.equal(result.completedSuccessful, 0);
  assert.equal(result.failed, 2);
});

test("event-open activation payload is accepted by the existing activation contract", () => {
  const payload = payloadFor(
    PROFILES["event-open-surge"].entries.find((entry) => entry.path === "/analytics/activation-events"),
    { runId: "capacity-run", userIndex: 1 },
    9,
  );
  assert.equal(payload.events[0].name, "home_reached");
  assert.deepEqual(Object.keys(payload.events[0]).sort(), ["appVersion", "context", "id", "name", "platform", "timestamp"]);
});

test("event-open gate fails closed on dropped sessions and enforces class SLOs", () => {
  const endpoint = (p95, p99) => ({ requests: 100, status: { "5xx": 0, timeout: 0, unexpected: 0 }, latencyMs: { p50: 1, p95, p99 } });
  const result = {
    parameters: { arrivalRatePerSecond: 100, durationSeconds: 300 },
    sessions: { offered: 30_000, completedSuccessful: 30_000, failed: 0 },
    summary: { errorRate: 0 },
    queue: { drainCompleted: true, lagMs: { p95: 29_999 }, drainSeconds: 299 },
    infrastructure: { eventSurge: {
      processCeilingsOk: true, dbPoolWaitP99Ms: 49, poolExhaustions: 0,
      poolBudget: { http0: 10, http1: 10, resolution: 8, cron: 4, total: 32 },
    } },
    eventEvidence: {
      c0Queue: { directlyInspected: true, drained: true, failedRows: 0, oldestAgeMs: 0, p95LagMs: 29_999, drainSeconds: 299 },
      notification: {
        expectedProviderAttempts: 12_000, firstAttempts: 12_000, accepted: 11_988, invalid: 12,
        lateFirstAttempts: 0, finalFirstAttemptLagMs: 119_990, pacingRatePerSecond: 100,
      },
      sourcePersistence: { acceptedWrites: 10_000, persistedWrites: 10_000, ok: true },
      duplicateScoring: {
        ok: true, expectedGenerationDelta: 42_000,
        observedGenerationDelta: 42_000, generationAmplificationRatio: 1,
      },
      parity: { ok: true, checkedParticipants: 14_000 },
      headroom: { required: 0.4, sustainedTargetPerSecond: 100, provedPerSecond: 140 },
      fault: { scenario: "baseline", executed: true, recovered: true, artifact: "run.fault.json" },
    },
    endpoints: {
      "GET /auth/me": endpoint(499, 999),
      "GET /home/race-card": endpoint(499, 999),
      "GET /races/discovery-summary": endpoint(499, 999),
      "GET /races": endpoint(499, 999),
      "GET /inbox/alerts": endpoint(499, 999),
      "GET /races/:raceId/progress": endpoint(499, 999),
      "GET /races/:raceId/bootstrap": endpoint(499, 999),
      "POST /steps/sync-v2": endpoint(749, 1499),
      "POST /steps": endpoint(1999, 4999),
      "POST /steps/samples": endpoint(1999, 4999),
    },
  };
  assert.equal(assertEventOpenSurgeGates(result), true);
  assert.throws(() => assertEventOpenSurgeGates({
    ...result, sessions: { ...result.sessions, completedSuccessful: 29_999, failed: 1 },
  }), /dropped or failed session/);
  assert.throws(() => assertEventOpenSurgeGates({
    ...result, eventEvidence: { ...result.eventEvidence, notification: {
      ...result.eventEvidence.notification, lateFirstAttempts: 1,
    } },
  }), /notification pacing/);
  assert.throws(() => assertEventOpenSurgeGates({
    ...result, eventEvidence: { ...result.eventEvidence, headroom: {
      ...result.eventEvidence.headroom, provedPerSecond: 139,
    } },
  }), /40% headroom/);
});
