// The page projection suite deliberately uses real HTTP, Postgres, and Redis.
// It is skipped only when this machine cannot provide an isolated local Redis;
// the Redis-less fallback cases still run against Postgres.
process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
process.env.CACHE_ENV_PREFIX = "t:";

const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const { startTestRedis } = require("./redisTestServer");
const redisCache = require("../../src/shared/cache/redisCache");
const cacheKeys = require("../../src/shared/cache/cacheKeys");
const { appSettings } = require("../../src/shared/config/appSettings");
const {
  buildRaceProgressPageProjection,
  publishRaceProgressPageProjection,
  readRaceProgressPageProjection,
} = require("../../src/modules/races/services/raceProgressPageProjection");

const PAGE_SIZE = 50;
const FEATURES = "characters,powerups3,powerups4,powerups5,remote_assets";

let server;
let liveRedis;
let probe;
let nextId = 0;

async function enableRedis() {
  if (!liveRedis) return false;
  process.env.REDIS_URL = liveRedis.url;
  process.env.CACHE_ENV_PREFIX = "t:";
  await redisCache.close();
  if (!probe) {
    const IORedis = require("ioredis");
    probe = new IORedis(liveRedis.url);
  }
  await probe.flushdb();
  return true;
}

async function disableRedis() {
  delete process.env.REDIS_URL;
  await redisCache.close();
}

async function createActiveRace(size, { timezone = "UTC" } = {}) {
  const users = [];
  for (let i = 0; i < size; i += 1) {
    users.push(await createTestUser({
      appleId: `page-projection-${++nextId}-${i}`,
      email: `page-projection-${nextId}-${i}@example.com`,
      displayName: `Runner ${i}`,
    }));
  }
  const startedAt = new Date(Date.now() - 60 * 60 * 1000);
  const race = await prisma.race.create({
    data: {
      creatorId: users[0].user.id,
      name: "Weekly projection fixture",
      targetSteps: 50000,
      status: "ACTIVE",
      maxDurationDays: 7,
      maxParticipants: size,
      startedAt,
      endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      timezone,
      powerupsEnabled: false,
      isPublic: true,
    },
  });
  const participants = await prisma.raceParticipant.createMany({
    data: users.map((user, index) => ({
      raceId: race.id,
      userId: user.user.id,
      status: "ACCEPTED",
      joinedAt: new Date(startedAt.getTime() + index),
      totalSteps: size - index,
      rawSteps: size - index,
    })),
  });
  assert.equal(participants.count, size);
  return { race, users };
}

async function projectionFixture(raceId, users, generation = 1) {
  const sourceParticipants = users.map((user, index) => ({
    id: `participant-${index}`,
    userId: user.user.id,
    status: "ACCEPTED",
    joinedAt: new Date(Date.now() + index),
    totalSteps: users.length - index,
    rawSteps: users.length - index,
    finishedAt: null,
    forfeitedAt: null,
    placement: index + 1,
    team: null,
  }));
  const snapshot = buildRaceProgressPageProjection({
    raceId,
    generation,
    scoringTimeZone: "UTC",
    asOf: new Date().toISOString(),
    race: {
      raceId,
      status: "ACTIVE",
      endsAt: new Date(Date.now() + 60_000).toISOString(),
      maxDurationDays: 7,
      targetSteps: 50_000,
      isTeamRace: false,
      teamSize: null,
      winnerTeam: null,
      powerupsEnabled: false,
      powerupStepInterval: null,
    },
    // Deliberately mirror the production race read's joinedAt ordering. The
    // projection producer must re-establish canonical placement order itself.
    participants: sourceParticipants.slice().reverse().map((participant) => ({
      participantId: participant.id,
      userId: participant.userId,
      totalSteps: participant.totalSteps,
      finishedAt: null,
      forfeitedAt: null,
      team: null,
      placement: participant.placement,
      currentMultiplier: 1,
      baseAdjusted: participant.rawSteps,
    })),
    sourceParticipants,
  });
  return { snapshot, sourceParticipants };
}

async function publishFixture(raceId, users, generation = 1, currentGeneration = generation) {
  const { snapshot } = await projectionFixture(raceId, users, generation);
  return publishRaceProgressPageProjection({
    raceId,
    generation,
    snapshot,
    currentGeneration: async () => currentGeneration,
  });
}

