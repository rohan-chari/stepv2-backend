const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");
const IORedis = require("ioredis");

const redisCache = require("../../src/shared/cache/redisCache");
const cacheKeys = require("../../src/shared/cache/cacheKeys");
const { startTestRedis, TEST_DB } = require("./redisTestServer");

const {
  cleanDatabase,
  createTestUser,
  request,
  startServer,
} = require("./setup");

function histogram(observations = 0, maxMs = null) {
  return {
    observations,
    sumMs: observations * (maxMs || 0),
    maxMs,
    counts: Array(12).fill(observations),
  };
}

function endpointAggregate(endpoint, requests, successes, validation4xx = 0) {
  return {
    endpoint,
    requests,
    successes,
    failures: requests - successes,
    queuedTimeouts: 0,
    validation4xx,
    auth4xx: 0,
    poolCheckoutTimeouts: 0,
    transactionErrors: 0,
    server5xx: 0,
    requestDurationHistogram: histogram(requests, requests ? 20 : null),
    authenticationDurationHistogram: histogram(requests, requests ? 5 : null),
    checkoutWaitHistogram: histogram(),
    transactionDurationHistogram: histogram(successes, successes ? 10 : null),
  };
}

function stepAggregate() {
  const endpoints = [
    endpointAggregate("steps", 2, 1, 1),
    endpointAggregate("samples", 1, 1, 0),
    endpointAggregate("sync-v2", 0, 0, 0),
  ];
  return {
    requests: 3,
    successes: 2,
    failures: 1,
    queuedTimeouts: 0,
    validation4xx: 1,
    auth4xx: 0,
    poolCheckoutTimeouts: 0,
    transactionErrors: 0,
    server5xx: 0,
    requestDurationHistogram: histogram(3, 20),
    authenticationDurationHistogram: histogram(3, 5),
    checkoutWaitHistogram: histogram(),
    transactionDurationHistogram: histogram(2, 10),
    endpoints,
    phases: [],
  };
}

function poolSnapshot(role, instance, nowMs) {
  const endMinute = Math.floor(nowMs / 60_000) * 60_000;
  const buckets = Array.from({ length: 60 }, (_, index) => {
    const minuteStartedAtMs = endMinute - (60 - index) * 60_000;
    return {
      minuteStartedAtMs,
      minuteStartedAt: new Date(minuteStartedAtMs).toISOString(),
      interval: {
        acquisitions: 2,
        releases: 2,
        queuedCheckouts: 0,
        queuedTimeouts: 0,
        physicalAttempts: 0,
        physicalTimeouts: 0,
        physicalErrors: 0,
      },
      queuedWaitHistogram: histogram(),
      physicalConnectionDurationHistogram: histogram(),
      ...(role === "http" ? { stepIngestion: stepAggregate() } : {}),
    };
  });
  return {
    schema: "database-pool-telemetry-snapshot-v1",
    role,
    instance,
    bootId: `integration-${role}-${instance}`,
    bootStartedAtMs: nowMs - 3_600_000,
    bootStartedAt: new Date(nowMs - 3_600_000).toISOString(),
    capturedAtMs: nowMs,
    capturedAt: new Date(nowMs).toISOString(),
    oldestBucketAt: buckets[0].minuteStartedAt,
    newestBucketAt: buckets.at(-1).minuteStartedAt,
    coverageMinutes: 60,
    pool: { max: 20, total: 4, idle: 2, nonIdle: 2, checkedOut: 2, waiting: 0 },
    process: { rssBytes: 1024, cpuOneCorePercent: 2, eventLoopP99Ms: 1 },
    buckets,
  };
}

