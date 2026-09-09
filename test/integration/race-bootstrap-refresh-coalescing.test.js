delete process.env.PRISMA_QUERY_EVENTS_ENABLED;
// Retain the harness's protected settings overrides, then construct the real
// HTTP handlers with production worker-owned refresh behavior (no inline replay).
const { appSettings } = require("../../src/shared/config/appSettings");
process.env.NODE_ENV = "production";
process.env.STEPS_PROCESS_ROLE = "http";
process.env.DATABASE_POOL_MAX_HTTP = "10";
process.env.CACHE_ENV_PREFIX = `t:bootstrap-refresh:${require("node:crypto").randomUUID()}:`;
delete process.env.REDIS_URL;

const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require("./setup");
const { startTestRedis } = require("./redisTestServer");
const redisCache = require("../../src/shared/cache/redisCache");

let server;
let liveRedis;
const headers = {
  "X-App-Version": "99.0.0",
  "X-Client-Features": "characters,powerups3,powerups4,powerups5,remote_assets,race_participants_paging,race_preview",
  "X-Timezone": "UTC",
};

async function fixture() {
  // Model an already registered UTC device; timezone migration has its own race fences.
  const viewer = await createTestUser({ timezone: "UTC", globalEventTimezone: "UTC" });
  const other = await createTestUser({ timezone: "UTC", globalEventTimezone: "UTC" });
  const race = await prisma.race.create({ data: {
    creatorId: viewer.user.id, name: "Refresh coalescing", status: "ACTIVE", targetSteps: 50000,
    maxDurationDays: 7, maxParticipants: 50, startedAt: new Date(Date.now() - 3600000),
    endsAt: new Date(Date.now() + 86400000), timezone: "UTC", powerupsEnabled: false, isPublic: true,
  } });
  await prisma.raceParticipant.createMany({ data: [viewer, other].map((u) => ({
    raceId: race.id, userId: u.user.id, status: "ACCEPTED", totalSteps: 100, rawSteps: 100, nextBoxAtSteps: 5000,
  })) });
  return { race, viewer, other };
}

async function read(f, viewer = f.viewer, query = "?view=participants-v1&offset=0&limit=15") {
  const response = await request(server.baseUrl, "GET", `/races/${f.race.id}/bootstrap${query}`, {
    token: viewer.token, headers,
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.ok(body.progress, JSON.stringify(body));
  return body;
}

async function row(f) {
  const [value] = await prisma.$queryRaw`SELECT *, xmin::text AS version FROM race_resolution_jobs_v2 WHERE race_id = ${f.race.id}`;
  return value || null;
}

describe("bootstrap read-only queue contract", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => {
    delete process.env.REDIS_URL;
    await redisCache.close();
    await cleanDatabase();
    await appSettings.setFlag("apiRaceBootstrapV1Enabled", true);
    await appSettings.setFlag("redisStandingsEnabled", false);
    await appSettings.setFlag("racePreviewEnabled", true);
    await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);
    await appSettings.setFlag("raceResolutionQueuedGenerationMergeV1Enabled", false);
  });
  after(async () => { await redisCache.close(); await liveRedis?.close(); });

  // Contract changed deliberately: GET no longer produces display work. These
  // scenarios retain the concurrency/failure coverage but require zero writes.
  it("repeated and concurrent first reads create no scoring obligation", async () => {
    const f = await fixture();
    await read(f);
    assert.equal(await row(f), null);
    await Promise.all(Array.from({ length: 8 }, (_, i) => read(f, i % 2 ? f.viewer : f.other)));
    assert.equal(await row(f), null);
  });

  it("reads remain display-only with legacy reason-aware rollout off", async () => {
    await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", false);
    const f = await fixture();
    await read(f);
    assert.equal(await row(f), null);
  });

  for (const state of ["QUEUED", "RUNNING", "FAILED", "SUCCEEDED"]) {
    it(`reads preserve ${state.toLowerCase()} work, leases, retries, scopes and source generations`, async () => {
      const f = await fixture();
      const floor = new Date(Date.now() + 60000);
      await prisma.raceResolutionJobV2.create({ data: {
        raceId: f.race.id, requestedAt: new Date(), state, generation: 9, processingGeneration: 8,
        leaseToken: "test-owner-lease", leaseExpiresAt: floor,
        processingTriggeredByUserIds: [f.viewer.user.id],
        processingDirtyReasons: ["FULL"], triggeredByUserIds: [],
        dirtyReasons: ["STEP_INPUT_CHANGED"], dirtyParticipantIds: ["source-participant"],
        dirtyPriority: "IMMEDIATE", queuePriority: "LIVE", attempts: 3,
        retryAt: floor, notBeforeAt: floor, lastErrorCode: "OLD_FAILURE",
        resolutionTimeZone: "Asia/Tokyo", displayArtifactId: "older-artifact",
        displayArtifactDigest: "a".repeat(64), displayArtifactSchema: 1,
      } });
      const before = await row(f);
      await Promise.all([read(f), read(f, f.other), read(f)]);
      assert.deepEqual(await row(f), before, "GET must preserve every job field and xmin");
    });
  }

  it("never enqueues work for a public preview reader", async () => {
    const f = await fixture();
    await read(f, await createTestUser({ timezone: "UTC", globalEventTimezone: "UTC" }));
    assert.equal(await row(f), null);
  });

  it("reads succeed even when the job table rejects inserts", async () => {
    const f = await fixture();
    await prisma.$executeRawUnsafe("CREATE FUNCTION test_reject_refresh_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test enqueue failure'; END $$");
    await prisma.$executeRawUnsafe("CREATE TRIGGER test_reject_refresh BEFORE INSERT ON race_resolution_jobs_v2 FOR EACH STATEMENT EXECUTE FUNCTION test_reject_refresh_enqueue()");
    try {
      await read(f);
      assert.equal(await row(f), null);
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER test_reject_refresh ON race_resolution_jobs_v2");
      await prisma.$executeRawUnsafe("DROP FUNCTION test_reject_refresh_enqueue()");
    }
    await read(f);
    assert.equal(await row(f), null);
  });

  for (const query of ["?view=participants-v1&offset=0&limit=15", ""]) {
    it(`live Redis reads create no work for either viewer (${query || "legacy"})`, async () => {
      liveRedis ||= await startTestRedis();
      assert.ok(liveRedis, "requires isolated local Redis");
      process.env.REDIS_URL = liveRedis.url;
      await redisCache.close();
      await appSettings.setFlag("redisStandingsEnabled", true);
      const f = await fixture();
      await Promise.all([read(f, f.viewer, query), read(f, f.other, query)]);
      assert.equal(await row(f), null);
      assert.equal(await prisma.raceProgressRefreshIntent.count({where:{raceId:f.race.id}}),0);
    });
  }

  it("a real step upload creates source work and subsequent reads leave it intact", async () => {
    const f = await fixture();
    await read(f);
    assert.equal(await row(f), null);
    const response = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: f.viewer.token, headers: { "Idempotency-Key": require("node:crypto").randomUUID(), "X-Timezone": "UTC" },
      body: { date: new Date().toISOString().slice(0, 10), steps: 300, samples: [] },
    });
    assert.equal(response.status, 202, JSON.stringify(await response.json()));
    const source = await row(f);
    assert.ok(source.generation > 0);
    assert.ok(source.dirty_reasons.includes("STEP_INPUT_CHANGED"));
    await read(f, f.other);
    assert.deepEqual(await row(f), source);
  });
});
