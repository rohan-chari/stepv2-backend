process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
process.env.CAPACITY_PHASE_METRICS_SAMPLE_RATE = "1";

const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");
const IORedis = require("ioredis");

const {
  cleanDatabase,
  createTestUser,
  disconnectDatabase,
  prisma,
  request,
  startServer,
} = require("./setup");
const {
  appSettings,
} = require("../../src/shared/config/appSettings");
const {
  buildRecomputePlacements,
} = require("../../src/modules/races/jobs/placementRecompute");
const {
  buildRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const { startTestRedis, TEST_DB } = require("./redisTestServer");
const redisCache = require("../../src/shared/cache/redisCache");
const derivedCache = require("../../src/shared/cache/derivedCache");

const METRIC_MESSAGE = "[CAPACITY] phase metrics v1";
let observedQueries = null;
prisma.$on("query", () => observedQueries?.push(1));

function captureLogger(entries) {
  const capture = (level) => (message, fields) => {
    entries.push({ level, message, fields });
  };
  return {
    log: capture("log"),
    info: capture("info"),
    warn: capture("warn"),
    error: capture("error"),
  };
}

async function setFlag(key, value) {
  await prisma.appSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
  appSettings.bustCache();
}

async function seedActiveRace(userId) {
  const now = Date.now();
  const race = await prisma.race.create({
    data: {
      creatorId: userId,
      name: "Capacity telemetry race",
      targetSteps: 100000,
      status: "ACTIVE",
      startedAt: new Date(now - 60 * 60 * 1000),
      endsAt: new Date(now + 24 * 60 * 60 * 1000),
      timezone: "UTC",
    },
  });
  await prisma.raceParticipant.create({
    data: {
      raceId: race.id,
      userId,
      status: "ACCEPTED",
      totalSteps: 0,
    },
  });
  return race;
}

describe("capacityPhaseMetricsV1Enabled integration", () => {
  const logs = [];
  let server;
  let liveRedis;
  let redisProbe;
  let redisSkipReason = null;

  before(async () => {
    liveRedis = await startTestRedis();
    if (!liveRedis) {
      redisSkipReason = "no local Redis available";
    } else {
      const parsed = new URL(liveRedis.url);
      assert.ok(["127.0.0.1", "localhost"].includes(parsed.hostname));
      assert.equal(Number(parsed.pathname.slice(1)), TEST_DB);
    }
    server = await startServer({ logger: captureLogger(logs) });
  });

  after(async () => {
    await setFlag("capacityPhaseMetricsV1Enabled", false);
    await setFlag("apiRaceBootstrapV1Enabled", false);
    await setFlag("redisCacheMessagesEnabled", false);
    await setFlag("redisPresentationGenerationGuardEnabled", false);
    delete process.env.REDIS_URL;
    await redisCache.close();
    derivedCache.reset();
    if (redisProbe) await redisProbe.quit().catch(() => {});
    if (liveRedis) await liveRedis.close();
    await server.close();
    await disconnectDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    logs.length = 0;
    await setFlag("capacityPhaseMetricsV1Enabled", false);
    await setFlag("apiRaceBootstrapV1Enabled", true);
    await setFlag("redisCacheMessagesEnabled", false);
    await setFlag("redisPresentationGenerationGuardEnabled", false);
    delete process.env.REDIS_URL;
    await redisCache.close();
    derivedCache.reset();
  });

  it("keeps the legacy response unchanged and emits nothing while the flag is off", async () => {
    const { user, token } = await createTestUser({ displayName: "Metric Walker" });
    await seedActiveRace(user.id);

    const response = await request(server.baseUrl, "POST", "/steps/samples", {
      token,
      body: {
        samples: [{
          periodStart: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          periodEnd: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
          steps: 321,
          recordingMethod: "automatic",
          sourceName: "Health",
          sourceId: "capacity-test-source",
        }],
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { count: 1 });
    assert.equal(logs.some((entry) => entry.message === METRIC_MESSAGE), false);
  });

  it("emits sampled aggregate phase/query telemetry without changing HTTP contracts", async () => {
    await setFlag("capacityPhaseMetricsV1Enabled", true);
    const { user, token } = await createTestUser({ displayName: "Private Metric Walker" });
    const race = await seedActiveRace(user.id);

    const sampleResponse = await request(server.baseUrl, "POST", "/steps/samples", {
      token,
      body: {
        samples: [{
          periodStart: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          periodEnd: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
          steps: 654,
          recordingMethod: "automatic",
          sourceName: "Private Health Source",
          sourceId: "private-source-id",
        }],
      },
    });
    assert.equal(sampleResponse.status, 200);
    assert.deepEqual(await sampleResponse.json(), { count: 1 });

    const progressResponse = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/progress?view=participants-v1&offset=0&limit=15`,
      { token, headers: { "X-Client-Features": "race_participants_paging" } },
    );
    assert.equal(progressResponse.status, 200);
    const progressBody = await progressResponse.json();
    assert.ok(Array.isArray(progressBody.progress?.participants));

    const bootstrapResponse = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/bootstrap?view=participants-v1&offset=0&limit=15`,
      { token, headers: { "X-Client-Features": "race_participants_paging" } },
    );
    assert.equal(bootstrapResponse.status, 200);
    assert.equal((await bootstrapResponse.json()).contract, "race-bootstrap-v1");

    const sendResponse = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/messages`,
      { token, body: { body: "Telemetry integration message" } },
    );
    assert.equal(sendResponse.status, 201);
    // The exact cacheable message shape hydrates sender presentation. Redis is
    // deliberately absent here, exercising its truthful Postgres-bypass path.
    await setFlag("redisCacheMessagesEnabled", true);
    const messagesResponse = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/messages?kind=USER`,
      { token },
    );
    assert.equal(messagesResponse.status, 200);
    assert.ok(Array.isArray((await messagesResponse.json()).messages));

    const metricEntries = logs.filter((entry) => entry.message === METRIC_MESSAGE);
    const surfaces = new Set(metricEntries.map((entry) => entry.fields?.surface));
    assert.ok(surfaces.has("uploader_reconciliation"));
    assert.ok(surfaces.has("resolution_enqueue"));
    assert.ok(surfaces.has("progress_projection_hydration"));
    assert.ok(surfaces.has("bootstrap_projection_hydration"));
    assert.ok(surfaces.has("message_access"));
    assert.ok(surfaces.has("presentation_cache"));

    for (const entry of metricEntries) {
      assert.equal(entry.fields.event, "capacity_phase_metrics_v1");
      assert.equal(entry.fields.sampled, true);
      assert.equal(entry.fields.queryCaptureAvailable, true);
      assert.equal(entry.fields.measurementGateEligible, true);
      assert.equal(typeof entry.fields.durationMs, "number");
      assert.ok(entry.fields.durationMs >= 0);
      assert.equal(typeof entry.fields.queryCount, "number");
      assert.ok(entry.fields.queryCount >= 0);
      assert.equal(typeof entry.fields.phaseMs, "object");
      assert.equal(typeof entry.fields.phaseQueryCount, "object");
      assert.equal(typeof entry.fields.processPressure?.rssBytes, "number");
      assert.equal(typeof entry.fields.processPressure?.cpuUserMicros, "number");
      assert.equal(typeof entry.fields.dbPoolPressure?.total, "number");
      assert.equal(typeof entry.fields.dbPoolPressure?.idle, "number");
      assert.equal(typeof entry.fields.dbPoolPressure?.waiting, "number");
    }

    const progressMetric = metricEntries.find(
      (entry) => entry.fields.surface === "progress_projection_hydration",
    );
    assert.equal(progressMetric.fields.counts.pageSize, 15);
    assert.equal(progressMetric.fields.counts.hydratedIds, 1);
    assert.ok(progressMetric.fields.queryCount > 0);
    assert.ok(Object.values(progressMetric.fields.phaseQueryCount).some((count) => count > 0));

    const bootstrapMetric = metricEntries.find(
      (entry) => entry.fields.surface === "bootstrap_projection_hydration",
    );
    assert.ok(bootstrapMetric.fields.queryCount > 0);
    assert.ok(Object.values(bootstrapMetric.fields.phaseQueryCount).some((count) => count > 0));

    const messageMetric = metricEntries.find(
      (entry) => entry.fields.surface === "message_access",
    );
    assert.ok(messageMetric.fields.queryCount > 0);
    assert.ok(messageMetric.fields.phaseQueryCount.accessProjection > 0);

    const presentationMetric = metricEntries.find(
      (entry) => entry.fields.surface === "presentation_cache",
    );
    assert.equal(presentationMetric.fields.counts.cacheBypassedIdentities, 1);
    assert.equal(presentationMetric.fields.counts.databaseLoadOperations, 1);
    assert.equal(presentationMetric.fields.counts.databaseLoadedIdentities, 1);
    assert.ok(presentationMetric.fields.phaseQueryCount.databaseLoad > 0);

    const serialized = JSON.stringify(metricEntries);
    assert.equal(serialized.includes(user.id), false);
    assert.equal(serialized.includes(race.id), false);
    assert.equal(serialized.includes("Private Metric Walker"), false);
    assert.equal(serialized.includes("Private Health Source"), false);
    assert.equal(serialized.includes("private-source-id"), false);
    assert.equal(serialized.includes('"steps":654'), false);
  });

  it("adds zero database queries after the required cached flag read is warm", async () => {
    async function measuredHealthRequest() {
      observedQueries = [];
      try {
        const response = await request(server.baseUrl, "GET", "/health");
        assert.equal(response.status, 200);
        return observedQueries.length;
      } finally {
        observedQueries = null;
      }
    }

    await setFlag("capacityPhaseMetricsV1Enabled", false);
    await request(server.baseUrl, "GET", "/health"); // warm the 30s flag cache
    const flagOffQueries = await measuredHealthRequest();

    await setFlag("capacityPhaseMetricsV1Enabled", true);
    await request(server.baseUrl, "GET", "/health"); // warm after invalidation
    const flagOnQueries = await measuredHealthRequest();

    assert.equal(flagOffQueries, 0);
    assert.equal(flagOnQueries, 0);
  });

  it("records real placement and queue-lag job queries only while the flag is on", async () => {
    const { user } = await createTestUser({ displayName: "Capacity Job Walker" });
    await seedActiveRace(user.id);
    const now = new Date();
    const runPlacement = buildRecomputePlacements({
      now: () => now,
      appSettings,
      logger: captureLogger(logs),
      eventBus: { emit() {} },
      requestStepSyncForUsers: async () => {},
    });

    await setFlag("capacityPhaseMetricsV1Enabled", false);
    await runPlacement();
    assert.equal(
      logs.some((entry) => entry.fields?.surface === "placement"),
      false,
    );

    await setFlag("capacityPhaseMetricsV1Enabled", true);
    await runPlacement();
    const placementMetric = logs.find(
      (entry) => entry.fields?.surface === "placement",
    );
    assert.ok(placementMetric);
    assert.ok(placementMetric.fields.queryCount > 0);
    assert.ok(placementMetric.fields.phaseQueryCount.tick > 0);

    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      appSettings,
      logger: captureLogger(logs),
    });
    await worker.logQueueLag();
    const lagMetric = logs.find(
      (entry) => entry.fields?.surface === "resolution_queue_lag",
    );
    assert.ok(lagMetric);
    assert.ok(lagMetric.fields.queryCount > 0);
    assert.ok(lagMetric.fields.phaseQueryCount.lagProbe > 0);
  });

  it("correlates validated capacity run evidence without changing the HTTP response", async () => {
    await setFlag("capacityPhaseMetricsV1Enabled", true);
    const { user, token } = await createTestUser({ displayName: "Evidence Walker" });
    const race = await seedActiveRace(user.id);
    const path = `/races/${race.id}/progress?view=participants-v1&offset=0&limit=15`;

    const response = await request(server.baseUrl, "GET", path, {
      token,
      headers: {
        "X-Client-Features": "race_participants_paging",
        "X-Capacity-Run-Id": "pool3-baseline-r2",
        "X-Capacity-Repeat": "2",
      },
    });
    assert.equal(response.status, 200);
    assert.ok(Array.isArray((await response.json()).progress?.participants));
    const correlated = logs.find(
      (entry) => entry.fields?.surface === "progress_projection_hydration",
    );
    assert.equal(correlated.fields.dimensions.runId, "pool3-baseline-r2");
    assert.equal(correlated.fields.dimensions.repeat, "2");

    logs.length = 0;
    const invalidResponse = await request(server.baseUrl, "GET", path, {
      token,
      headers: {
        "X-Client-Features": "race_participants_paging",
        "X-Capacity-Run-Id": "contains private spaces",
        "X-Capacity-Repeat": "4",
      },
    });
    assert.equal(invalidResponse.status, 200);
    const uncorrelated = logs.find(
      (entry) => entry.fields?.surface === "progress_projection_hydration",
    );
    assert.equal("runId" in uncorrelated.fields.dimensions, false);
    assert.equal("repeat" in uncorrelated.fields.dimensions, false);
  });

  it("records real Redis DB 15 presentation miss/install then hit over HTTP", async (t) => {
    if (redisSkipReason) return t.skip(redisSkipReason);
    process.env.REDIS_URL = liveRedis.url;
    process.env.CACHE_ENV_PREFIX = "capacity-m0:";
    await redisCache.close();
    derivedCache.reset();
    redisProbe ||= new IORedis(liveRedis.url);
    await redisProbe.flushdb();

    await setFlag("capacityPhaseMetricsV1Enabled", true);
    await setFlag("redisCacheMessagesEnabled", true);
    await setFlag("redisPresentationGenerationGuardEnabled", true);
    const { user, token } = await createTestUser({ displayName: "Redis Metric Walker" });
    const race = await seedActiveRace(user.id);
    const sent = await request(server.baseUrl, "POST", `/races/${race.id}/messages`, {
      token,
      body: { body: "Real Redis capacity message" },
    });
    assert.equal(sent.status, 201);

    const headers = {
      "X-Capacity-Run-Id": "redis-presentation-r1",
      "X-Capacity-Repeat": "1",
    };
    logs.length = 0;
    const cold = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/messages?kind=USER`,
      { token, headers },
    );
    assert.equal(cold.status, 200);
    assert.equal((await cold.json()).messages.length, 1);
    const coldMetric = logs.find(
      (entry) => entry.fields?.surface === "presentation_cache",
    );
    assert.equal(coldMetric.fields.counts.cacheHits, 0);
    assert.equal(coldMetric.fields.counts.cacheMisses, 1);
    assert.equal(coldMetric.fields.counts.databaseLoadOperations, 1);
    assert.equal(coldMetric.fields.counts.databaseLoadedIdentities, 1);
    assert.equal(coldMetric.fields.counts.cacheInstallOperations, 1);
    assert.equal(coldMetric.fields.counts.cacheInstalledIdentities, 1);
    assert.equal(coldMetric.fields.dimensions.runId, "redis-presentation-r1");
    assert.equal(coldMetric.fields.dimensions.repeat, "1");

    logs.length = 0;
    const warm = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/messages?kind=USER`,
      { token, headers },
    );
    assert.equal(warm.status, 200);
    assert.equal((await warm.json()).messages.length, 1);
    const warmMetric = logs.find(
      (entry) => entry.fields?.surface === "presentation_cache",
    );
    assert.equal(warmMetric.fields.counts.cacheHits, 1);
    assert.equal(warmMetric.fields.counts.cacheMisses, 0);
    assert.equal(warmMetric.fields.counts.databaseLoadOperations, 0);
    assert.equal(warmMetric.fields.counts.cacheInstallOperations, 0);
  });
});
