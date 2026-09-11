const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");
const IORedis = require("ioredis");

process.env.CACHE_ENV_PREFIX = "t:";
delete process.env.REDIS_URL;

const { startTestRedis, closedPort } = require("./redisTestServer");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const redisCache = require("../../src/shared/cache/redisCache");
const derivedCache = require("../../src/shared/cache/derivedCache");
const cacheKeys = require("../../src/shared/cache/cacheKeys");
const { appSettings } = require("../../src/shared/config/appSettings");
const { createSavedRecap } = require('./helpers/eventRecapFixture');

let server;
let live;
let probe;

async function selectRedis(url) {
  if (url) process.env.REDIS_URL = url;
  else delete process.env.REDIS_URL;
  await redisCache.close();
  derivedCache.reset();
}

async function home(user, shell = false) {
  return request(server.baseUrl, "GET", "/home/race-card", {
    token: user.token,
    headers: {
      "X-Client-Features": shell
        ? "impact_summaries,impact_summary_expiry_v1,home_shell_v1"
        : "impact_summaries,impact_summary_expiry_v1",
    },
  });
}

async function createCompletedRace(user, suffix) {
  const race = await prisma.race.create({ data: {
    creatorId: user.user.id,
    name: `Summary ${suffix}`,
    targetSteps: 10000,
    status: "COMPLETED",
    startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    endsAt: new Date(Date.now() - 60 * 60 * 1000),
    completedAt: new Date(Date.now() - 60 * 60 * 1000),
  } });
  await prisma.raceParticipant.create({ data: {
    raceId: race.id,
    userId: user.user.id,
    status: "ACCEPTED",
  } });
  return race;
}

async function createEndedEvent() {
  return prisma.globalStepEvent.create({ data: {
    startsAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    endsAt: new Date(Date.now() - 60 * 60 * 1000),
    multiplier: 2,
    scheduleMode: 'LOCAL_ENTITLEMENTS',
  } });
}

async function addFinal(event, race, user, extraRaceSteps) {
  await prisma.globalEventRaceImpact.create({ data: {
    eventId: event.id, raceId: race.id, userId: user.user.id,
  } });
  return createSavedRecap(prisma, { event, userId: user.user.id, extraRaceSteps });
}

