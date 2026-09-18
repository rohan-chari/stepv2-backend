// Social read-cache contract tests. These deliberately use real HTTP, the real
// handler chain, a disposable integration Postgres, and disposable Redis.
// Public request/response shapes are pinned before any cache implementation.
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const IORedis = require("ioredis");

const ENV_PREFIX = "t:";
process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
delete process.env.REDIS_URL;

const { startTestRedis, closedPort } = require("./redisTestServer");
const {
  cleanDatabase,
  prisma,
  request,
  createTestUser,
  getSharedServer,
} = require("./setup");
const redisCache = require("../../src/shared/cache/redisCache");
const derivedCache = require("../../src/shared/cache/derivedCache");
const { appSettings } = require("../../src/shared/config/appSettings");

const FLAGS = [
  "redisPresentationGenerationGuardEnabled",
  "redisCacheLeaderboardEnabled",
  "redisCacheFriendsEnabled",
  "redisFriendSearchRateLimitEnabled",
];
const OWNED_SETTINGS = [...FLAGS, "leaderboardEligibilityEpoch", "quickRaceShareAutoFriendEnabled", "quickCreateRaceCtaEnabled", "fundedPrizePoolsEnabled"];

let server;
let live;
let probe;

function todayNewYork() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function setFlags(enabled) {
  for (const key of FLAGS) {
    await appSettings.setFlag(key, enabled);
  }
  appSettings.bustCache();
}

async function setFlagValues(values) {
  for (const key of FLAGS) {
    const value = values[key] ?? false;
    await prisma.appSetting.upsert({
      where: { key }, update: { value }, create: { key, value },
    });
  }
  appSettings.bustCache();
}

async function getFriends(account) {
  const response = await request(server.baseUrl, "GET", "/friends", {
    token: account.token,
    headers: { "X-Client-Features": "characters,remote_assets,team_races" },
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function seedPublicState() {
  const alice = await createTestUser({
    appleId: `social-cache-alice-${Date.now()}`,
    email: `social-cache-alice-${Date.now()}@example.com`,
    displayName: "Alice",
    firstName: "Alice",
    lastName: "River",
    discoverableNameSearch: "alice river",
    nameSetupCompletedAt: new Date(),
  });
  const bob = await createTestUser({
    appleId: `social-cache-bob-${Date.now()}`,
    email: `social-cache-bob-${Date.now()}@example.com`,
    displayName: "Bob",
    firstName: "Bob",
    lastName: "River",
    discoverableNameSearch: "bob river",
    nameSetupCompletedAt: new Date(),
  });
  // The checked-in Prisma client can lag the additive String[] field during a
  // test-first run; use the authoritative column directly for this fixture.
  await prisma.$executeRaw`
    UPDATE users SET client_features = ARRAY['characters', 'team_races']::text[]
    WHERE id IN (${alice.user.id}, ${bob.user.id})
  `;
  const friendship = await prisma.friendship.create({
    data: {
      requesterId: alice.user.id,
      addresseeId: bob.user.id,
      status: "ACCEPTED",
    },
  });
  await prisma.step.createMany({
    data: [
      { userId: alice.user.id, date: new Date(todayNewYork()), steps: 5000 },
      { userId: bob.user.id, date: new Date(todayNewYork()), steps: 8000 },
    ],
  });
  return { alice, bob, friendship };
}

async function readPublicSurfaces(token) {
  const headers = {
    "X-Timezone": "America/New_York",
    "X-Client-Features": "characters,remote_assets,team_races",
  };
  const leaderboard = await request(
    server.baseUrl,
    "GET",
    "/leaderboard?type=steps&period=today&scope=friends",
    { token, headers }
  );
  const friends = await request(server.baseUrl, "GET", "/friends", {
    token,
    headers,
  });
  const search = await request(server.baseUrl, "POST", "/friends/search", {
    token,
    headers,
    body: { q: "river" },
  });
  assert.equal(leaderboard.status, 200);
  assert.equal(friends.status, 200);
  assert.equal(search.status, 200);
  return {
    leaderboard: await leaderboard.json(),
    friends: await friends.json(),
    search: await search.json(),
  };
}

before(async () => {
  server = await getSharedServer();
  live = await startTestRedis();
  assert.ok(live, "redis-server is required for this integration suite");
  probe = new IORedis(live.url);
});

after(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: OWNED_SETTINGS } } });
  appSettings.bustCache();
  delete process.env.REDIS_URL;
  await redisCache.close();
  derivedCache.reset();
  if (probe) await probe.quit().catch(() => {});
  if (live) await live.close();
});

