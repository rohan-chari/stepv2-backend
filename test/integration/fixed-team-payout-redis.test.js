const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");
const IORedis = require("ioredis");

const ENV_PREFIX = "fixed-team:";
process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
delete process.env.REDIS_URL;

const { startTestRedis, TEST_DB } = require("./redisTestServer");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const cache = require("../../src/shared/cache/redisCache");
const derivedCache = require("../../src/shared/cache/derivedCache");
const { appSettings } = require("../../src/shared/config/appSettings");

const TEAM_HEADERS = { "X-Client-Features": "characters,team_races" };
let server;
let live;
let probe;
let skipReason;

async function enableRedis() {
  process.env.REDIS_URL = live.url;
  process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
  await cache.close();
  derivedCache.reset();
  probe ||= new IORedis(live.url);
  await probe.flushdb();
}

async function disableRedis() {
  delete process.env.REDIS_URL;
  await cache.close();
  derivedCache.reset();
}

before(async () => {
  server = await getSharedServer();
  live = await startTestRedis();
  if (!live) {
    skipReason = "no local Redis available";
  }
});

beforeEach(async () => {
  await cleanDatabase();
  await appSettings.setFlag("fundedPrizePoolsEnabled", true);
  await appSettings.setFlag("teamRacesEnabled", true);
  await appSettings.setFlag("redisCacheRaceListEnabled", true);
  await appSettings.setFlag("raceListSqlSummaryV1Enabled", true);
});

after(async () => {
  await disableRedis();
  await appSettings.setFlag("redisCacheRaceListEnabled", true);
  await appSettings.setFlag("raceListSqlSummaryV1Enabled", true);
  if (probe) await probe.quit().catch(() => {});
  if (live) await live.close();
});

describe("fixed team payout Redis race-list contract", () => {
  it("preserves V1 stamps and amounts on a real DB15 hit and with Redis unset", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await enableRedis();
    assert.equal(Number(probe.options.db), TEST_DB);
    const { token } = await createTestUser({
      appleId: `fixed-team-redis-${Date.now()}`,
    });
    await request(server.baseUrl, "GET", "/auth/me", {
      token,
      headers: TEAM_HEADERS,
    });
    const created = await request(server.baseUrl, "POST", "/races", {
      token,
      headers: TEAM_HEADERS,
      body: {
        name: "Fixed Redis parity",
        maxDurationDays: 7,
        isTeamRace: true,
        teamSize: 5,
        isPublic: true,
      },
    });
    assert.equal(created.status, 201);
    const raceId = (await created.json()).race.id;

    const cold = await request(server.baseUrl, "GET", "/races", {
      token,
      headers: TEAM_HEADERS,
    });
    assert.equal(cold.status, 200);
    const coldRace = (await cold.json()).pending.find((race) => race.id === raceId);
    assert.equal(coldRace.teamPayoutVersion, 1);
    assert.equal(coldRace.teamWinnerRewardCoins, 500);
    assert.equal(coldRace.prizePool.coins, 500);

    const raceListKeys = await probe.keys(`${ENV_PREFIX}v1:user:races:*`);
    assert.ok(raceListKeys.length >= 3, "cold read installs DB15 race-list fragments");
    const cachedFragments = (await Promise.all(
      raceListKeys.map(async (key) => {
        const raw = await probe.get(key);
        return raw ? JSON.parse(raw) : null;
      }),
    )).filter((value) => Array.isArray(value?.races));
    const cachedRace = cachedFragments
      .flatMap((fragment) => fragment.races)
      .find((race) => race.id === raceId);
    assert.equal(cachedRace.teamPayoutVersion, 1);
    assert.equal(cachedRace.teamWinnerRewardCoins, 500);

    // Deliberately bypass domain invalidation to prove the second HTTP read is
    // served from the installed Redis fragment, including both additive keys.
    await prisma.race.update({
      where: { id: raceId },
      data: { teamPayoutVersion: null, teamWinnerRewardCoins: null },
    });
    const warm = await request(server.baseUrl, "GET", "/races", {
      token,
      headers: TEAM_HEADERS,
    });
    const warmRace = (await warm.json()).pending.find((race) => race.id === raceId);
    assert.equal(warmRace.teamPayoutVersion, 1);
    assert.equal(warmRace.teamWinnerRewardCoins, 500);
    assert.equal(warmRace.prizePool.coins, 500);

    await disableRedis();
    await prisma.race.update({
      where: { id: raceId },
      data: { teamPayoutVersion: 1, teamWinnerRewardCoins: 500 },
    });
    const redisUnset = await request(server.baseUrl, "GET", "/races", {
      token,
      headers: TEAM_HEADERS,
    });
    const postgresRace = (await redisUnset.json()).pending.find(
      (race) => race.id === raceId,
    );
    assert.equal(postgresRace.teamPayoutVersion, 1);
    assert.equal(postgresRace.teamWinnerRewardCoins, 500);
    assert.equal(postgresRace.prizePool.coins, 500);
  });
});
