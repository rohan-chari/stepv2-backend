const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildStepLeaderboardCache,
} = require("../../src/modules/leaderboard/services/stepLeaderboardCache");
const {
  buildUserPresentationCache,
  validPresentation,
} = require("../../src/modules/social/services/userPresentationCache");
const {
  buildFriendsTopologyCache,
} = require("../../src/modules/social/services/friendsTopologyCache");
const {
  buildFriendSearchRateLimiter,
} = require("../../src/modules/social/services/friendSearchRateLimiter");
const {
  buildSearchFriendsByIdentity,
} = require("../../src/modules/social/services/searchFriendsByIdentity");
const {
  buildEquipmentMap,
} = require("../../src/modules/cosmetics/shopCosmetics");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("an over-age cold leaderboard core is never returned after publication is refused", async () => {
  let publishAttempts = 0;
  const now = new Date("2026-08-13T12:02:00.000Z");
  const cache = buildStepLeaderboardCache({
    now: () => now,
    waitMs: 250,
    logger: { info() {}, warn() {} },
    cacheKeys: { leaderboardLock: (key) => `lock:${key}` },
    redisCache: {
      getJSON: async () => null,
      withLock: async (_key, _ttl, fn) => fn(),
      withWatch: async () => {
        publishAttempts += 1;
        return { installed: false };
      },
    },
  });

  const result = await cache.getOrLoad({
    key: "ranking",
    scope: "global",
    period: "today",
    boundary: "2026-08-13",
    load: async () => ({
      version: 1,
      scope: "global",
      period: "today",
      boundary: "2026-08-13",
      asOf: "2026-08-13T12:00:00.000Z",
      buildStartedAt: "2026-08-13T12:00:00.000Z",
      rows: [],
    }),
  });

  assert.equal(result, null);
  assert.equal(publishAttempts, 0);
});

test("presentation validation rejects malformed nested cache members", () => {
  const valid = {
    id: "user-1",
    displayName: "River",
    profilePhotoUrl: null,
    clientFeatures: ["team_races"],
    isReviewAccount: false,
    hiddenFromLeaderboard: false,
    equippedAccessories: [{
      shopItem: {
        id: "item-1",
        sku: "hat",
        name: "Hat",
        slot: "HEAD",
        assetKey: "hat",
        renderMetadata: null,
        bobble: true,
        testOnly: false,
        remoteOnly: false,
        assetVersion: null,
      },
    }],
  };
  assert.equal(validPresentation(valid, "user-1"), true);
  assert.equal(validPresentation({ ...valid, equippedAccessories: [null] }, "user-1"), false);
  assert.equal(validPresentation({ ...valid, clientFeatures: [42] }, "user-1"), false);
  assert.equal(validPresentation({
    ...valid,
    equippedAccessories: [{ shopItem: { ...valid.equippedAccessories[0].shopItem, secret: true } }],
  }, "user-1"), false);
});

test("equipment mapping preserves every slot from presentation-cache v1 rows", () => {
  const equipped = [
    ["HEAD", "baseball_cap"],
    ["FACE", "sunglasses"],
    ["BACK", "beaver_tail"],
  ].map(([slot, assetKey], index) => ({
    shopItem: {
      id: `item-${index}`,
      sku: assetKey,
      name: assetKey,
      slot,
      assetKey,
      renderMetadata: null,
      bobble: false,
      testOnly: false,
      remoteOnly: false,
      assetVersion: null,
    },
  }));

  assert.deepEqual(Object.keys(buildEquipmentMap(equipped)).sort(), [
    "BACK",
    "FACE",
    "HEAD",
  ]);
});

test("presentation cache projects Prisma relation scalars out before the warm hit", async () => {
  const stored = new Map();
  let userQueries = 0;
  const cache = buildUserPresentationCache({
    appSettings: { getFlag: async () => true },
    logger: { info() {} },
    derivedCache: {
      isBypassed: () => false,
      ensureSubscribed() {},
      invalidate: async () => true,
    },
    prisma: {
      user: {
        findMany: async () => {
          userQueries += 1;
          return [{
            id: "user-1",
            displayName: "River",
            profilePhotoUrl: null,
            clientFeatures: [],
            isReviewAccount: false,
            hiddenFromLeaderboard: false,
            equippedAccessories: [{
              id: "equipped-1",
              userId: "user-1",
              slot: "HEAD",
              shopItemId: "item-1",
              updatedAt: new Date(),
              shopItem: {
                id: "item-1", sku: "hat", name: "Hat", slot: "HEAD",
                assetKey: "hat", renderMetadata: null, bobble: true,
                testOnly: false, remoteOnly: false, assetVersion: null,
              },
            }],
          }];
        },
      },
    },
    redisCache: {
      isEnabled: () => true,
      getManyJSON: async (keys) => ({
        ok: true,
        values: keys.map((key) => stored.get(key) ?? null),
      }),
      withWatch: async (_keys, fn) => {
        const commit = await fn({ get: async (key) => stored.get(key) ?? null });
        for (const entry of commit.sets) stored.set(entry.key, entry.value);
        return { installed: true };
      },
    },
  });

  await cache.getMany(["user-1"], true);
  const second = await cache.getMany(["user-1"], true);
  assert.equal(userQueries, 1, "warm presentation must not reload Postgres");
  assert.equal(second.get("user-1").equippedAccessories[0].shopItem.sku, "hat");
  assert.deepEqual(Object.keys(second.get("user-1").equippedAccessories[0]), ["shopItem"]);
});

