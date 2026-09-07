process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { before, after, beforeEach, describe, it } = require("node:test");
const IORedis = require("ioredis");
const { startTestRedis } = require("./redisTestServer");
const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require("./setup");
const redisCache = require("../../src/shared/cache/redisCache");
const derivedCache = require("../../src/shared/cache/derivedCache");
const { appSettings } = require("../../src/shared/config/appSettings");
let capturedQueries = null;
prisma.$on("query", (event) => { if (capturedQueries) capturedQueries.push(event); });

let server;
let redis;
let probe;
const cachePrefix = `t:expiry-load:${randomUUID()}:`;
before(async () => {
  redis = await startTestRedis();
  assert.ok(redis, "expiry publication load tests require local redis-server");
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(new URL(redis.url).hostname),
    "load tests must use local Redis");
  probe = new IORedis(redis.url);
  server = await getSharedServer();
});
beforeEach(async () => {
  await cleanDatabase();
  await redisCache.close();
  process.env.REDIS_URL = redis.url;
  process.env.CACHE_ENV_PREFIX = cachePrefix;
  derivedCache.reset();
  await appSettings.setFlag("redisStandingsEnabled", true);
  appSettings.bustCache();
});
after(async () => {
  await redisCache.close();
  if (probe) {
    const keys = await probe.keys(`${cachePrefix}*`);
    if (keys.length) await probe.del(...keys);
    await probe.quit();
  }
  if (redis) await redis.close();
});

async function activateFixture({ raceCount, participantsPerRace, idleRaces = 0 }) {
  const viewers = [];
  const fixtureKey = randomUUID().slice(0, 8);
  for (let index = 0; index < participantsPerRace; index += 1) {
    viewers.push(await createTestUser({ displayName: `Expiry ${fixtureKey} ${index}` }));
  }
  const startedAt = new Date(Date.now() - 3_600_000);
  const endsAt = new Date(Date.now() + 86_400_000);
  const races = [];
  for (let index = 0; index < raceCount; index += 1) {
    const race = await prisma.race.create({ data: {
      creatorId: viewers[0].user.id, name: `Expiry burst ${index}`,
      status: "ACTIVE", targetSteps: 200_000, timezone: "UTC", startedAt, endsAt,
      powerupsEnabled: true, powerupStepInterval: 5000,
    } });
    for (const viewer of viewers) {
      const participant = await prisma.raceParticipant.create({ data: {
        raceId: race.id, userId: viewer.user.id, status: "ACCEPTED", nextBoxAtSteps: 5000,
      } });
      const powerup = await prisma.racePowerup.create({ data: {
        raceId: race.id, participantId: participant.id, userId: viewer.user.id,
        type: "FANNY_PACK", rarity: "RARE", status: "HELD", earnedAtSteps: 0,
      } });
      const response = await request(server.baseUrl, "POST",
        `/races/${race.id}/powerups/${powerup.id}/use`, { token: viewer.token, body: {} });
      assert.equal(response.status, 200, JSON.stringify(await response.json()));
    }
    races.push(race);
  }
  if (idleRaces) {
    const idle = Array.from({ length: idleRaces }, (_, index) => ({
      id: randomUUID(), creatorId: viewers[0].user.id, name: `Expiry idle ${index}`,
      status: "ACTIVE", targetSteps: 200_000, timezone: "UTC", startedAt, endsAt,
      powerupsEnabled: true,
    }));
    await prisma.race.createMany({ data: idle });
    const participants = idle.map((race) => ({ id: randomUUID(), raceId: race.id,
      userId: viewers[0].user.id, status: "ACCEPTED" }));
    await prisma.raceParticipant.createMany({ data: participants });
    const powerups = participants.map((participant) => ({ id: randomUUID(),
      raceId: participant.raceId, participantId: participant.id, userId: participant.userId,
      type: "FANNY_PACK", rarity: "RARE", status: "USED", earnedAtSteps: 0 }));
    await prisma.racePowerup.createMany({ data: powerups });
    // Future effects form a large indexed control population. Only the due
    // treatment population above is activated through the public command.
    await prisma.raceActiveEffect.createMany({ data: participants.map((participant, index) => ({
      raceId: participant.raceId, targetParticipantId: participant.id,
      targetUserId: participant.userId, sourceUserId: participant.userId,
      powerupId: powerups[index].id, type: "FANNY_PACK", startsAt: startedAt,
      expiresAt: endsAt, status: "ACTIVE",
    })) });
  }
  const raceIds = races.map((race) => race.id);
  return { viewers, races, raceIds };
}