describe("active impact Home summary Postgres + Redis matrix", () => {
  before(async () => {
    server = await getSharedServer();
    live = await startTestRedis();
    if (live) probe = new IORedis(live.url);
  });

  beforeEach(async () => {
    await selectRedis(null);
    await cleanDatabase();
    await appSettings.setFlagsAtomically([
      ["apiImpactSummariesEnabled", true],
      ["apiHomeShellV1Enabled", true],
      ["redisCacheHomeImpactSummaryEnabled", true],
    ]);
    if (probe) await probe.flushdb();
  });

  after(async () => {
    await selectRedis(null);
    await probe?.quit().catch(() => {});
    await live?.close();
  });

  it("saved zero recap never publishes through either Home path", async () => {
    const user = await createTestUser();
    const event = await createEndedEvent();
    const race = await createCompletedRace(user, "zero");
    await addFinal(event, race, user, 0);
    assert.equal(await prisma.eventRecap.count({ where: { suppressed: true } }), 1);
    for (const shell of [false, true]) {
      const response = await home(user, shell);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).globalEventSummary, undefined);
    }
  });

  it("migrated mixed-net-zero recap is suppressed in both Home paths", async () => {
    const user = await createTestUser();
    const event = await createEndedEvent();
    const [raceA, raceB] = await Promise.all([
      createCompletedRace(user, "positive"),
      createCompletedRace(user, "negative"),
    ]);
    await prisma.globalEventRaceImpact.createMany({ data: [raceA, raceB].map(race => ({
      eventId: event.id, raceId: race.id, userId: user.user.id,
    })) });
    const summary = await createSavedRecap(prisma, { event, userId: user.user.id, extraRaceSteps: 0, raceCount: 2 });
    assert.equal(summary.extraRaceSteps, 0);
    assert.equal(summary.raceCount, 2);
    for (const shell of [false, true]) {
      const response = await home(user, shell);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).globalEventSummary, undefined);
    }
  });

  it("db15 serves cold/warm v2 entries, ignores stale v1, and acknowledgement invalidates", async (t) => {
    if (!live) return t.skip("local Redis unavailable");
    await selectRedis(live.url);
    const user = await createTestUser();
    const event = await createEndedEvent();
    const race = await createCompletedRace(user, "redis");
    await addFinal(event, race, user, 125);

    await probe.set(
      `t:v1:home:impact-summary:${user.user.id}`,
      JSON.stringify({ v: { id: "stale-v1-all-zero", extraRaceSteps: 0 } }),
    );
    const cold = await home(user);
    assert.equal(cold.status, 200);
    const first = (await cold.json()).globalEventSummary;
    assert.notEqual(first.id, "stale-v1-all-zero");
    assert.ok(await probe.get(`t:${cacheKeys.homeImpactSummary(user.user.id)}`));

    await prisma.eventRecap.update({
      where: { id: first.id },
      data: { extraRaceSteps: 777 },
    });
    assert.equal((await (await home(user)).json()).globalEventSummary.extraRaceSteps, 125,
      "warm read proves the v2 key was used");
    await probe.del(`t:${cacheKeys.homeImpactSummary(user.user.id)}`);
    assert.equal((await (await home(user)).json()).globalEventSummary.extraRaceSteps, 777,
      "cold read returns the authoritative Postgres row");

    const ack = await request(
      server.baseUrl,
      "POST",
      `/home/global-event-summaries/${first.id}/acknowledge`,
      { token: user.token, headers: { "X-Client-Features": "impact_summaries" } },
    );
    assert.equal(ack.status, 200);
    assert.equal((await (await home(user)).json()).globalEventSummary, undefined);
  });

  it("summary creation invalidates a cached miss and Redis failure/unset remain Postgres-correct", async (t) => {
    const user = await createTestUser();
    const event = await createEndedEvent();
    const race = await createCompletedRace(user, "invalidate");
    if (live) {
      await selectRedis(live.url);
      assert.equal((await (await home(user)).json()).globalEventSummary, undefined);
    } else {
      t.diagnostic("local Redis unavailable; warm-miss invalidation subcase skipped");
    }
    await prisma.globalStepEventEntitlement.create({ data: {
      eventId: event.id, userId: user.user.id, timezone: 'UTC', localDate: new Date().toISOString().slice(0,10),
      startsAt: event.startsAt, endsAt: event.endsAt, startProcessedAt: event.startsAt,
      startOutcome: 'ACTIVATED_ON_TIME', recapRaceCount: 1, recapCountPolicyVersion: 1, recapWindowRevision: 0,
    } });
    const finalize = await request(server.baseUrl, 'POST', '/home/event-recap', {
      token: user.token, body: { eventId: event.id, revision: 0, rawSteps: 250 },
    });
    assert.equal(finalize.status, 200);
    const summaryId = (await finalize.json()).globalEventSummary.id;
    assert.equal((await (await home(user)).json()).globalEventSummary.id, summaryId);

    await selectRedis(`redis://127.0.0.1:${await closedPort()}/15`);
    assert.equal((await (await home(user, true)).json()).globalEventSummary.id, summaryId);
    await selectRedis(null);
    assert.equal((await (await home(user)).json()).globalEventSummary.id, summaryId);
  });

  it("bypasses specialized summary cache reads and writes after forced DEL failure in both Home builders", async (t) => {
    if (!live) return t.skip("local Redis unavailable");
    await selectRedis(live.url);
    const user = await createTestUser();
    const event = await createEndedEvent();
    const race = await createCompletedRace(user, "delete-breaker");
    await addFinal(event, race, user, 125);
    assert.equal((await (await home(user)).json()).globalEventSummary.extraRaceSteps, 125);

    await prisma.eventRecap.updateMany({
      where: { eventId: event.id, userId: user.user.id },
      data: { extraRaceSteps: 777 },
    });
    const originalDel = redisCache.del;
    redisCache.del = async () => false;
    try {
      assert.equal(await derivedCache.invalidate({
        keys: [cacheKeys.homeImpactSummary(user.user.id)],
        prefix: cacheKeys.PREFIX.HOME_IMPACT_SUMMARY,
      }), false);
      assert.equal(derivedCache.isBypassed(cacheKeys.PREFIX.HOME_IMPACT_SUMMARY), true);
      for (const shell of [false, true]) {
        const response = await home(user, shell);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).globalEventSummary.extraRaceSteps, 777);
      }
      const physical = JSON.parse(await probe.get(`t:${cacheKeys.homeImpactSummary(user.user.id)}`));
      assert.equal(physical.extraRaceSteps, 125,
        "bypass must not rewrite the specialized key while invalidation is unresolved");
    } finally {
      redisCache.del = originalDel;
      derivedCache.reset();
    }
  });
});
