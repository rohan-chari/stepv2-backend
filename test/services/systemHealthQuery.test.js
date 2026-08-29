const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildGetSystemHealth,
  validateSnapshot,
  parseHistoryRedis,
} = require("../../src/modules/admin/queries/getSystemHealth");

function histogram(observations = 0, bucket = 0, maxMs = null) {
  const counts = Array(12).fill(0);
  for (let index = bucket; index < counts.length; index += 1) counts[index] = observations;
  return { observations, sumMs: observations * (maxMs || 0), maxMs, counts };
}

function stepAggregate(requests = 0, successes = requests) {
  const base = {
    requests,
    successes,
    failures: requests - successes,
    queuedTimeouts: 0,
    validation4xx: 0,
    auth4xx: 0,
    poolCheckoutTimeouts: 0,
    transactionErrors: 0,
    server5xx: requests - successes,
    requestDurationHistogram: histogram(requests, 3, requests ? 20 : null),
    authenticationDurationHistogram: histogram(requests, 2, requests ? 8 : null),
    checkoutWaitHistogram: histogram(requests, 0, requests ? 1 : null),
    transactionDurationHistogram: histogram(requests, 3, requests ? 20 : null),
  };
  return {
    ...base,
    endpoints: ["steps", "samples", "sync-v2"].map((endpoint, index) => ({
      endpoint,
      ...stepAggregateEndpoint(index === 0 ? requests : 0, index === 0 ? successes : 0),
    })),
    phases: [],
  };
}

function stepAggregateEndpoint(requests, successes) {
  return {
    requests,
    successes,
    failures: requests - successes,
    queuedTimeouts: 0,
    validation4xx: 0,
    auth4xx: 0,
    poolCheckoutTimeouts: 0,
    transactionErrors: 0,
    server5xx: requests - successes,
    requestDurationHistogram: histogram(requests, 3, requests ? 20 : null),
    authenticationDurationHistogram: histogram(requests, 2, requests ? 8 : null),
    checkoutWaitHistogram: histogram(requests, 0, requests ? 1 : null),
    transactionDurationHistogram: histogram(requests, 3, requests ? 20 : null),
  };
}

function snapshot(role, instance, nowMs, coverage = 60) {
  const buckets = Array.from({ length: coverage }, (_, offset) => ({
    minuteStartedAtMs: nowMs - (coverage - offset) * 60_000,
    minuteStartedAt: new Date(nowMs - (coverage - offset) * 60_000).toISOString(),
    interval: {
      acquisitions: 1, releases: 1, queuedCheckouts: 0, queuedTimeouts: 0,
      physicalAttempts: 0, physicalTimeouts: 0, physicalErrors: 0,
    },
    queuedWaitHistogram: histogram(),
    physicalConnectionDurationHistogram: histogram(),
    ...(role === "http" ? { stepIngestion: stepAggregate(1, 1) } : {}),
  }));
  return {
    schema: "database-pool-telemetry-snapshot-v1", role, instance,
    bootId: `boot-${role}-${instance}`,
    bootStartedAtMs: nowMs - 3_600_000,
    bootStartedAt: new Date(nowMs - 3_600_000).toISOString(),
    capturedAtMs: nowMs,
    capturedAt: new Date(nowMs).toISOString(),
    oldestBucketAt: buckets[0].minuteStartedAt,
    newestBucketAt: buckets.at(-1).minuteStartedAt,
    coverageMinutes: coverage,
    pool: { max: 20, total: 4, idle: 2, nonIdle: 2, checkedOut: 2, waiting: 0 },
    process: { rssBytes: 1000, cpuOneCorePercent: 2, eventLoopP99Ms: 1 },
    buckets,
  };
}