describe("admin system health", () => {
  let server;
  let originalRedisUrl;
  let originalCachePrefix;

  before(async () => {
    const databaseName = decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1));
    assert.match(databaseName, /_test$/, "admin system-health integration requires a dedicated *_test database");
    originalRedisUrl = process.env.REDIS_URL;
    originalCachePrefix = process.env.CACHE_ENV_PREFIX;
    delete process.env.REDIS_URL;
    delete process.env.CACHE_ENV_PREFIX;
    await redisCache.close();
    server = await startServer();
  });

  after(async () => {
    await server.close();
    await redisCache.close();
    if (originalRedisUrl == null) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    if (originalCachePrefix == null) delete process.env.CACHE_ENV_PREFIX;
    else process.env.CACHE_ENV_PREFIX = originalCachePrefix;
  });

  beforeEach(cleanDatabase);

  it("uses the real auth/admin middleware and returns the additive envelope", async () => {
    const admin = await createTestUser({
      email: process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com",
    });
    const response = await request(server.baseUrl, "GET", "/admin/system-health?window=60m", { token: admin.token });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.schema, "admin-system-health-v1");
    assert.equal(body.status, "unavailable");
    assert.equal(body.overall, "unknown");
    assert.equal(body.historyStatus, "unavailable");
    assert.equal(body.freshProcesses, 0);
    assert.deepEqual(body.processes, []);
    assert.equal(body.stepIngestion, null);
    assert.equal(body.failureWindows, null);
    assert.deepEqual(body.missingProcesses, [
      { role: "http", instance: "0", reason: "unavailable" },
      { role: "http", instance: "1", reason: "unavailable" },
      { role: "resolution", instance: "0", reason: "unavailable" },
      { role: "cron", instance: "0", reason: "unavailable" },
    ]);
  });

  it("keeps unauthenticated and non-admin callers behind the existing gates", async () => {
    assert.equal((await request(server.baseUrl, "GET", "/admin/system-health")).status, 401);
    const user = await createTestUser({ email: "ordinary-user@example.com" });
    assert.equal((await request(server.baseUrl, "GET", "/admin/system-health", { token: user.token })).status, 403);
  });

  it("returns the full ordered available envelope from real Redis and isolates one malformed process", async (t) => {
    const live = await startTestRedis();
    if (!live) return t.skip("no local Redis available");
    assert.equal(Number(new URL(live.url).pathname.slice(1)), TEST_DB, "live telemetry integration must use Redis db15");
    const previousRedisUrl = process.env.REDIS_URL;
    const previousPrefix = process.env.CACHE_ENV_PREFIX;
    const prefix = "t:admin-system-health-available:";
    let probe;
    try {
      process.env.REDIS_URL = live.url;
      process.env.CACHE_ENV_PREFIX = prefix;
      await redisCache.close();
      probe = new IORedis(live.url);
      await probe.flushdb();

      const nowMs = Math.floor(Date.now() / 60_000) * 60_000;
      for (const [role, instance] of [["http", "0"], ["http", "1"], ["resolution", "0"], ["cron", "0"]]) {
        const result = await redisCache.writeDatabasePoolTelemetrySnapshot(
          cacheKeys.databasePoolTelemetry(role, instance),
          poolSnapshot(role, instance, nowMs),
          150,
        );
        assert.equal(result.status, "accepted");
      }

      const minuteStartedAtMs = Math.floor(nowMs / 60_000) * 60_000 - 60_000;
      const empty = { requests: 0, successes: 0, validation4xx: 0, auth4xx: 0, poolCheckoutTimeouts: 0, transactionErrors: 0, server5xx: 0 };
      const writeHistory = async (instance, steps) => redisCache.writeStepIngestionMinute({
        hourKey: cacheKeys.stepIngestionHour(minuteStartedAtMs),
        startKey: cacheKeys.stepIngestionHistoryStart(),
        emission: {
          minuteStartedAtMs,
          role: "http",
          instance,
          bootId: `integration-http-${instance}`,
          endpoints: { steps, samples: empty, "sync-v2": empty },
        },
        collectionStartedMinuteMs: minuteStartedAtMs,
      });
      assert.equal((await writeHistory("0", { requests: 4, successes: 3, validation4xx: 1, auth4xx: 0, poolCheckoutTimeouts: 0, transactionErrors: 0, server5xx: 0 })).status, "accepted");
      assert.equal((await writeHistory("1", { requests: 6, successes: 5, validation4xx: 0, auth4xx: 0, poolCheckoutTimeouts: 0, transactionErrors: 0, server5xx: 1 })).status, "accepted");

      const admin = await createTestUser({
        email: process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com",
      });
      const response = await request(server.baseUrl, "GET", "/admin/system-health?window=60m", { token: admin.token });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, "available", JSON.stringify(body));
      assert.equal(body.overall, "healthy");
      assert.equal(body.historyStatus, "available");
      assert.equal(body.windowCoverageMinutes, 60);
      assert.equal(body.freshProcesses, 4);
      assert.deepEqual(body.missingProcesses, []);
      assert.deepEqual(body.processes.map((row) => `${row.role}:${row.instance}`), ["http:0", "http:1", "resolution:0", "cron:0"]);
      assert.deepEqual(body.stepIngestion.endpoints.map((row) => row.endpoint), ["steps", "samples", "sync-v2"]);
      assert.deepEqual(body.failureWindows.map((row) => row.window), ["60m", "24h", "7d"]);
      for (const row of body.failureWindows) {
        assert.equal(Number.isInteger(row.requests), true);
        assert.equal(Number.isInteger(row.successes), true);
        assert.equal(Number.isInteger(row.requestFailures), true);
        assert.equal(Number.isInteger(row.serverFailures), true);
        assert.equal(row.requests, 10);
        assert.equal(row.successes, 8);
        assert.equal(row.requestFailures, 2);
        assert.equal(row.serverFailures, 1);
        assert.equal(row.completeCoverageMinutes, 1);
        assert.equal(row.partialCoverageMinutes, 0);
      }

      await probe.set(`${prefix}${cacheKeys.databasePoolTelemetry("http", "1")}`, "{malformed");
      const partialResponse = await request(server.baseUrl, "GET", "/admin/system-health?window=60m", { token: admin.token });
      assert.equal(partialResponse.status, 200);
      const partial = await partialResponse.json();
      assert.equal(partial.status, "partial");
      assert.equal(partial.overall, "degraded");
      assert.equal(partial.historyStatus, "available");
      assert.equal(partial.freshProcesses, 3);
      assert.deepEqual(partial.missingProcesses, [{ role: "http", instance: "1", reason: "malformed" }]);
      assert.deepEqual(partial.processes.map((row) => `${row.role}:${row.instance}`), ["http:0", "resolution:0", "cron:0"]);
      assert.equal(partial.stepIngestion.contributingHttpProcesses, 1);
    } finally {
      await redisCache.close();
      await probe?.quit().catch(() => {});
      await live.close();
      if (previousRedisUrl == null) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousRedisUrl;
      if (previousPrefix == null) delete process.env.CACHE_ENV_PREFIX;
      else process.env.CACHE_ENV_PREFIX = previousPrefix;
    }
  });
});
