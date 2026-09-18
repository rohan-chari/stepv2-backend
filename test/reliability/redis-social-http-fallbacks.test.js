const assert = require("node:assert/strict");
const { after, before, describe, it } = require("node:test");
const IORedis = require("ioredis");

const ENV_PREFIX = "t:social-fallbacks:";
process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
delete process.env.REDIS_URL;

const { prisma, cleanDatabase, createTestUser, request, startServer } = require("./setup");
const { startTestRedis } = require("./redisTestServer");
const { buildGetLeaderboard } = require("../../src/modules/leaderboard/getLeaderboard");
const redisCache = require("../../src/shared/cache/redisCache");
const derivedCache = require("../../src/shared/cache/derivedCache");
const cacheKeys = require("../../src/shared/cache/cacheKeys");
const { appSettings } = require("../../src/shared/config/appSettings");

const CACHE_FLAGS = [
  "redisPresentationGenerationGuardEnabled",
  "redisCacheFriendsEnabled",
];

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

describe("social read cache injected failure fallbacks over real HTTP", () => {
  let server;
  let cacheServer;
  let live;
  let probe;

  before(async () => {
    live = await startTestRedis();
    assert.ok(live, "redis-server is required for cache failure integration tests");
    process.env.REDIS_URL = live.url;
    await redisCache.close();
    probe = new IORedis(live.url);
    server = await startServer({
      verifyAppleIdentityToken: async (token) => ({ sub: token, email: `${token}@example.com` }),
      appSettings: { getFlag: async (key) => key !== "redisFriendSearchRateLimitEnabled" },
      getLeaderboard: buildGetLeaderboard({
        appSettings: { getFlag: async () => true },
        leaderboardEligibilityEpoch: { get: async () => { throw new Error("epoch unavailable"); } },
        stepLeaderboardCache: { getOrLoad: async () => { throw new Error("ranking cache must not be touched"); } },
        friendsTopologyCache: { get: async () => { throw new Error("topology must not be touched"); } },
      }),
    });
    cacheServer = await startServer();
  });

  after(async () => {
    await prisma.appSetting.deleteMany({ where: { key: { in: CACHE_FLAGS } } });
    appSettings.bustCache();
    await server?.close();
    await cacheServer?.close();
    delete process.env.REDIS_URL;
    await redisCache.close();
    derivedCache.reset();
    await probe?.quit().catch(() => {});
    await live?.close();
  });

  async function prepareRealCache() {
    await cleanDatabase();
    await prisma.appSetting.deleteMany({ where: { key: { in: CACHE_FLAGS } } });
    for (const key of CACHE_FLAGS) {
      await prisma.appSetting.create({ data: { key, value: true } });
    }
    appSettings.bustCache();
    process.env.REDIS_URL = live.url;
    process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
    await redisCache.close();
    derivedCache.reset();
    await probe.flushdb();
  }

  it("epoch read failure cannot select a warm epoch-0 core and takes complete legacy HTTP path", async () => {
    await cleanDatabase();
    const viewer = await createTestUser({ displayName: "Viewer" });
    await prisma.step.create({
      data: { userId: viewer.user.id, date: new Date(), steps: 4321 },
    });
    const response = await request(
      server.baseUrl,
      "GET",
      "/leaderboard?type=steps&period=allTime&scope=global",
      { token: viewer.token }
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.currentUser.totalSteps, 4321);
    assert.equal(body.top100[0].userId, viewer.user.id);
  });

  it("failed topology invalidation opens the viewer bypass until retry succeeds", async () => {
    await prepareRealCache();
    const a = await createTestUser({ displayName: "A" });
    const b = await createTestUser({ displayName: "B" });
    let page = await request(cacheServer.baseUrl, "GET", "/friends", { token: b.token });
    assert.deepEqual(await page.json(), { friends: [], pending: { incoming: [], outgoing: [] } });

    const payloadKey = cacheKeys.userFriends(b.user.id);
    const generationKey = cacheKeys.userFriendsVersion(b.user.id);
    assert.ok(await probe.get(`${ENV_PREFIX}${payloadKey}`), "real stale topology was warmed");

    const originalEvalLua = redisCache.evalLua;
    let failuresRemaining = 2;
    redisCache.evalLua = async (script, keys, args) => {
      if (keys.includes(generationKey) && failuresRemaining > 0) {
        failuresRemaining -= 1;
        return { ok: false, disabled: false, result: null };
      }
      return originalEvalLua(script, keys, args);
    };
    try {
      const sent = await request(cacheServer.baseUrl, "POST", "/friends/request", {
        token: a.token, body: { addresseeId: b.user.id },
      });
      assert.equal(sent.status, 201);
      assert.equal(failuresRemaining, 0, "both production inline invalidation attempts failed");
      assert.equal(derivedCache.isBypassed(payloadKey), true);

      page = await request(cacheServer.baseUrl, "GET", "/friends", { token: b.token });
      assert.equal((await page.json()).pending.incoming.length, 1,
        "real open breaker bypasses the warmed stale topology");

      await waitFor(() => !derivedCache.isBypassed(payloadKey),
        "production background retry did not close topology bypass");
      assert.equal(await probe.get(`${ENV_PREFIX}${payloadKey}`), null,
        "successful retry deletes the stale payload before closing bypass");
      page = await request(cacheServer.baseUrl, "GET", "/friends", { token: b.token });
      assert.equal((await page.json()).pending.incoming.length, 1);
      assert.ok(await probe.get(`${ENV_PREFIX}${payloadKey}`), "current topology rebuilt after retry");
    } finally {
      redisCache.evalLua = originalEvalLua;
    }
  });

  it("failed presentation invalidation bypasses a stale identity until retry succeeds", async () => {
    await prepareRealCache();
    const viewer = await createTestUser({ displayName: "Viewer" });
    const friend = await createTestUser({ displayName: "Before" });
    await prisma.friendship.create({
      data: { requesterId: viewer.user.id, addresseeId: friend.user.id, status: "ACCEPTED" },
    });
    let page = await request(cacheServer.baseUrl, "GET", "/friends", { token: viewer.token });
    assert.equal((await page.json()).friends[0].displayName, "Before");

    const payloadKey = cacheKeys.userCosmetics(friend.user.id);
    const generationKey = cacheKeys.userCosmeticsVersion(friend.user.id);
    assert.ok(await probe.get(`${ENV_PREFIX}${payloadKey}`), "real stale presentation was warmed");

    const originalEvalLua = redisCache.evalLua;
    let failuresRemaining = 2;
    redisCache.evalLua = async (script, keys, args) => {
      if (keys.includes(generationKey) && failuresRemaining > 0) {
        failuresRemaining -= 1;
        return { ok: false, disabled: false, result: null };
      }
      return originalEvalLua(script, keys, args);
    };
    try {
      const renamed = await request(cacheServer.baseUrl, "PUT", "/auth/me/display-name", {
        token: friend.token, body: { displayName: "After" },
      });
      assert.equal(renamed.status, 200);
      assert.equal(failuresRemaining, 0, "both production inline invalidation attempts failed");
      assert.equal(derivedCache.isBypassed(payloadKey), true);

      page = await request(cacheServer.baseUrl, "GET", "/friends", { token: viewer.token });
      assert.equal((await page.json()).friends[0].displayName, "After");

      await waitFor(() => !derivedCache.isBypassed(payloadKey),
        "production background retry did not close presentation bypass");
      assert.equal(await probe.get(`${ENV_PREFIX}${payloadKey}`), null,
        "successful retry deletes stale presentation before closing bypass");
      page = await request(cacheServer.baseUrl, "GET", "/friends", { token: viewer.token });
      assert.equal((await page.json()).friends[0].displayName, "After");
      assert.ok(await probe.get(`${ENV_PREFIX}${payloadKey}`), "current presentation rebuilt after retry");
    } finally {
      redisCache.evalLua = originalEvalLua;
    }
  });

  it("friends HTTP response remains one RepeatableRead snapshot across a concurrent step commit", async () => {
    await cleanDatabase();
    const viewer = await createTestUser({ displayName: "Review Viewer", isReviewAccount: true });
    const friend = await createTestUser({ displayName: "Friend" });
    await prisma.friendship.create({
      data: { requesterId: viewer.user.id, addresseeId: friend.user.id, status: "ACCEPTED" },
    });
    const viewerStep = await prisma.step.create({
      data: { userId: viewer.user.id, date: new Date(), steps: 100 },
    });
    await prisma.step.create({ data: { userId: friend.user.id, date: new Date(), steps: 200 } });

    const groupFinished = deferred();
    const allowAggregate = deferred();
    const db = new Proxy(prisma, {
      get(target, property) {
        if (property !== "$transaction") {
          const value = target[property];
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (callback, options) => target.$transaction(async (tx) => {
          const step = new Proxy(tx.step, {
            get(stepTarget, operation) {
              if (operation === "groupBy") return async (args) => {
                const result = await stepTarget.groupBy(args);
                groupFinished.resolve();
                return result;
              };
              if (operation === "aggregate") return async (args) => {
                await allowAggregate.promise;
                return stepTarget.aggregate(args);
              };
              const value = stepTarget[operation];
              return typeof value === "function" ? value.bind(stepTarget) : value;
            },
          });
          return callback(new Proxy(tx, { get: (txTarget, prop) => prop === "step" ? step : txTarget[prop] }));
        }, options);
      },
    });
    const query = buildGetLeaderboard({
      prisma: db,
      appSettings: { getFlag: async () => true },
      leaderboardEligibilityEpoch: { get: async () => 0 },
      friendsTopologyCache: { get: async () => ({
        accepted: [{ friendshipId: "f", userId: friend.user.id }], incoming: [], outgoing: [],
      }) },
      stepLeaderboardCache: { getOrLoad: async ({ load }) => load() },
      userPresentationCache: { getMany: async (ids) => {
        const rows = await prisma.user.findMany({ where: { id: { in: ids } } });
        return new Map(rows.map((row) => [row.id, {
          id: row.id, displayName: row.displayName, profilePhotoUrl: row.profilePhotoUrl,
          equippedAccessories: [], clientFeatures: [],
          isReviewAccount: row.isReviewAccount, hiddenFromLeaderboard: row.hiddenFromLeaderboard,
        }]));
      } },
    });
    const snapshotServer = await startServer({ prisma: db, getLeaderboard: query });
    try {
      const pending = request(
        snapshotServer.baseUrl, "GET",
        "/leaderboard?type=steps&period=allTime&scope=friends",
        { token: viewer.token }
      );
      await groupFinished.promise;
      await prisma.step.update({ where: { id: viewerStep.id }, data: { steps: 1000 } });
      allowAggregate.resolve();
      const response = await pending;
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.currentUser.totalSteps, 100);
      assert.equal(body.currentUser.rank, 2);
      assert.equal(body.top100[0].totalSteps, 200);
    } finally {
      allowAggregate.resolve();
      await snapshotServer.close();
    }
  });
});