test("admin system health returns the exact ordered available envelope and merged p95", async () => {
  const nowMs = Date.parse("2026-08-29T19:30:00.000Z");
  const values = [snapshot("http", "0", nowMs), snapshot("http", "1", nowMs), snapshot("resolution", "0", nowMs), snapshot("cron", "0", nowMs)];
  const get = buildGetSystemHealth({
    now: () => new Date(nowMs),
    snapshotReader: async () => ({ ok: true, disabled: false, values }),
    historyReader: async () => ({ status: "available", collectionStartedMinuteMs: nowMs - 10_080 * 60_000, minutes: [] }),
  });
  const result = await get({ window: "60m" });
  assert.equal(result.schema, "admin-system-health-v1");
  assert.equal(result.status, "available");
  assert.equal(result.overall, "healthy");
  assert.equal(result.freshProcesses, 4);
  assert.deepEqual(result.processes.map(({ role, instance }) => `${role}:${instance}`), ["http:0", "http:1", "resolution:0", "cron:0"]);
  assert.equal(result.stepIngestion.requests, 120);
  assert.deepEqual(result.failureWindows.map((row) => row.window), ["60m", "24h", "7d"]);
});

test("missing, stale, malformed, and Redis-down snapshots fail open without invented rows", async () => {
  const nowMs = Date.parse("2026-08-29T19:30:00.000Z");
  const stale = snapshot("http", "0", nowMs);
  stale.capturedAtMs = nowMs - 151_000;
  stale.capturedAt = new Date(stale.capturedAtMs).toISOString();
  const malformed = snapshot("http", "1", nowMs);
  malformed.pool.idle = malformed.pool.total + 1;
  const get = buildGetSystemHealth({
    now: () => new Date(nowMs),
    snapshotReader: async () => ({ ok: true, disabled: false, values: [stale, malformed, null, null] }),
    historyReader: async () => ({ status: "unavailable", minutes: [] }),
  });
  const partial = await get({ window: "60m" });
  assert.equal(partial.status, "unavailable");
  assert.equal(partial.overall, "unknown");
  assert.equal(partial.freshProcesses, 0);
  assert.deepEqual(partial.processes, []);
  assert.equal(partial.stepIngestion, null);

  const down = buildGetSystemHealth({
    now: () => new Date(nowMs),
    snapshotReader: async () => ({ ok: false, disabled: false, values: [] }),
    historyReader: async () => ({ status: "unavailable", minutes: [] }),
  });
  assert.equal((await down({})).status, "unavailable");
});

test("unsupported window throws the locked ValidationError contract", async () => {
  const get = buildGetSystemHealth({ snapshotReader: async () => ({ ok: false, values: [] }) });
  await assert.rejects(get({ window: "24h" }), (error) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "INVALID_WINDOW");
    assert.equal(error.message, "Unsupported system-health window");
    return true;
  });
});

test("60m/24h/7d failure windows expose observed request and server numerators with honest collection", async () => {
  const nowMs = Date.parse("2026-08-29T19:30:00.000Z");
  const zero = [0, 0, 0, 0, 0, 0, 0];
  const minutes = Array.from({ length: 60 }, (_, offset) => {
    const minuteStartedAtMs = nowMs - (60 - offset) * 60_000;
    return {
      minuteStartedAtMs,
      workers: [
        {
          instance: "0", count: 1, overflow: false,
          emissions: [{ endpoints: { steps: [10, 8, 1, 0, 0, 1, 0], samples: zero, "sync-v2": zero } }],
        },
        {
          instance: "1", count: 1, overflow: false,
          emissions: [{ endpoints: { steps: [5, 5, 0, 0, 0, 0, 0], samples: zero, "sync-v2": zero } }],
        },
      ],
    };
  });
  const values = [snapshot("http", "0", nowMs), snapshot("http", "1", nowMs), snapshot("resolution", "0", nowMs), snapshot("cron", "0", nowMs)];
  const get = buildGetSystemHealth({
    now: () => new Date(nowMs),
    snapshotReader: async () => ({ ok: true, values }),
    historyReader: async () => ({
      status: "available",
      collectionStartedMinuteMs: nowMs - 60 * 60_000,
      minutes,
    }),
  });
  const result = await get({ window: "60m" });
  assert.equal(result.historyStatus, "available");
  const hour = result.failureWindows[0];
  assert.equal(hour.collectionStatus, "complete");
  assert.equal(hour.completeCoverageMinutes, 60);
  assert.equal(hour.partialCoverageMinutes, 0);
  assert.equal(hour.requests, 900);
  assert.equal(hour.successes, 780);
  assert.equal(hour.requestFailures, 120);
  assert.equal(hour.serverFailures, 60);
  assert.equal(result.failureWindows[1].collectionStatus, "collecting");
  assert.equal(result.failureWindows[1].completeCoverageMinutes, 60);
  assert.equal(result.failureWindows[2].completeCoverageMinutes, 60);
});