beforeEach(async () => {
  await cleanDatabase();
  await prisma.appSetting.deleteMany({ where: { key: { in: OWNED_SETTINGS } } });
  process.env.REDIS_URL = live.url;
  process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
  await redisCache.close();
  derivedCache.reset();
  await probe.flushdb();
});

describe("social read caches preserve the frozen-client HTTP contract", () => {
  it("flag-off reads use legacy Postgres paths and create no new surface keys", async () => {
    const { alice } = await seedPublicState();
    await setFlags(false);
    await readPublicSurfaces(alice.token);
    const keys = await probe.keys(`${ENV_PREFIX}v1:*`);
    assert.equal(keys.some((key) => key.includes(":leaderboard:steps:")), false);
    assert.equal(keys.some((key) => key.includes(":user:friends:")), false);
    assert.equal(keys.some((key) => key.includes(":user:friendsearchrate:")), false);
  });

  it("keeps public payloads deep-equal and stores only internal raw cache keys", async () => {
    const { alice, bob, friendship } = await seedPublicState();
    await setFlags(false);
    const uncached = await readPublicSurfaces(alice.token);

    assert.deepEqual(uncached.friends, {
      friends: [
        {
          id: bob.user.id,
          displayName: "Bob",
          profilePhotoUrl: null,
          animal: null,
          accessories: [],
          friendshipId: friendship.id,
          teamRaceEligible: true,
        },
      ],
      pending: { incoming: [], outgoing: [] },
    });
    assert.deepEqual(Object.keys(uncached.leaderboard).sort(), [
      "currentUser",
      "top10",
      "top100",
    ]);
    assert.deepEqual(Object.keys(uncached.search), ["users"]);

    await setFlags(true);
    const cachedCold = await readPublicSurfaces(alice.token);
    const cachedWarm = await readPublicSurfaces(alice.token);
    assert.deepEqual(cachedCold, uncached);
    assert.deepEqual(cachedWarm, uncached);

    const keys = (await probe.keys(`${ENV_PREFIX}v1:*`)).sort();
    assert.ok(
      keys.some((key) => key.includes(":leaderboard:steps:friends:")),
      `expected raw friends-ranking key; got ${JSON.stringify(keys)}`
    );
    assert.ok(
      keys.includes(`${ENV_PREFIX}v1:user:friends:${alice.user.id}`),
      `expected raw topology key; got ${JSON.stringify(keys)}`
    );
    assert.ok(
      keys.some((key) => key.includes(`:user:friendsearchrate:${alice.user.id}:`)),
      `expected Redis search-rate key; got ${JSON.stringify(keys)}`
    );
    assert.equal(keys.some((key) => key.includes("river")), false);
  });

  it("retains validation/status compatibility", async () => {
    const { alice } = await seedPublicState();
    await setFlags(true);

    const badScope = await request(
      server.baseUrl,
      "GET",
      "/leaderboard?type=steps&period=today&scope=unknown",
      { token: alice.token }
    );
    assert.equal(badScope.status, 400);

    const missingQuery = await request(
      server.baseUrl,
      "POST",
      "/friends/search",
      { token: alice.token, body: {} }
    );
    assert.equal(missingQuery.status, 400);
    assert.equal((await missingQuery.json()).code, "INVALID_SEARCH_QUERY");

    const unauthorized = await request(server.baseUrl, "GET", "/friends");
    assert.equal(unauthorized.status, 401);
  });

  it("a stale false generation-guard row cannot disable permanent caches", async () => {
    const { alice } = await seedPublicState();
    await setFlags(true);
    await setFlagValues({
      redisPresentationGenerationGuardEnabled: false,
      redisCacheFriendsEnabled: true,
      redisCacheLeaderboardEnabled: true,
    });
    await readPublicSurfaces(alice.token);
    const keys = await probe.keys(`${ENV_PREFIX}v1:*`);
    assert.equal(keys.some((key) => key.includes(":user:friends:")), true);
    assert.equal(keys.some((key) => key.includes(":leaderboard:steps:")), true);
  });

  it("invalidates both users' warm topology immediately after remove", async () => {
    const { alice, bob, friendship } = await seedPublicState();
    await setFlags(true);
    await readPublicSurfaces(alice.token);
    await readPublicSurfaces(bob.token);

    const removed = await request(
      server.baseUrl,
      "DELETE",
      `/friends/${friendship.id}`,
      { token: alice.token }
    );
    assert.equal(removed.status, 200);
    for (const account of [alice, bob]) {
      const response = await request(server.baseUrl, "GET", "/friends", {
        token: account.token,
        headers: { "X-Client-Features": "characters,team_races" },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        friends: [], pending: { incoming: [], outgoing: [] },
      });
    }
  });

  it("hydrates a warm topology with a renamed friend's current presentation", async () => {
    const { alice, bob } = await seedPublicState();
    await setFlags(true);
    const first = await request(server.baseUrl, "GET", "/friends", {
      token: alice.token,
      headers: { "X-Client-Features": "characters,team_races" },
    });
    assert.equal((await first.json()).friends[0].displayName, "Bob");
    const renamed = await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      token: bob.token,
      body: { displayName: "BobbyCurrent" },
    });
    assert.equal(renamed.status, 200);
    const second = await request(server.baseUrl, "GET", "/friends", {
      token: alice.token,
      headers: { "X-Client-Features": "characters,team_races" },
    });
    assert.equal((await second.json()).friends[0].displayName, "BobbyCurrent");
    assert.ok(await probe.get(`${ENV_PREFIX}v1:user:friends:${alice.user.id}`));
  });

  it("advances the durable eligibility epoch so a warm global core cannot expose a newly hidden user", async () => {
    const { alice, bob } = await seedPublicState();
    await setFlags(true);
    const path = "/leaderboard?type=steps&period=today&scope=global";
    const first = await request(server.baseUrl, "GET", path, {
      token: alice.token,
      headers: { "X-Timezone": "America/New_York" },
    });
    assert.ok((await first.json()).top100.some((row) => row.userId === bob.user.id));

    const hidden = await request(
      server.baseUrl,
      "PUT",
      "/auth/me/leaderboard-visibility",
      { token: bob.token, body: { hidden: true } }
    );
    assert.equal(hidden.status, 200);
    const epoch = await prisma.appSetting.findUnique({
      where: { key: "leaderboardEligibilityEpoch" },
    });
    assert.equal(epoch.value, 1);

    const second = await request(server.baseUrl, "GET", path, {
      token: alice.token,
      headers: { "X-Timezone": "America/New_York" },
    });
    assert.equal((await second.json()).top100.some((row) => row.userId === bob.user.id), false);
  });

  it("keeps a review-account viewer's unfiltered friends-board scalar byte-equal", async () => {
    const viewer = await createTestUser({ displayName: "Review Viewer", isReviewAccount: true });
    const friend = await createTestUser({ displayName: "Real Friend" });
    await prisma.friendship.create({
      data: { requesterId: viewer.user.id, addresseeId: friend.user.id, status: "ACCEPTED" },
    });
    await prisma.step.createMany({ data: [
      { userId: viewer.user.id, date: new Date(todayNewYork()), steps: 9000 },
      { userId: friend.user.id, date: new Date(todayNewYork()), steps: 5000 },
    ] });
    const path = "/leaderboard?type=steps&period=today&scope=friends";
    const options = { token: viewer.token, headers: { "X-Timezone": "America/New_York" } };
    await setFlags(false);
    const uncached = await request(server.baseUrl, "GET", path, options);
    assert.equal(uncached.status, 200);
    const expected = await uncached.json();
    assert.equal(expected.currentUser.totalSteps, 9000);
    await setFlags(true);
    const cached = await request(server.baseUrl, "GET", path, options);
    assert.equal(cached.status, 200);
    assert.deepEqual(await cached.json(), expected);
  });

  it("keeps an accepted review friend in the roster but out of both step boards", async () => {
    const viewer = await createTestUser({ displayName: "Viewer" });
    const review = await createTestUser({ displayName: "Review Friend", isReviewAccount: true });
    await prisma.friendship.create({
      data: { requesterId: viewer.user.id, addresseeId: review.user.id, status: "ACCEPTED" },
    });
    await prisma.step.createMany({ data: [
      { userId: viewer.user.id, date: new Date(todayNewYork()), steps: 1000 },
      { userId: review.user.id, date: new Date(todayNewYork()), steps: 9999 },
    ] });
    await setFlags(true);
    assert.equal((await getFriends(viewer)).friends[0].id, review.user.id);
    for (const scope of ["friends", "global"]) {
      const response = await request(
        server.baseUrl, "GET",
        `/leaderboard?type=steps&period=today&scope=${scope}`,
        { token: viewer.token, headers: { "X-Timezone": "America/New_York" } }
      );
      assert.equal(response.status, 200);
      assert.equal((await response.json()).top100.some((row) => row.userId === review.user.id), false);
    }
  });

  it("keeps a global viewer outside the top 100 on the legacy path without rebuilding the warm core", async () => {
    const viewer = await createTestUser({ displayName: "Outside Viewer" });
    const leader = await createTestUser({ displayName: "Leader" });
    const batch = `outside-${Date.now()}`;
    await prisma.user.createMany({
      data: Array.from({ length: 99 }, (_, index) => ({
        appleId: `${batch}-${index}`,
        email: `${batch}-${index}@example.com`,
        displayName: `Top ${index}`,
      })),
    });
    const others = await prisma.user.findMany({
      where: { appleId: { startsWith: batch } }, select: { id: true }, orderBy: { appleId: "asc" },
    });
    await prisma.step.createMany({ data: [
      { userId: leader.user.id, date: new Date(), steps: 20_000 },
      ...others.map((user, index) => ({ userId: user.id, date: new Date(), steps: 10_000 - index })),
      { userId: viewer.user.id, date: new Date(), steps: 1 },
    ] });
    const path = "/leaderboard?type=steps&period=allTime&scope=global";
    const options = { token: viewer.token };

    await setFlags(false);
    const legacy = await request(server.baseUrl, "GET", path, options);
    assert.equal(legacy.status, 200);
    const expected = await legacy.json();
    assert.equal(expected.currentUser.rank, 101);
    assert.equal(expected.currentUser.inTop100, false);

    await setFlags(true);
    const cold = await request(server.baseUrl, "GET", path, options);
    assert.deepEqual(await cold.json(), expected);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const [key] = await probe.keys(`${ENV_PREFIX}v1:leaderboard:steps:global:*`);
    assert.ok(key);
    const before = JSON.parse(await probe.get(key));

    await new Promise((resolve) => setTimeout(resolve, 10));
    const warm = await request(server.baseUrl, "GET", path, options);
    assert.deepEqual(await warm.json(), expected);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterWarmOutside = JSON.parse(await probe.get(key));
    assert.equal(afterWarmOutside.buildStartedAt, before.buildStartedAt,
      "legitimate outside-top-100 fallback must not launch a ranking rebuild");
  });

  it("keeps tied global ranks byte-equal with flags off, cold, and warm", async () => {
    const viewer = await createTestUser({ displayName: "Tie A" });
    const tied = await createTestUser({ displayName: "Tie B" });
    await prisma.step.createMany({ data: [
      { userId: viewer.user.id, date: new Date(), steps: 500 },
      { userId: tied.user.id, date: new Date(), steps: 500 },
    ] });
    const path = "/leaderboard?type=steps&period=allTime&scope=global";
    await setFlags(false);
    const legacy = await request(server.baseUrl, "GET", path, { token: viewer.token });
    const expected = await legacy.json();
    assert.deepEqual(expected.top100.map((row) => row.rank), [1, 1]);
    await setFlags(true);
    for (const phase of ["cold", "warm"]) {
      const response = await request(server.baseUrl, "GET", path, { token: viewer.token });
      assert.equal(response.status, 200, phase);
      assert.deepEqual(await response.json(), expected, phase);
    }
  });

  it("preserves absent-step versus stored-zero membership in cold and warm friends cores", async () => {
    const viewer = await createTestUser({ displayName: "Viewer" });
    const absent = await createTestUser({ displayName: "Absent" });
    const storedZero = await createTestUser({ displayName: "Stored Zero" });
    await prisma.friendship.createMany({ data: [
      { requesterId: viewer.user.id, addresseeId: absent.user.id, status: "ACCEPTED" },
      { requesterId: viewer.user.id, addresseeId: storedZero.user.id, status: "ACCEPTED" },
    ] });
    await prisma.step.createMany({ data: [
      { userId: viewer.user.id, date: new Date(), steps: 0 },
      { userId: storedZero.user.id, date: new Date(), steps: 0 },
    ] });
    const path = "/leaderboard?type=steps&period=allTime&scope=friends";
    await setFlags(false);
    const legacy = await request(server.baseUrl, "GET", path, { token: viewer.token });
    const expected = await legacy.json();
    assert.equal(expected.top100.some((row) => row.userId === storedZero.user.id), true);
    assert.equal(expected.top100.some((row) => row.userId === absent.user.id), false);
    await setFlags(true);
    for (const phase of ["cold", "warm"]) {
      const response = await request(server.baseUrl, "GET", path, { token: viewer.token });
      assert.equal(response.status, 200, phase);
      assert.deepEqual(await response.json(), expected, phase);
    }
  });

  it("keeps hidden accepted friends visible in friends-scope flag-off, cold, and warm parity", async () => {
    const viewer = await createTestUser({ displayName: "Viewer" });
    const hidden = await createTestUser({ displayName: "Hidden", hiddenFromLeaderboard: true });
    await prisma.friendship.create({
      data: { requesterId: viewer.user.id, addresseeId: hidden.user.id, status: "ACCEPTED" },
    });
    await prisma.step.createMany({ data: [
      { userId: viewer.user.id, date: new Date(), steps: 100 },
      { userId: hidden.user.id, date: new Date(), steps: 900 },
    ] });
    const path = "/leaderboard?type=steps&period=allTime&scope=friends";
    await setFlags(false);
    const legacy = await request(server.baseUrl, "GET", path, { token: viewer.token });
    const expected = await legacy.json();
    assert.equal(expected.top100[0].userId, hidden.user.id);
    await setFlags(true);
    for (const phase of ["cold", "warm"]) {
      const response = await request(server.baseUrl, "GET", path, { token: viewer.token });
      assert.equal(response.status, 200, phase);
      assert.deepEqual(await response.json(), expected, phase);
    }
  });

  it("warm modern presentation cannot leak character/remote/test-only assets to frozen clients", async () => {
    const { alice, bob } = await seedPublicState();
    const items = await Promise.all([
      prisma.shopItem.create({ data: { sku: `character-${Date.now()}`, name: "Test Character", slot: "CHARACTER", priceCoins: 0, assetKey: "test_character", testOnly: false } }),
      prisma.shopItem.create({ data: { sku: `remote-${Date.now()}`, name: "Remote Hat", slot: "HEAD", priceCoins: 0, assetKey: "remote_hat", assetVersion: "abcdef123456", remoteOnly: true } }),
      prisma.shopItem.create({ data: { sku: `test-only-${Date.now()}`, name: "Test-only Scarf", slot: "NECK", priceCoins: 0, assetKey: "test_only_scarf", testOnly: true } }),
    ]);
    await prisma.userEquippedAccessory.createMany({ data: [
      { userId: bob.user.id, shopItemId: items[0].id, slot: "CHARACTER" },
      { userId: bob.user.id, shopItemId: items[1].id, slot: "HEAD" },
      { userId: bob.user.id, shopItemId: items[2].id, slot: "NECK" },
    ] });
    await setFlags(true);
    const modern = await request(server.baseUrl, "GET", "/friends", {
      token: alice.token,
      headers: { "X-Client-Features": "characters,remote_assets", "X-Release-Channel": "testflight" },
    });
    const modernFriend = (await modern.json()).friends[0];
    assert.equal(modernFriend.animal, "test_character");
    assert.equal(modernFriend.accessories[0].assetKey, "remote_hat");
    assert.equal(modernFriend.accessories.some((item) => item.assetKey === "test_only_scarf"), false);

    const characterOnly = await request(server.baseUrl, "GET", "/friends", {
      token: alice.token,
      headers: { "X-Client-Features": "characters", "X-Release-Channel": "prod" },
    });
    const characterOnlyFriend = (await characterOnly.json()).friends[0];
    assert.equal(characterOnlyFriend.animal, "test_character");
    assert.deepEqual(characterOnlyFriend.accessories, [],
      "raw warm cache must still filter remote-only and test-only items per request");

    const frozen = await request(server.baseUrl, "GET", "/friends", { token: alice.token });
    const frozenFriend = (await frozen.json()).friends[0];
    assert.equal(frozenFriend.animal, null);
    assert.deepEqual(frozenFriend.accessories, []);
  });

  it("uses the Redis modern-search counter and preserves the 31st-request response", async () => {
    const { alice } = await seedPublicState();
    await setFlags(true);
    for (let i = 0; i < 30; i += 1) {
      const response = await request(server.baseUrl, "POST", "/friends/search", {
        token: alice.token,
        body: { q: "river" },
      });
      assert.equal(response.status, 200, `search ${i + 1}`);
    }
    const limited = await request(server.baseUrl, "POST", "/friends/search", {
      token: alice.token,
      body: { q: "river" },
    });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), {
      error: "Too many searches",
      code: "SEARCH_RATE_LIMITED",
    });
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    assert.equal(await prisma.friendSearchRateWindow.count(), 0);
  });

  it("falls back through the unchanged HTTP contract when Redis is unreachable", async () => {
    const { alice } = await seedPublicState();
    await setFlags(false);
    const legacy = await readPublicSurfaces(alice.token);
    await setFlags(true);
    delete process.env.REDIS_URL;
    await redisCache.close();
    derivedCache.reset();
    let started = Date.now();
    let direct = await request(
      server.baseUrl, "GET", "/leaderboard?type=steps&period=today&scope=global",
      { token: alice.token, headers: { "X-Timezone": "America/New_York" } }
    );
    let elapsedMs = Date.now() - started;
    assert.equal(direct.status, 200);
    assert.ok(elapsedMs < 400,
      `disabled Redis must skip the 500ms contention poll (elapsed ${elapsedMs}ms)`);

    const port = await closedPort();
    process.env.REDIS_URL = `redis://127.0.0.1:${port}/15`;
    await redisCache.close();
    derivedCache.reset();
    started = Date.now();
    direct = await request(
      server.baseUrl, "GET", "/leaderboard?type=steps&period=today&scope=global",
      { token: alice.token, headers: { "X-Timezone": "America/New_York" } }
    );
    elapsedMs = Date.now() - started;
    assert.equal(direct.status, 200);
    assert.equal((await direct.json()).currentUser.totalSteps, 5000);
    assert.ok(elapsedMs < 400,
      `Redis failure must skip the 500ms contention poll (elapsed ${elapsedMs}ms)`);
    const fallback = await readPublicSurfaces(alice.token);
    assert.deepEqual(fallback, legacy);
    assert.equal(await prisma.friendSearchRateWindow.count(), 1);
  });

  it("rejects poisoned topology and presentation generations/schemas as whole-value misses", async () => {
    const { alice, bob } = await seedPublicState();
    await setFlags(true);
    const expected = await getFriends(alice);
    const topologyKey = `${ENV_PREFIX}v1:user:friends:${alice.user.id}`;
    const topologyVersion = `${ENV_PREFIX}v1:user:friendsver:${alice.user.id}`;
    const presentationKey = `${ENV_PREFIX}v1:user:cosmetics:${bob.user.id}`;
    const presentationVersion = `${ENV_PREFIX}v1:user:cosmeticsver:${bob.user.id}`;

    for (const poisoned of [
      { generation: 1, accepted: [{ friendshipId: "duplicate", userId: bob.user.id }, { friendshipId: "duplicate", userId: bob.user.id }], incoming: [], outgoing: [] },
      { generation: 2, accepted: [], incoming: [], outgoing: [], extra: true },
      { generation: 3, accepted: "not-an-array", incoming: [], outgoing: [] },
      { generation: 4, accepted: [{ friendshipId: "cross-list", userId: bob.user.id }], incoming: [{ friendshipId: "cross-list", userId: bob.user.id }], outgoing: [] },
    ]) {
      await probe.mset(topologyVersion, JSON.stringify(poisoned.generation), topologyKey, JSON.stringify(poisoned));
      assert.deepEqual(await getFriends(alice), expected);
    }

    await probe.mset(
      presentationVersion, JSON.stringify(7),
      presentationKey, JSON.stringify({
        generation: 7,
        v: {
          id: bob.user.id, displayName: "Poison", profilePhotoUrl: null,
          equippedAccessories: [null], clientFeatures: [],
          isReviewAccount: false, hiddenFromLeaderboard: false,
        },
      })
    );
    assert.deepEqual(await getFriends(alice), expected);

    await probe.del(topologyVersion);
    await probe.set(topologyKey, JSON.stringify({ generation: 0, accepted: [], incoming: [], outgoing: [] }));
    assert.deepEqual(await getFriends(alice), expected, "payload without marker is never a hit");
  });

  it("rejects poisoned/expired ranking cores and preserves the complete legacy response", async () => {
    const { alice } = await seedPublicState();
    await setFlags(true);
    const path = "/leaderboard?type=steps&period=today&scope=global";
    const options = { token: alice.token, headers: { "X-Timezone": "America/New_York" } };
    const first = await request(server.baseUrl, "GET", path, options);
    const expected = await first.json();
    const [key] = await probe.keys(`${ENV_PREFIX}v1:leaderboard:steps:global:*`);
    assert.ok(key);
    const logical = key.slice(ENV_PREFIX.length);
    const core = JSON.parse(await probe.get(key));
    for (const poisoned of [
      { ...core, rows: [...core.rows, ...(core.rows[0] ? [core.rows[0]] : [{ userId: alice.user.id, rank: 1, totalSteps: 1 }])] },
      { ...core, asOf: "not-a-date" },
      { ...core, asOf: new Date(Date.now() - 61_000).toISOString() },
      { ...core, viewerId: alice.user.id },
    ]) {
      await probe.set(`${ENV_PREFIX}${logical}`, JSON.stringify(poisoned));
      const response = await request(server.baseUrl, "GET", path, options);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), expected);
    }
  });

  it("manual friendship transitions and account deletion invalidate both warm viewers", async () => {
    const alice = await createTestUser({ displayName: "Alice" });
    const bob = await createTestUser({ displayName: "Bob" });
    await setFlags(true);
    await getFriends(alice);
    await getFriends(bob);

    let response = await request(server.baseUrl, "POST", "/friends/request", {
      token: alice.token, body: { addresseeId: bob.user.id },
    });
    assert.equal(response.status, 201);
    let alicePage = await getFriends(alice);
    let bobPage = await getFriends(bob);
    assert.equal(alicePage.pending.outgoing.length, 1);
    assert.equal(bobPage.pending.incoming.length, 1);
    const friendshipId = bobPage.pending.incoming[0].friendshipId;

    response = await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
      token: bob.token, body: { accept: false },
    });
    assert.equal(response.status, 200);
    assert.equal((await getFriends(alice)).pending.outgoing.length, 0);

    response = await request(server.baseUrl, "POST", "/friends/request", {
      token: alice.token, body: { addresseeId: bob.user.id },
    });
    assert.equal(response.status, 201);
    const reopened = (await getFriends(bob)).pending.incoming[0].friendshipId;
    response = await request(server.baseUrl, "PUT", `/friends/request/${reopened}`, {
      token: bob.token, body: { accept: true },
    });
    assert.equal(response.status, 200);
    assert.equal((await getFriends(alice)).friends[0].id, bob.user.id);
    assert.equal((await getFriends(bob)).friends[0].id, alice.user.id);

    response = await request(server.baseUrl, "DELETE", "/auth/account", { token: bob.token });
    assert.equal(response.status, 204);
    assert.deepEqual(await getFriends(alice), { friends: [], pending: { incoming: [], outgoing: [] } });
  });

  it("referral provision and redeem automatic friendships invalidate warm topology", async () => {
    const referrer = await createTestUser({ displayName: "Referrer" });
    await prisma.user.update({ where: { id: referrer.user.id }, data: { referralCode: "BARA-CACH" } });
    await setFlags(true);
    await getFriends(referrer);

    const provision = await request(server.baseUrl, "POST", "/auth/apple", {
      body: { identityToken: `social-referee-${Date.now()}`, referralCode: "BARA-CACH" },
    });
    assert.equal(provision.status, 200);
    const provisionBody = await provision.json();
    assert.equal((await getFriends(referrer)).friends.some((row) => row.id === provisionBody.user.id), true);

    const late = await createTestUser({ displayName: "Late Referee" });
    await getFriends(late);
    const redeem = await request(server.baseUrl, "POST", "/referrals/redeem", {
      token: late.token, body: { referralCode: "BARA-CACH" },
    });
    assert.equal(redeem.status, 200);
    assert.equal((await redeem.json()).attributed, true);
    assert.equal((await getFriends(late)).friends[0].id, referrer.user.id);
  });

  it("quick-share auto-friend invalidates both warm topology keys after commit", async () => {
    const creator = await createTestUser({ displayName: "Creator" });
    const joiner = await createTestUser({ displayName: "Joiner" });
    await setFlags(true);
    await prisma.appSetting.upsert({
      where: { key: "quickRaceShareAutoFriendEnabled" },
      update: { value: true }, create: { key: "quickRaceShareAutoFriendEnabled", value: true },
    });
    await prisma.appSetting.upsert({
      where: { key: "quickCreateRaceCtaEnabled" },
      update: { value: true }, create: { key: "quickCreateRaceCtaEnabled", value: true },
    });
    await prisma.appSetting.upsert({
      where: { key: "fundedPrizePoolsEnabled" },
      update: { value: false }, create: { key: "fundedPrizePoolsEnabled", value: false },
    });
    appSettings.bustCache();
    await getFriends(creator);
    await getFriends(joiner);
    const feature = { "X-Client-Features": "next_race_cta" };
    const created = await request(server.baseUrl, "POST", "/races", {
      token: creator.token, headers: feature,
      body: {
        name: "Cache Quick Sprint", maxDurationDays: 2, buyInAmount: 0,
        payoutPreset: "TOP3_70_20_10", isPublic: true, maxParticipants: 10,
        powerupsEnabled: true, powerupStepInterval: 2000,
        creationSource: "QUICK_CREATE", startPolicy: "ON_MINIMUM_PARTICIPANTS",
      },
    });
    assert.equal(created.status, 201, await created.clone().text());
    const race = (await created.json()).race;
    const link = await request(server.baseUrl, "POST", `/races/${race.id}/share-link`, {
      token: creator.token,
    });
    assert.equal(link.status, 201);
    const { shareToken } = await link.json();
    const joined = await request(server.baseUrl, "POST", `/races/share/${shareToken}/join`, {
      token: joiner.token, headers: feature,
    });
    assert.equal(joined.status, 201);
    assert.equal((await getFriends(creator)).friends[0].id, joiner.user.id);
    assert.equal((await getFriends(joiner)).friends[0].id, creator.user.id);
  });

  it("search counter reset remains best-effort and never changes search visibility", async () => {
    const { alice } = await seedPublicState();
    await setFlagValues({ redisFriendSearchRateLimitEnabled: true });
    let firstBody;
    for (let i = 0; i < 30; i += 1) {
      const response = await request(server.baseUrl, "POST", "/friends/search", {
        token: alice.token, body: { q: "river" },
      });
      assert.equal(response.status, 200);
      firstBody ??= await response.json();
    }
    const [rateKey] = await probe.keys(`${ENV_PREFIX}v1:user:friendsearchrate:*`);
    assert.ok(rateKey);
    await probe.del(rateKey);
    const afterReset = await request(server.baseUrl, "POST", "/friends/search", {
      token: alice.token, body: { q: "river" },
    });
    assert.equal(afterReset.status, 200);
    assert.deepEqual(await afterReset.json(), firstBody);
  });

  it("race leaderboards bypass the step-ranking cache with flags on", async () => {
    const { alice } = await seedPublicState();
    await setFlags(true);
    const response = await request(
      server.baseUrl,
      "GET",
      "/leaderboard?type=races&scope=global",
      { token: alice.token }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(await response.json()).sort(), ["currentUser", "top100"]);
    assert.deepEqual(await probe.keys(`${ENV_PREFIX}v1:leaderboard:steps:*`), []);
  });
});