test("presentation WATCH abort serves its current PG read without installing stale data", async () => {
  let generation = 0;
  let storedPayload = null;
  const loaded = deferred();
  const continueLoad = deferred();
  const cache = buildUserPresentationCache({
    appSettings: { getFlag: async () => true },
    logger: { info() {} },
    derivedCache: { isBypassed: () => false, ensureSubscribed() {}, invalidate: async () => true },
    prisma: { user: { findMany: async () => {
      loaded.resolve();
      await continueLoad.promise;
      return [{ id: "u", displayName: "Before", profilePhotoUrl: null,
        clientFeatures: [], isReviewAccount: false, hiddenFromLeaderboard: false,
        equippedAccessories: [] }];
    } } },
    redisCache: {
      isEnabled: () => true,
      getManyJSON: async () => ({ ok: true, values: [storedPayload, generation] }),
      withWatch: async (_keys, fn) => {
        const seen = generation;
        const commit = await fn({ get: async () => generation });
        if (generation !== seen) return { installed: false, aborted: true };
        storedPayload = commit.sets[1].value;
        return { installed: true };
      },
    },
  });
  const read = cache.getMany(["u"], true);
  await loaded.promise;
  generation += 1;
  continueLoad.resolve();
  assert.equal((await read).get("u").displayName, "Before");
  assert.equal(storedPayload, null, "concurrent invalidation must abort stale install");
});

test("presentation invalidation advances the generation when only the guard is enabled", async () => {
  let evalCalls = 0;
  const cache = buildUserPresentationCache({
    appSettings: {
      getFlag: async (name) => name === "redisPresentationGenerationGuardEnabled",
    },
    derivedCache: {
      invalidate: async ({ run }) => run(),
    },
    redisCache: {
      isEnabled: () => true,
      evalLua: async (_script, keys) => {
        evalCalls += 1;
        assert.equal(keys.length, 2);
        return 1;
      },
      del: async () => {
        assert.fail("guarded invalidation must not use an unversioned delete");
      },
    },
  });

  await cache.invalidate("user-1");
  assert.equal(evalCalls, 1);
});

test("topology WATCH abort cannot reinstall a pre-mutation friendship list", async () => {
  let generation = 0;
  let installed = null;
  const loaded = deferred();
  const continueLoad = deferred();
  const prisma = {
    friendship: { findMany: async (query) => {
      if (query.where.status === "ACCEPTED") {
        loaded.resolve();
        await continueLoad.promise;
        return [{ id: "f", requesterId: "viewer", addresseeId: "friend" }];
      }
      return [];
    } },
  };
  const cache = buildFriendsTopologyCache({
    prisma,
    appSettings: { getFlag: async () => true },
    logger: { info() {} },
    derivedCache: { isBypassed: () => false, ensureSubscribed() {}, invalidate: async () => true },
    redisCache: {
      isEnabled: () => true,
      getManyJSON: async () => ({ ok: true, values: [installed, generation] }),
      withWatch: async (_keys, fn) => {
        const seen = generation;
        const commit = await fn({ get: async () => generation });
        if (generation !== seen) return { installed: false, aborted: true };
        installed = commit.sets[1].value;
        return { installed: true };
      },
    },
  });
  const read = cache.get("viewer");
  await loaded.promise;
  generation += 1;
  continueLoad.resolve();
  assert.equal((await read).accepted.length, 1);
  assert.equal(installed, null, "pre-mutation topology must not be published");
});

test("soft-stale ranking is served immediately and shares one background rebuild", async () => {
  const now = new Date("2026-08-13T12:00:20.000Z");
  const stale = {
    version: 1, scope: "global", period: "today", boundary: "2026-08-13",
    asOf: "2026-08-13T12:00:00.000Z", buildStartedAt: "2026-08-13T12:00:00.000Z", rows: [],
  };
  let loads = 0;
  const gate = deferred();
  const cache = buildStepLeaderboardCache({
    now: () => now, logger: { info() {}, warn() {} },
    cacheKeys: { leaderboardLock: (key) => `lock:${key}` },
    redisCache: {
      getJSON: async () => stale,
      withLock: async (_key, _ttl, fn) => fn(),
      withWatch: async () => ({ installed: true }),
    },
  });
  const request = { key: "rank", scope: "global", period: "today", boundary: "2026-08-13",
    load: async () => { loads += 1; await gate.promise; return stale; } };
  const [a, b] = await Promise.all([cache.getOrLoad(request), cache.getOrLoad(request)]);
  assert.strictEqual(a, stale);
  assert.strictEqual(b, stale);
  assert.equal(loads, 1);
  gate.resolve();
});