test("snapshot validation enforces required empty coverage coordinates and the exact 60-minute age bound", () => {
  const nowMs = Date.parse("2026-08-29T19:30:00.000Z");
  const empty = snapshot("cron", "0", nowMs, 1);
  empty.coverageMinutes = 0;
  empty.buckets = [];
  empty.oldestBucketAt = null;
  empty.newestBucketAt = null;
  assert.equal(validateSnapshot(empty, { role: "cron", instance: "0" }, nowMs).valid, true);
  delete empty.oldestBucketAt;
  assert.equal(validateSnapshot(empty, { role: "cron", instance: "0" }, nowMs).valid, false);

  const tooOld = snapshot("cron", "0", nowMs, 1);
  tooOld.buckets[0].minuteStartedAtMs = nowMs - 61 * 60_000;
  tooOld.buckets[0].minuteStartedAt = new Date(tooOld.buckets[0].minuteStartedAtMs).toISOString();
  tooOld.oldestBucketAt = tooOld.buckets[0].minuteStartedAt;
  tooOld.newestBucketAt = tooOld.buckets[0].minuteStartedAt;
  assert.equal(validateSnapshot(tooOld, { role: "cron", instance: "0" }, nowMs).valid, false);
});

test("snapshot bucket window is anchored to capture minute across timer jitter and strictly ordered", () => {
  const captureMinuteMs = Date.parse("2026-08-29T19:30:00.000Z");
  const delayedCaptureMs = captureMinuteMs + 37_123;
  const expected = { role: "cron", instance: "0" };

  const exact = snapshot("cron", "0", captureMinuteMs, 60);
  assert.equal(validateSnapshot(exact, expected, captureMinuteMs).valid, true);

  const delayed = snapshot("cron", "0", captureMinuteMs, 60);
  delayed.capturedAtMs = delayedCaptureMs;
  delayed.capturedAt = new Date(delayedCaptureMs).toISOString();
  assert.equal(delayed.buckets[0].minuteStartedAtMs, captureMinuteMs - 60 * 60_000);
  assert.equal(validateSnapshot(delayed, expected, delayedCaptureMs).valid, true);

  const older = structuredClone(delayed);
  older.buckets[0].minuteStartedAtMs -= 60_000;
  older.buckets[0].minuteStartedAt = new Date(older.buckets[0].minuteStartedAtMs).toISOString();
  older.oldestBucketAt = older.buckets[0].minuteStartedAt;
  assert.equal(validateSnapshot(older, expected, delayedCaptureMs).valid, false);

  const currentMinute = snapshot("cron", "0", captureMinuteMs, 1);
  currentMinute.capturedAtMs = delayedCaptureMs;
  currentMinute.capturedAt = new Date(delayedCaptureMs).toISOString();
  currentMinute.buckets[0].minuteStartedAtMs = captureMinuteMs;
  currentMinute.buckets[0].minuteStartedAt = new Date(captureMinuteMs).toISOString();
  currentMinute.oldestBucketAt = currentMinute.buckets[0].minuteStartedAt;
  currentMinute.newestBucketAt = currentMinute.buckets[0].minuteStartedAt;
  assert.equal(validateSnapshot(currentMinute, expected, delayedCaptureMs).valid, false);

  const unordered = snapshot("cron", "0", captureMinuteMs, 60);
  [unordered.buckets[0], unordered.buckets[1]] = [unordered.buckets[1], unordered.buckets[0]];
  assert.equal(validateSnapshot(unordered, expected, captureMinuteMs).valid, false);
});

