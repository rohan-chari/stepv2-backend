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
  const viewer = await createTestUser();
  const other = await createTestUser();
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

describe("bootstrap durable refresh coalescing", () => {
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

  it("repeated and concurrent same-viewer reads preserve the pending row without a rewrite", async () => {
    const f = await fixture();
    await read(f);
    const pending = await row(f);
    assert.deepEqual(pending.dirty_reasons, ["DISPLAY_REFRESH"]);
    await Promise.all(Array.from({ length: 8 }, () => read(f)));
    assert.deepEqual(await row(f), pending);
  });

  it("concurrent first reads create one generation and retain every viewer", async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 8 }, () => read(f)));
    const first = await row(f);
    assert.equal(first.generation, 1);
    assert.deepEqual(first.triggered_by_user_ids, [f.viewer.user.id]);
    await read(f, f.other);
    const both = await row(f);
    assert.ok(both.triggered_by_user_ids.includes(f.viewer.user.id));
    assert.ok(both.triggered_by_user_ids.includes(f.other.user.id));
    await read(f, f.other);
    assert.deepEqual(await row(f), both);
  });

  it("keeps coalescing permanent when legacy reason-aware rollout is off", async () => {
    const f = await fixture();
    await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", false);
    await read(f);
    const before = await row(f);
    await read(f);
    assert.deepEqual(await row(f), before);
  });

  it("does not confuse an in-flight captured viewer with pending viewer work", async () => {
    const f = await fixture();
    await read(f);
    const lease = "test-owner-lease";
    await prisma.raceResolutionJobV2.update({ where: { raceId: f.race.id }, data: {
      state: "RUNNING", generation: 4, processingGeneration: 4, leaseToken: lease,
      leaseExpiresAt: new Date(Date.now() + 30000), processingTriggeredByUserIds: [f.viewer.user.id],
      processingDirtyReasons: ["DISPLAY_REFRESH"], triggeredByUserIds: [], dirtyReasons: [],
    } });
    await read(f);
    const followup = await row(f);
    assert.equal(followup.state, "running");
    assert.equal(followup.generation, 5);
    assert.equal(followup.processing_generation, 4);
    assert.equal(followup.lease_token, lease);
    assert.ok(followup.triggered_by_user_ids.includes(f.viewer.user.id));
    await read(f);
    assert.deepEqual(await row(f), followup);
  });

  it("retains source generations/scopes and rejects a changed timezone or artifact as covered", async () => {
    const f = await fixture();
    await read(f);
    await prisma.raceResolutionJobV2.update({ where: { raceId: f.race.id }, data: {
      generation: 9, dirtyReasons: ["STEP_INPUT_CHANGED"], dirtyParticipantIds: ["source-participant"],
      dirtyPriority: "IMMEDIATE", queuePriority: "LIVE",
    } });
    await read(f);
    const source = await row(f);
    assert.equal(source.generation, 10);
    assert.ok(source.dirty_reasons.includes("STEP_INPUT_CHANGED"));
    assert.ok(source.dirty_participant_ids.includes("source-participant"));
    assert.equal(source.queue_priority, "LIVE");
    await prisma.raceResolutionJobV2.update({ where: { raceId: f.race.id }, data: {
      dirtyReasons: ["DISPLAY_REFRESH"], dirtyParticipantIds: [], resolutionTimeZone: "Asia/Tokyo",
      displayArtifactId: "older-artifact", displayArtifactDigest: "a".repeat(64), displayArtifactSchema: 1,
    } });
    const old = await row(f);
    await read(f);
    const changed = await row(f);
    assert.equal(changed.generation, old.generation + 1);
    assert.equal(changed.resolution_time_zone, "UTC");
    assert.equal(changed.display_artifact_id, null);
  });

  for (const state of ["FAILED", "SUCCEEDED"]) it(`reactivates ${state.toLowerCase()} work and preserves pending debounce/retry deadlines`, async () => {
    const f = await fixture();
    await read(f);
    const floor = new Date(Date.now() + 60000);
    await prisma.raceResolutionJobV2.update({ where: { raceId: f.race.id }, data: {
      state, attempts: 3, retryAt: floor, notBeforeAt: floor, lastErrorCode: "OLD_FAILURE",
    } });
    await read(f);
    const reactivated = await row(f);
    assert.equal(reactivated.state, "queued");
    assert.equal(reactivated.attempts, 0);
    assert.equal(reactivated.retry_at, null);
    assert.equal(reactivated.last_error_code, null);
    assert.equal(reactivated.not_before_at.toISOString(), floor.toISOString());
    await prisma.raceResolutionJobV2.update({ where: { raceId: f.race.id }, data: { attempts: 1, retryAt: floor } });
    const delayed = await row(f);
    await read(f);
    assert.deepEqual(await row(f), delayed);
  });

  it("never enqueues work for a public preview reader", async () => {
    const f = await fixture();
    await read(f, await createTestUser());
    assert.equal(await row(f), null);
  });

  it("a failed enqueue can be retried immediately without losing work", async () => {
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
    assert.ok((await row(f)).triggered_by_user_ids.includes(f.viewer.user.id));
  });

  it("live Redis admission cannot drop a second viewer's pending work", async () => {
    liveRedis ||= await startTestRedis();
    assert.ok(liveRedis, "requires isolated local Redis for the admission regression");
    process.env.REDIS_URL = liveRedis.url;
    await redisCache.close();
    const f = await fixture();
    await read(f);
    await read(f, f.other);
    const both = await row(f);
    assert.ok(both.triggered_by_user_ids.includes(f.viewer.user.id));
    assert.ok(both.triggered_by_user_ids.includes(f.other.user.id));
  });

  it("legacy unpaged bootstrap retains both viewers within the local refresh window", async () => {
    liveRedis ||= await startTestRedis();
    assert.ok(liveRedis, "requires isolated local Redis for legacy refresh coverage");
    process.env.REDIS_URL = liveRedis.url;
    await redisCache.close();
    await appSettings.setFlag("redisStandingsEnabled", true);
    const f = await fixture();
    await read(f, f.viewer, "");
    await read(f, f.other, "");
    const both = await row(f);
    assert.ok(both.triggered_by_user_ids.includes(f.viewer.user.id));
    assert.ok(both.triggered_by_user_ids.includes(f.other.user.id));
  });

  it("a real step upload advances source work despite an outstanding display refresh", async () => {
    const f = await fixture();
    await read(f);
    const display = await row(f);
    const response = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: f.viewer.token, headers: { "Idempotency-Key": require("node:crypto").randomUUID(), "X-Timezone": "UTC" },
      body: { date: new Date().toISOString().slice(0, 10), steps: 300, samples: [] },
    });
    const body = await response.json();
    assert.equal(response.status, 202, JSON.stringify(body));
    const source = await row(f);
    assert.ok(source.generation > display.generation);
    assert.ok(source.dirty_reasons.includes("STEP_INPUT_CHANGED"));
    await read(f, f.other);
    const after = await row(f);
    assert.ok(after.generation >= source.generation);
    assert.ok(after.dirty_reasons.includes("STEP_INPUT_CHANGED"));
    assert.ok(after.triggered_by_user_ids.includes(f.other.user.id));
  });

  it("a covered repeat publishes a wake after the original enqueue had no Redis", async () => {
    const f = await fixture();
    await read(f);
    const pending = await row(f);
    liveRedis ||= await startTestRedis();
    assert.ok(liveRedis, "requires isolated local Redis for durable wake coverage");
    process.env.REDIS_URL = liveRedis.url;
    await redisCache.close();
    const subscriber = new (require("ioredis"))(liveRedis.url);
    let timeout;
    try {
      await subscriber.subscribe(`${process.env.CACHE_ENV_PREFIX}durable-queue:wake`);
      const wake = new Promise((resolve, reject) => {
        subscriber.once("message", (_, message) => resolve(JSON.parse(message)));
        timeout = setTimeout(() => reject(new Error("covered refresh did not publish its durable wake")), 2000);
      });
      await read(f);
      assert.equal((await wake).queue, "resolution");
      assert.deepEqual(await row(f), pending);
    } finally {
      clearTimeout(timeout);
      await subscriber.quit();
    }
  });
});