async function readProgress(user, raceId, query = "offset=0&limit=15") {
  return request(server.baseUrl, "GET", `/races/${raceId}/progress?view=participants-v1&${query}`, {
    token: user.token,
    headers: {
      "X-App-Version": "99.0.0",
      "X-Client-Features": FEATURES,
      "X-Timezone": "UTC",
    },
  });
}

describe("weekly race page projection", () => {
  before(async () => {
    server = await getSharedServer();
    liveRedis = await startTestRedis();
  });

  after(async () => {
    await disableRedis();
    await probe?.quit().catch(() => {});
    await liveRedis?.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await appSettings.setFlag("redisStandingsEnabled", true);
    appSettings.bustCache();
    require("../../src/modules/races/services/raceProgressPageProjection").__resetCounters();
    if (liveRedis) await enableRedis();
  });

  it("reads only bounded chunks and returns exact pagination for a 500-participant page", async (t) => {
    if (!liveRedis) return t.skip("no local Redis available");
    const { race, users } = await createActiveRace(500);
    assert.equal(await publishFixture(race.id, users), true);

    const response = await readProgress(users[0], race.id);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.progress.participants.length, 15);
    assert.equal(body.progress.pagination.total, 500);
    assert.equal(body.progress.projectionSource, "authoritative");
    assert.equal(body.progress.participants[0].placement, 1);
    assert.equal(body.progress.participants[14].placement, 15);
    assert.equal(require("../../src/modules/races/services/raceProgressPageProjection").__counters.chunkReads, 1);

    const keys = await probe.keys("t:v1:race:progress:*");
    assert.ok(keys.some((key) => key.includes(":index:")));
    assert.ok(keys.some((key) => key.includes(":page:") && key.endsWith(":0")));
    assert.ok(keys.some((key) => key.includes(":page:") && key.endsWith(":9")));
    assert.equal(PAGE_SIZE, 50);
  });

  it("keeps the requester overlay when the requester is outside the visible page", async (t) => {
    if (!liveRedis) return t.skip("no local Redis available");
    const { race, users } = await createActiveRace(500);
    assert.equal(await publishFixture(race.id, users), true);

    const response = await readProgress(users[499], race.id);
    assert.equal(response.status, 200);
    const progress = (await response.json()).progress;
    assert.equal(progress.participants.length, 15);
    assert.equal(progress.participants.some((row) => row.userId === users[499].user.id), false);
    assert.equal(progress.myPlacement, 500);
  });

  it("rejects a mixed-generation page before exposing it", async (t) => {
    if (!liveRedis) return t.skip("no local Redis available");
    const { race, users } = await createActiveRace(60);
    assert.equal(await publishFixture(race.id, users, 2), true);
    const old = await projectionFixture(race.id, users, 1);
    await redisCache.setJSON(
      cacheKeys.raceProgressPage(race.id, 2, 0),
      { ...old.snapshot.chunks[0], generation: 1 },
      60,
    );
    const read = await readRaceProgressPageProjection({
      raceId: race.id,
      offset: 0,
      limit: 15,
      requesterUserId: users[0].user.id,
    });
    assert.equal(read, null);
  });

  it("does not publish an old generation", async (t) => {
    if (!liveRedis) return t.skip("no local Redis available");
    const { race, users } = await createActiveRace(60);
    assert.equal(await publishFixture(race.id, users, 2), true);
    assert.equal(await publishFixture(race.id, users, 1, 2), false);
    const index = await redisCache.getJSON(cacheKeys.raceProgressIndex(race.id));
    assert.equal(index.generation, 2);
  });

  it("uses the legacy path for null-timezone races", async () => {
    await disableRedis();
    const { race, users } = await createActiveRace(3, { timezone: null });
    const response = await readProgress(users[0], race.id);
    assert.equal(response.status, 200);
    const progress = (await response.json()).progress;
    assert.equal(progress.projectionSource, "legacy");
    assert.equal(progress.participants.length, 3);
  });

  it("falls back safely when Redis is unavailable", async () => {
    if (!liveRedis) return;
    // An unset Redis URL is the production-safe loss mode and avoids leaving a
    // reconnecting ioredis client alive after this case switches environments.
    // The cache wrapper's live Redis tests separately cover configured/down.
    delete process.env.REDIS_URL;
    await redisCache.close();
    const { race, users } = await createActiveRace(3);
    const response = await readProgress(users[0], race.id);
    assert.equal(response.status, 200);
    const progress = (await response.json()).progress;
    assert.equal(progress.projectionSource, "stale-fallback");
    assert.equal(progress.participants.length, 3);
  });
});