test("snapshot validation rejects missing and inconsistent step outcome-stage counters", () => {
  const nowMs = Date.parse("2026-08-29T19:30:00.000Z");
  const expected = { role: "http", instance: "0" };

  const missing = snapshot("http", "0", nowMs, 1);
  delete missing.buckets[0].stepIngestion.server5xx;
  assert.equal(validateSnapshot(missing, expected, nowMs).valid, false);

  const stageMismatch = snapshot("http", "0", nowMs, 1);
  stageMismatch.buckets[0].stepIngestion.successes = 0;
  stageMismatch.buckets[0].stepIngestion.failures = 1;
  stageMismatch.buckets[0].stepIngestion.endpoints[0].successes = 0;
  stageMismatch.buckets[0].stepIngestion.endpoints[0].failures = 1;
  assert.equal(validateSnapshot(stageMismatch, expected, nowMs).valid, false);

  const checkoutMismatch = snapshot("http", "0", nowMs, 1);
  const checkoutParent = checkoutMismatch.buckets[0].stepIngestion;
  const checkoutEndpoint = checkoutParent.endpoints[0];
  for (const block of [checkoutParent, checkoutEndpoint]) {
    block.successes = 0;
    block.failures = 1;
    block.queuedTimeouts = 1;
    block.server5xx = 1;
  }
  assert.equal(validateSnapshot(checkoutMismatch, expected, nowMs).valid, false);

  const parentMismatch = snapshot("http", "0", nowMs, 1);
  const parent = parentMismatch.buckets[0].stepIngestion;
  const parentEndpoint = parent.endpoints[0];
  parent.successes = 0;
  parent.failures = 1;
  parent.transactionErrors = 1;
  parentEndpoint.successes = 0;
  parentEndpoint.failures = 1;
  parentEndpoint.server5xx = 1;
  assert.equal(validateSnapshot(parentMismatch, expected, nowMs).valid, false);
});

test("history parser rejects non-exact field coordinates and additive compact payload fields", () => {
  const minute = Date.parse("2026-08-29T19:29:00.000Z");
  const hourKey = "v1:ops:step-ingestion-hour:2026-08-29T19";
  const payload = {
    schema: "step-ingestion-minute-v1",
    minuteStartedAtMs: minute,
    role: "http",
    instance: "0",
    bootId: "boot-a",
    endpoints: {
      steps: [1, 1, 0, 0, 0, 0, 0],
      samples: [0, 0, 0, 0, 0, 0, 0],
      "sync-v2": [0, 0, 0, 0, 0, 0, 0],
    },
    unexpected: "not-compact",
  };
  const parsed = parseHistoryRedis({
    ok: true,
    start: { schema: "step-ingestion-history-start-v1", collectionStartedMinuteMs: minute },
    hours: [{
      schema: "step-ingestion-hour-v1",
      [`c:${minute}:http:0:illegal-suffix`]: "1",
      [`c:${minute}:http:0`]: "1",
      [`m:${minute}:http:0:boot-a`]: JSON.stringify(payload),
    }],
    oversizeKeys: [],
  }, [hourKey]);
  assert.equal(parsed.status, "partial");
  assert.deepEqual(parsed.minutes, []);
});

test("overflow marks coverage partial but retains the two valid observed emissions in rates", async () => {
  const nowMs = Date.parse("2026-08-29T19:30:00.000Z");
  const zeroEndpoints = {
    samples: [0, 0, 0, 0, 0, 0, 0],
    "sync-v2": [0, 0, 0, 0, 0, 0, 0],
  };
  const emission = (requests) => ({
    endpoints: {
      steps: [requests, requests, 0, 0, 0, 0, 0],
      ...zeroEndpoints,
    },
  });
  const get = buildGetSystemHealth({
    now: () => new Date(nowMs),
    snapshotReader: async () => ({ ok: false, values: [] }),
    historyReader: async () => ({
      status: "available",
      collectionStartedMinuteMs: nowMs - 60_000,
      minutes: [{
        minuteStartedAtMs: nowMs - 60_000,
        workers: [
          { instance: "0", count: 2, overflow: true, emissions: [emission(2), emission(3)] },
          { instance: "1", count: 1, overflow: false, emissions: [emission(5)] },
        ],
      }],
    }),
  });
  const result = await get({ window: "60m" });
  assert.equal(result.historyStatus, "partial");
  assert.equal(result.failureWindows[0].completeCoverageMinutes, 0);
  assert.equal(result.failureWindows[0].partialCoverageMinutes, 1);
  assert.equal(result.failureWindows[0].requests, 10);
});