async function makeDue(raceIds) {
  const deadline = new Date();
  await prisma.raceActiveEffect.updateMany({
    where: { raceId: { in: raceIds }, status: "ACTIVE" }, data: { expiresAt: deadline },
  });
  return deadline;
}

async function observeThroughHttp(fixture) {
  for (const race of fixture.races) {
    for (const viewer of fixture.viewers) {
      const response = await request(server.baseUrl, "GET", `/races/${race.id}/progress`, {
        token: viewer.token,
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      const effects = body.progress?.powerupData?.activeEffects;
      assert.ok(Array.isArray(effects), "legacy HTTP response retains activeEffects array");
      assert.equal(effects.filter((effect) => effect.type === "FANNY_PACK").length, 0,
        "HTTP viewer sees all expired packs removed");
    }
  }
}

async function drainThroughWorkers(fixture, { deadline, requirePublication = true } = {}) {
  const { buildRaceResolutionWorkerV2 } = require("../../src/modules/races/jobs/raceResolutionQueueV2");
  const { buildRaceResolutionPostTaskRunner } = require("../../src/modules/races/jobs/raceResolutionPostTaskRunner");
  const worker = buildRaceResolutionWorkerV2({ bootAt: 0 });
  const post = buildRaceResolutionPostTaskRunner();
  const observed = new Map();
  const start = performance.now();
  while (performance.now() - start < 30_000) {
    await Promise.all(Array.from({ length: 4 }, () => worker.processOne()));
    for (let index = 0; index < 4; index += 1) {
      await post.snapshotTick();
      await post.tick();
    }
    const outstanding = await prisma.raceActiveEffect.findMany({
      where: { raceId: { in: fixture.raceIds }, status: "ACTIVE" }, select: { raceId: true },
    });
    const pending = new Set(outstanding.map((effect) => effect.raceId));
    for (const raceId of fixture.raceIds) {
      if (pending.has(raceId) || observed.has(raceId)) continue;
      if (requirePublication) {
        const values = await probe.mget(`${cachePrefix}v1:race:progress:${raceId}`,
          `${cachePrefix}v1:race:progress:${raceId}:lean-v3`);
        const published = values.filter(Boolean).map((value) => JSON.parse(value)).some((snapshot) =>
          snapshot.generation > 0 && Date.parse(snapshot.asOf) >= deadline.getTime() &&
          Array.isArray(snapshot.activeEffects) &&
          !snapshot.activeEffects.some((effect) => effect.type === "FANNY_PACK"));
        if (!published) continue;
      }
      observed.set(raceId, deadline ? Date.now() - deadline.getTime() : performance.now() - start);
    }
    if (observed.size === fixture.raceIds.length) return [...observed.values()].sort((a, b) => a - b);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  console.log(JSON.stringify({ event: "expiry_load_incomplete",
    jobs: await prisma.raceResolutionJobV2.findMany({ where: { raceId: { in: fixture.raceIds } },
      select: { state: true, generation: true, processingGeneration: true, lastErrorCode: true } }),
    postTasks: await prisma.raceResolutionPostTask.findMany({ where: { raceId: { in: fixture.raceIds } },
      select: { state: true, snapshotState: true, snapshotErrorCode: true } }),
  }));
  assert.fail("bounded worker drain did not converge expiry consequences");
}

describe("expiry integration under simultaneous deadlines and viewer load", () => {
  it("coalesces 48 effects across 12 races while 2000 idle races stay untouched", async () => {
    const fixture = await activateFixture({ raceCount: 12, participantsPerRace: 4, idleRaces: 2000 });
    const { buildRaceEffectDeadlineScheduler } = require("../../src/modules/races/jobs/raceEffectDeadlineScheduler");
    const scheduler = buildRaceEffectDeadlineScheduler();
    const deadline = await makeDue(fixture.raceIds);
    const start = performance.now();
    const events = [];
    capturedQueries = events;
    try {
      await Promise.all([scheduler.tick(), buildRaceEffectDeadlineScheduler().tick()]);
    } finally {
      capturedQueries = null;
    }
    const dispatchMs = performance.now() - start;
    const dueQuery = events.find((event) => /SELECT effect_id,race_id FROM race_effect_deadlines/.test(event.query));
    assert.ok(dueQuery, "capture the scheduler's actual deadline query for EXPLAIN");
    await prisma.$executeRawUnsafe("ANALYZE race_effect_deadlines");
    const explain = await prisma.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${dueQuery.query}`,
      ...JSON.parse(dueQuery.params));
    const plan = explain[0]["QUERY PLAN"][0];
    const walk = (node) => [node, ...(node.Plans || []).flatMap(walk)];
    assert.ok(walk(plan.Plan).some((node) => String(node["Index Cond"] || "").includes("deadline_at")),
      "future deadlines must be excluded by an index range, not filtered after a full pending scan");
    console.log(JSON.stringify({ event: "expiry_due_query_plan", plan }));
    const jobs = await prisma.raceResolutionJobV2.findMany({ where: { raceId: { in: fixture.raceIds } } });
    assert.equal(jobs.length, 12);
    assert.ok(jobs.every((job) => job.dirtyReasons.includes("EFFECT_BOUNDARY")));
    assert.equal(await prisma.raceResolutionJobV2.count({ where: { raceId: { notIn: fixture.raceIds } } }), 0);
    const generations = new Map(jobs.map((job) => [job.raceId, job.generation]));
    await scheduler.tick();
    for (const job of await prisma.raceResolutionJobV2.findMany({ where: { raceId: { in: fixture.raceIds } } })) {
      assert.equal(job.generation, generations.get(job.raceId), "duplicate sweep cannot advance generations");
    }
    const completionMs = await drainThroughWorkers(fixture, { deadline });
    await observeThroughHttp(fixture);
    assert.equal(await prisma.racePowerupEvent.count({ where: {
      raceId: { in: fixture.raceIds }, powerupType: "FANNY_PACK", eventType: "EFFECT_EXPIRED",
    } }), 48, "each consequence emits exactly one expiry result");
    assert.equal(await prisma.raceParticipant.count({ where: {
      raceId: { in: fixture.raceIds }, powerupSlots: 3,
    } }), 48, "all slot consequences settle once");
    const publicationP95Ms = completionMs[Math.ceil(completionMs.length * .95) - 1];
    const publicationP99Ms = completionMs[Math.ceil(completionMs.length * .99) - 1];
    assert.ok(publicationP95Ms <= 5000, `publication p95 ${publicationP95Ms}ms exceeds supported fixture target`);
    assert.ok(publicationP99Ms <= 30000, `publication p99 ${publicationP99Ms}ms exceeds supported fixture target`);
    console.log(JSON.stringify({ event: "expiry_load_observation", races: 12, effects: 48,
      idleRaces: 2000, dispatchMs, publicationP95Ms, publicationP99Ms,
      deadlineToAllHttpConfirmedMs: Date.now() - deadline.getTime() }));
  });

  it("120 concurrent progress reads cannot supersede an already-covered deadline", async () => {
    delete process.env.REDIS_URL;
    await redisCache.close();
    derivedCache.reset();
    const fixture = await activateFixture({ raceCount: 1, participantsPerRace: 4 });
    const { buildRaceEffectDeadlineScheduler } = require("../../src/modules/races/jobs/raceEffectDeadlineScheduler");
    await makeDue(fixture.raceIds);
    await buildRaceEffectDeadlineScheduler().tick();
    const before = await prisma.raceResolutionJobV2.findUniqueOrThrow({ where: { raceId: fixture.raceIds[0] } });
    // A deliberately paused worker makes every reader observe pending expiry.
    // Twenty simultaneous readers per wave avoid overwhelming the HTTP socket
    // pool while still exercising concurrent admission against the real DB.
    for (let wave = 0; wave < 6; wave += 1) {
      const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => request(server.baseUrl,
        "GET", `/races/${fixture.raceIds[0]}/progress`, { token: fixture.viewers[index % 4].token })));
      for (const response of responses) {
        assert.equal(response.status, 200);
        assert.ok((await response.json()).progress);
      }
    }
    const after = await prisma.raceResolutionJobV2.findUniqueOrThrow({ where: { raceId: fixture.raceIds[0] } });
    assert.equal(after.generation, before.generation, "covered viewer polls must not churn the expiry generation");
    await drainThroughWorkers(fixture, { requirePublication: false });
    await observeThroughHttp(fixture);
  });

  it("one hundred simultaneous effects in a large race share one durable boundary job", async () => {
    const fixture = await activateFixture({ raceCount: 1, participantsPerRace: 100 });
    const healthy = await activateFixture({ raceCount: 1, participantsPerRace: 1 });
    const { buildRaceEffectDeadlineScheduler } = require("../../src/modules/races/jobs/raceEffectDeadlineScheduler");
    const deadline = await makeDue(fixture.raceIds);
    await makeDue(healthy.raceIds);
    const scheduler = buildRaceEffectDeadlineScheduler();
    let releaseLock;
    let lockReady;
    const released = new Promise((resolve) => { releaseLock = resolve; });
    const ready = new Promise((resolve) => { lockReady = resolve; });
    const holding = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe("SELECT id FROM race_resolution_jobs_v2 WHERE race_id=$1 FOR UPDATE", fixture.raceIds[0]);
      lockReady();
      await released;
    }, { timeout: 15000 });
    try {
      await ready;
      for (let index = 0; index < 3; index += 1) await scheduler.tick();
      const other = await prisma.$queryRawUnsafe(
        "SELECT dispatched_revision FROM race_effect_deadlines WHERE race_id=$1", healthy.raceIds[0],
      );
      assert.ok(other[0]?.dispatched_revision,
        "a locked race filling the earliest batch cannot starve the next due race");
    } finally {
      releaseLock();
      await holding;
    }
    const recoveryEnd = Date.now() + 6000;
    let jobs;
    do {
      await scheduler.tick();
      jobs = await prisma.raceResolutionJobV2.findMany({ where: { raceId: fixture.raceIds[0] } });
      if (jobs[0]?.dirtyReasons.includes("EFFECT_BOUNDARY")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < recoveryEnd);
    assert.equal(jobs.length, 1);
    assert.ok(jobs[0].dirtyReasons.includes("EFFECT_BOUNDARY"));
    const dispatched = await prisma.$queryRawUnsafe(
      "SELECT count(*)::int AS count FROM race_effect_deadlines WHERE race_id=$1 AND dispatched_revision=revision",
      fixture.raceIds[0],
    );
    assert.equal(dispatched[0].count, 100);
    await drainThroughWorkers(fixture, { deadline });
    await observeThroughHttp(fixture);
    await observeThroughHttp(healthy);
    assert.equal(await prisma.raceParticipant.count({ where: {
      raceId: fixture.raceIds[0], powerupSlots: 3,
    } }), 100);
    assert.equal(await prisma.racePowerupEvent.count({ where: {
      raceId: fixture.raceIds[0], powerupType: "FANNY_PACK", eventType: "EFFECT_EXPIRED",
    } }), 100);
    console.log(JSON.stringify({ event: "expiry_large_race_observation", participants: 100,
      effects: 100, deadlineToAllHttpConfirmedMs: Date.now() - deadline.getTime() }));
  });
});
