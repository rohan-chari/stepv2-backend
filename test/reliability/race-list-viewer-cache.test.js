process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
process.env.REDIS_URL = process.env.REDIS_TEST_URL || "redis://127.0.0.1:6402";
process.env.CACHE_ENV_PREFIX = "t:race-list-viewer-cache:";

const assert = require("node:assert/strict");
const { before, after, beforeEach, describe, it } = require("node:test");
const IORedis = require("ioredis");
const { cleanDatabase, prisma, request, getSharedServer, createTestUser, disconnectDatabase } = require("./setup");

let server;
let redis;
let queries;

prisma.$on("query", (event) => {
  if (queries) queries.push(event.query);
});

async function createRace(owner, overrides = {}) {
  const response = await request(server.baseUrl, "POST", "/races", {
    token: owner.token,
    body: {
      name: overrides.name || "Race list cache",
      targetSteps: 50000,
      maxDurationDays: 7,
      ...overrides,
    },
  });
  assert.equal(response.status, 201);
  return (await response.json()).race;
}

async function races(user) {
  const response = await request(server.baseUrl, "GET", "/races", { token: user.token });
  assert.equal(response.status, 200);
  return response.json();
}

async function discovery(user) {
  const response = await request(server.baseUrl, "GET", "/races/discovery-summary", { token: user.token });
  assert.equal(response.status, 200);
  return response.json();
}

describe("Races tab viewer and public-count caches", () => {
  before(async () => {
    server = await getSharedServer();
    redis = new IORedis(process.env.REDIS_URL);
  });

  beforeEach(async () => {
    queries = null;
    await cleanDatabase();
    const keys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}*`);
    if (keys.length) await redis.del(...keys);
  });

  after(async () => {
    queries = null;
    await redis.quit();
    await server.close();
    await disconnectDatabase();
  });

  it("caches the viewer overlay and podium while preserving the response", async () => {
    const owner = await createTestUser({ displayName: "Overlay owner" });
    const member = await createTestUser({ displayName: "Overlay member" });
    const race = await createRace(owner);
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: member.user.id, status: "ACCEPTED" },
    });
    await prisma.race.update({
      where: { id: race.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: owner.user.id } },
      data: { placement: 1, payoutCoins: 100 },
    });
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: member.user.id } },
      data: { placement: 2, payoutCoins: 50 },
    });
    const first = await races(owner);
    const firstCompleted = first.completed.find((row) => row.id === race.id);
    assert.equal(firstCompleted.myStatus, "ACCEPTED");
    assert.equal(firstCompleted.myPlacement, 1);
    assert.equal(firstCompleted.podium.length, 2);

    const overlayKeys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}*race-list:viewer*`);
    const podiumKeys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}*race-list:podium*`);
    assert.equal(overlayKeys.length, 1, "viewer overlay should be written");
    assert.equal(podiumKeys.length, 1, "podium should be written");

    queries = [];
    const second = await races(owner);
    const secondCompleted = second.completed.find((row) => row.id === race.id);
    assert.deepEqual(secondCompleted, firstCompleted);
    assert.equal(
      queries.some((query) => query.includes("placement") && query.includes("race_participants")),
      false,
      "warm list must not reload viewer/podium rows",
    );
  });

  it("invalidates the viewer overlay after a favorite write", async () => {
    const owner = await createTestUser({ displayName: "Favorite owner" });
    const race = await createRace(owner);
    const first = await races(owner);
    assert.equal(first.pending.find((row) => row.id === race.id).isFavorite, false);

    const favorite = await request(server.baseUrl, "PUT", `/races/${race.id}/favorite`, {
      token: owner.token,
      body: { favorite: true },
    });
    assert.equal(favorite.status, 200);
    const refreshed = await races(owner);
    assert.equal(refreshed.pending.find((row) => row.id === race.id).isFavorite, true);
  });

  it("refreshes a podium when its generation changes and rewrites the warm key", async () => {
    const owner = await createTestUser({ displayName: "Podium owner" });
    const member = await createTestUser({ displayName: "Podium member" });
    const race = await createRace(owner);
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: member.user.id, status: "ACCEPTED" },
    });
    await prisma.race.update({ where: { id: race.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    const RaceParticipant = require("../../src/modules/races/models/raceParticipant").RaceParticipant;
    await RaceParticipant.update(
      (await prisma.raceParticipant.findUnique({ where: { raceId_userId: { raceId: race.id, userId: owner.user.id } } })).id,
      { placement: 1 },
    );
    await RaceParticipant.update(
      (await prisma.raceParticipant.findUnique({ where: { raceId_userId: { raceId: race.id, userId: member.user.id } } })).id,
      { placement: 2 },
    );
    const first = await races(owner);
    assert.deepEqual(first.completed.find((row) => row.id === race.id).podium.map((row) => row.placement), [1, 2]);
    await RaceParticipant.update(
      (await prisma.raceParticipant.findUnique({ where: { raceId_userId: { raceId: race.id, userId: member.user.id } } })).id,
      { placement: 1 },
    );
    await RaceParticipant.update(
      (await prisma.raceParticipant.findUnique({ where: { raceId_userId: { raceId: race.id, userId: owner.user.id } } })).id,
      { placement: 2 },
    );
    const refreshed = await races(owner);
    assert.deepEqual(refreshed.completed.find((row) => row.id === race.id).podium.map((row) => row.placement), [1, 2]);
    queries = [];
    await races(owner);
    assert.equal(queries.some((query) => query.includes("placement") && query.includes("race_participants")), false);
  });

  it("caches the viewer-aware public badge count for 60 seconds", async () => {
    const owner = await createTestUser({ displayName: "Count owner" });
    const other = await createTestUser({ displayName: "Count other" });
    await createRace(owner, { isPublic: true });

    const first = await discovery(owner);
    const keys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}*public-race-count*tt0*`);
    assert.equal(keys.length, 1, "public count should be written");
    const ttl = await redis.ttl(keys[0]);
    assert.ok(ttl >= 59 && ttl <= 60, `expected 60 second TTL, got ${ttl}`);

    queries = [];
    const second = await discovery(owner);
    assert.equal(second.publicRaceCount, first.publicRaceCount);
    assert.equal(
      queries.some((query) => query.includes("FROM \"public\".\"races\"")),
      false,
      JSON.stringify(queries),
    );

    await discovery(other);
    const otherKeys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}*public-race-count*tt0*`);
    assert.equal(otherKeys.length, 2, "public count must be isolated by viewer");
  });
});