test("older/equal ranking publication cannot replace the existing core and PX uses remaining age", async () => {
  const existing = {
    version: 1, scope: "global", period: "today", boundary: "2026-08-13",
    asOf: "2026-08-13T12:00:10.000Z", buildStartedAt: "2026-08-13T12:00:10.000Z", rows: [],
  };
  let committed = null;
  const cache = buildStepLeaderboardCache({
    now: () => new Date("2026-08-13T12:00:20.000Z"), logger: { info() {}, warn() {} },
    redisCache: { withWatch: async (_keys, fn) => {
      committed = await fn({ get: async () => existing });
      return { installed: Boolean(committed) };
    } },
  });
  assert.equal(await cache.publish("rank", existing, { scope: "global", period: "today", boundary: "2026-08-13" }), false);
  assert.equal(committed, null, "equal buildStartedAt keeps existing value");
  const newer = { ...existing, asOf: "2026-08-13T12:00:30.000Z", buildStartedAt: "2026-08-13T12:00:30.000Z" };
  await cache.publish("rank", newer, { scope: "global", period: "today", boundary: "2026-08-13" });
  assert.equal(committed.sets[0].ttlMs, 70_000);
});

test("malformed or response-lost Redis search replies synchronously use the PG allowance", async () => {
  let pgConsumes = 0;
  const search = buildSearchFriendsByIdentity({
    appSettings: { getFlag: async () => true },
    logger: { info() {} },
    now: () => new Date("2026-08-13T12:00:30.000Z"),
    friendSearchRateLimiter: async () => null,
    FriendSearchRateWindow: { consume: async () => {
      pgConsumes += 1;
      return { count: 1, windowStart: new Date("2026-08-13T12:00:00.000Z") };
    } },
    searchDiscoverableUsers: async () => [{ id: "visible" }],
  });
  assert.deepEqual(await search({ userId: "u", q: "river" }), [{ id: "visible" }]);
  assert.equal(pgConsumes, 1);

  for (const result of [null, 0, -1, 1.5, "bad", "1", true]) {
    const limiter = buildFriendSearchRateLimiter({
      cacheKeys: { friendSearchRate: () => "rate" },
      redisCache: { evalLua: async () => ({ ok: true, result }) },
    });
    assert.equal(await limiter("u", new Date()), null);
  }
});

test("partial presentation MGET cardinality falls back to one bulk PG query", async () => {
  let queries = 0;
  const cache = buildUserPresentationCache({
    appSettings: { getFlag: async () => true }, logger: { info() {} },
    derivedCache: { isBypassed: () => false, ensureSubscribed() {}, invalidate: async () => true },
    prisma: { user: { findMany: async () => {
      queries += 1;
      return ["a", "b"].map((id) => ({ id, displayName: id, profilePhotoUrl: null,
        equippedAccessories: [], clientFeatures: [], isReviewAccount: false,
        hiddenFromLeaderboard: false }));
    } } },
    redisCache: {
      isEnabled: () => true,
      getManyJSON: async () => ({ ok: true, values: [null] }),
    },
  });
  const result = await cache.getMany(["a", "b"], true);
  assert.equal(queries, 1);
  assert.deepEqual([...result.keys()], ["a", "b"]);
});

test("physical-miss lock loser polls without running the PG loader then falls back", async () => {
  let loaderCalls = 0;
  const cache = buildStepLeaderboardCache({
    waitMs: 250,
    logger: { info() {}, warn() {} },
    cacheKeys: { leaderboardLock: (key) => `lock:${key}` },
    redisCache: {
      getJSON: async () => null,
      withLock: async () => null,
    },
  });
  const result = await cache.getOrLoad({
    key: "rank", scope: "global", period: "today", boundary: "2026-08-13",
    load: async () => { loaderCalls += 1; throw new Error("must not run"); },
  });
  assert.equal(result, null);
  assert.equal(loaderCalls, 0);
});

test("friends ranking computation is one repeatable-read grouped snapshot", async () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(require.resolve("../../src/modules/leaderboard/getLeaderboard"), "utf8");
  const transaction = source.match(/return db\.\$transaction\(async \(tx\) => \{([\s\S]*?)\}, \{ isolationLevel: "RepeatableRead" \}\);/);
  assert.ok(transaction, "friends cold load must be enclosed in RepeatableRead");
  assert.equal((transaction[1].match(/tx\.step\.groupBy/g) || []).length, 1,
    "top rows and viewer scalar derive from one grouped statement, so a concurrent commit cannot split the snapshot");
  assert.equal(/redis|presentationCache/.test(transaction[1]), false,
    "no Redis wait or presentation hydration may hold the PG transaction");
});
