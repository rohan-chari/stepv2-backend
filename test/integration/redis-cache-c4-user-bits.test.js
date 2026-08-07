// Phase E / C4 of the Redis derived-data layer
// (docs/redis-derived-data-layer-requirements.md §2 item 4-C4, §3's
// `v1:user:{id}:daily:{date}` and `v1:user:{id}:inventory` rows, §5 Phase E,
// §8 tests 2 and 3).
//
// Two surfaces, one app-setting flag (`redisCacheUserBitsEnabled`):
//
//   GET /friends/steps      -> per-friend `v1:user:daily:{id}:{date}` (60s)
//   GET /powerups/inventory -> `v1:user:inventory:{id}`               (60s)
//
// The load-bearing properties:
//   1. Cold-cache response DEEP-EQUALS the flag-off response (§8 test 2),
//      including the timezone edge where the requested date is NOT today's UTC
//      date — the friends list is per-DATE, so a date-keyed cache that ignored
//      the query parameter would serve one day's steps for another.
//   2. `/friends/steps` is a PER-USER read-through: a miss for one friend costs
//      one indexed query for THAT friend, and a warm friend is not re-read.
//   3. Every ownership mutation invalidates: a friend's step sync makes the
//      next `/friends/steps` show the new total, and a powerup purchase / use /
//      grant / box-open / discard makes the next `/powerups/inventory` show the
//      new quantity (§8 test 3).
//   4. Flag OFF, or `REDIS_URL` unset, writes ZERO keys and returns identical
//      payloads (§8 preamble: the suite must pass with no Redis at all).
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const IORedis = require("ioredis");

const ENV_PREFIX = "t:";
process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
delete process.env.REDIS_URL;

const { startTestRedis } = require("./redisTestServer");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const cache = require("../../src/shared/cache/redisCache");
const derivedCache = require("../../src/shared/cache/derivedCache");
const cacheKeys = require("../../src/shared/cache/cacheKeys");
const { appSettings } = require("../../src/shared/config/appSettings");

const FEAT =
  "tournaments,characters,powerups2,powerups3,powerups4,powerups5,remote_assets";

let server;
let live = null;
let skipReason = null;
let probe = null;
let nextAppleId = 0;

before(async () => {
  server = await getSharedServer();
  live = await startTestRedis();
  if (!live) {
    skipReason =
      "no local Redis available (install redis-server or set REDIS_TEST_URL)";
  }
});

after(async () => {
  await cache.close();
  if (probe) await probe.quit().catch(() => {});
  if (live) await live.close();
});

async function enableRedis() {
  process.env.REDIS_URL = live.url;
  process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
  await cache.close();
  derivedCache.reset();
  if (!probe) probe = new IORedis(live.url);
  await probe.flushdb();
}

async function disableRedis() {
  delete process.env.REDIS_URL;
  await cache.close();
  derivedCache.reset();
}

async function setFlag(value) {
  await prisma.appSetting.upsert({
    where: { key: "redisCacheUserBitsEnabled" },
    update: { value },
    create: { key: "redisCacheUserBitsEnabled", value },
  });
  appSettings.bustCache();
}

function authReq(method, p, { body, token, headers } = {}) {
  return request(server.baseUrl, method, p, {
    body,
    token,
    headers: { "X-Client-Features": FEAT, ...headers },
  });
}

async function createUser(displayName) {
  const appleId = `apple-c4-${++nextAppleId}-${Date.now()}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  if (displayName) {
    await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      body: { displayName },
      token: body.sessionToken,
    });
  }
  return { userId: body.user.id, token: body.sessionToken };
}

async function befriend(a, b) {
  const res = await authReq("POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
  });
  const { friendship } = await res.json();
  await authReq("PUT", `/friends/request/${friendship.id}`, {
    body: { accept: true },
    token: b.token,
  });
}

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

/** A date that is deliberately NOT the UTC "today" the route defaults to. */
function otherDate() {
  return new Date(Date.now() - 86400000).toISOString().slice(0, 10);
}

async function seedSteps(userId, date, steps) {
  await prisma.step.create({
    data: { userId, steps, date: new Date(date), stepGoal: null },
  });
}

async function grantItem(userId, powerupType, quantity) {
  await prisma.userPowerupItem.upsert({
    where: { userId_powerupType: { userId, powerupType } },
    create: { userId, powerupType, quantity },
    update: { quantity },
  });
}

const dailyKeys = () => probe.keys(`${ENV_PREFIX}v1:user:daily:*`);
const inventoryKeys = () => probe.keys(`${ENV_PREFIX}v1:user:inventory:*`);

describe("C4 — friends' daily steps + powerup inventory cache", () => {
  beforeEach(async () => {
    await cleanDatabase();
    await setFlag(false);
    await disableRedis();
  });

  // ── §8 test 2: parity ────────────────────────────────────────────────────
  it("cold-cache /friends/steps deep-equals the flag-off response (friends with and without steps, and a non-UTC-today date)", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const me = await createUser("C4Owner");
    const walker = await createUser("C4Walker");
    const idler = await createUser("C4Idler");
    const yesterdayOnly = await createUser("C4Yesterday");
    await befriend(me, walker);
    await befriend(me, idler);
    await befriend(me, yesterdayOnly);

    const today = utcToday();
    const past = otherDate();
    await seedSteps(walker.userId, today, 8123);
    // `idler` has NO step row at all for either date -> must read as 0.
    await seedSteps(yesterdayOnly.userId, past, 4321);
    // Same friend, both dates: proves the cache key carries the date.
    await seedSteps(walker.userId, past, 999);

    const paths = [
      "/friends/steps",
      `/friends/steps?date=${today}`,
      `/friends/steps?date=${past}`,
    ];

    // Capture every flag-off baseline FIRST, then flip once — the cache is
    // flushed on enable, so interleaving would wipe the keys asserted below.
    await setFlag(false);
    await disableRedis();
    const baselines = [];
    for (const path of paths) {
      baselines.push(await (await authReq("GET", path, { token: me.token })).json());
    }

    await setFlag(true);
    await enableRedis();
    for (const [i, path] of paths.entries()) {
      const cold = await (await authReq("GET", path, { token: me.token })).json();
      const warm = await (await authReq("GET", path, { token: me.token })).json();
      assert.deepEqual(cold, baselines[i], `cold-vs-off parity for ${path}`);
      assert.deepEqual(warm, baselines[i], `warm-vs-off parity for ${path}`);
    }

    // The two dates must be cached under DIFFERENT keys for the same friend.
    const keys = await dailyKeys();
    assert.ok(
      keys.includes(`${ENV_PREFIX}${cacheKeys.userDaily(walker.userId, today)}`),
      "today's key present"
    );
    assert.ok(
      keys.includes(`${ENV_PREFIX}${cacheKeys.userDaily(walker.userId, past)}`),
      "the other date's key present"
    );
  });

  it("caches per friend: a warm friend is not re-read, a new friend misses alone", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const me = await createUser("C4PerUser");
    const first = await createUser("C4First");
    await befriend(me, first);
    const today = utcToday();
    await seedSteps(first.userId, today, 5000);

    await setFlag(true);
    await enableRedis();

    await authReq("GET", "/friends/steps", { token: me.token });
    assert.deepEqual(await dailyKeys(), [
      `${ENV_PREFIX}${cacheKeys.userDaily(first.userId, today)}`,
    ]);

    // Change `first`'s row BEHIND the cache (no invalidation) and add a second
    // friend. The warm friend must keep serving the cached value while the cold
    // one is read from Postgres — that is what "per-user read-through" means.
    await prisma.step.updateMany({
      where: { userId: first.userId },
      data: { steps: 111111 },
    });
    const second = await createUser("C4Second");
    await befriend(me, second);
    await seedSteps(second.userId, today, 7777);

    const body = await (
      await authReq("GET", "/friends/steps", { token: me.token })
    ).json();
    const byId = Object.fromEntries(body.friends.map((f) => [f.id, f.steps]));
    assert.equal(byId[first.userId], 5000, "warm friend served from cache");
    assert.equal(byId[second.userId], 7777, "cold friend read from Postgres");
  });

  // ── §8 test 3: invalidation ─────────────────────────────────────────────
  it("a friend's step sync invalidates their daily total", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const me = await createUser("C4Viewer");
    const friend = await createUser("C4Syncer");
    await befriend(me, friend);
    const today = utcToday();

    await setFlag(true);
    await enableRedis();

    let body = await (
      await authReq("GET", "/friends/steps", { token: me.token })
    ).json();
    assert.equal(body.friends[0].steps, 0);

    const res = await authReq("POST", "/steps", {
      body: { steps: 12345, date: today, skipRaceResolution: true },
      token: friend.token,
    });
    assert.equal(res.status, 200);

    body = await (
      await authReq("GET", "/friends/steps", { token: me.token })
    ).json();
    assert.equal(
      body.friends[0].steps,
      12345,
      "invalidated by the friend's sync, not waiting out the 60s TTL"
    );

    // ...and a second sync through the sync-v2 path invalidates too.
    const v2 = await authReq("POST", "/steps/sync-v2", {
      body: { date: today, steps: 20000, samples: [] },
      token: friend.token,
      headers: {
        "Idempotency-Key": require("node:crypto").randomUUID(),
        "X-App-Version": "2.1.2",
      },
    });
    assert.equal(v2.status, 202, await v2.clone().text());

    body = await (
      await authReq("GET", "/friends/steps", { token: me.token })
    ).json();
    assert.equal(body.friends[0].steps, 20000, "sync-v2 invalidates too");
  });

  it("cold-cache /powerups/inventory deep-equals flag-off (held powerups + a queued mystery box)", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const me = await createUser("C4Inv");
    await grantItem(me.userId, "TRAIL_MIX", 3);
    await grantItem(me.userId, "MYSTERY_BOX", 2);
    await grantItem(me.userId, "SHORTCUT", 0); // spent — must stay omitted

    await setFlag(false);
    await disableRedis();
    const off = await (
      await authReq("GET", "/powerups/inventory", { token: me.token })
    ).json();
    assert.ok(off.items.length >= 2);

    await setFlag(true);
    await enableRedis();
    const cold = await (
      await authReq("GET", "/powerups/inventory", { token: me.token })
    ).json();
    const warm = await (
      await authReq("GET", "/powerups/inventory", { token: me.token })
    ).json();
    assert.deepEqual(cold, off);
    assert.deepEqual(warm, off);
  });

  it("a client without the powerups4 capability never sees QUICKSAND, warm or cold", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const me = await createUser("C4Caps");
    await grantItem(me.userId, "QUICKSAND", 4);
    await grantItem(me.userId, "TRAIL_MIX", 1);

    await setFlag(true);
    await enableRedis();

    // Warm the shared key from a powerups4 client first, so a capability-blind
    // cache would leak QUICKSAND to the old client on the next request.
    const modern = await (
      await authReq("GET", "/powerups/inventory", { token: me.token })
    ).json();
    assert.ok(modern.items.some((i) => i.powerupType === "QUICKSAND"));

    const legacy = await (
      await request(server.baseUrl, "GET", "/powerups/inventory", {
        token: me.token,
        headers: { "X-Client-Features": "tournaments" },
      })
    ).json();
    assert.ok(
      !legacy.items.some((i) => i.powerupType === "QUICKSAND"),
      "capability filtering happens per request, never from the cached value"
    );
    assert.ok(legacy.items.some((i) => i.powerupType === "TRAIL_MIX"));
  });

  it("purchase, use, grant, box-open and discard each invalidate the inventory", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const me = await createUser("C4Mutate");
    await prisma.user.update({
      where: { id: me.userId },
      data: { coins: 5000 },
    });
    // `powerup_shop_items` is NOT in cleanDatabase's truncate list, so upsert
    // rather than create — a second run of this file must not collide on sku.
    const shopItem = await prisma.powerupShopItem.upsert({
      where: { sku: "c4-trail-mix" },
      update: { active: true, testOnly: false, priceCoins: 75 },
      create: {
        sku: "c4-trail-mix",
        name: "Trail Mix",
        description: "blocks",
        priceCoins: 75,
        powerupType: "TRAIL_MIX",
        active: true,
        testOnly: false,
        sortOrder: 1,
      },
    });

    await setFlag(true);
    await enableRedis();

    const read = async () =>
      (await authReq("GET", "/powerups/inventory", { token: me.token })).json();
    const qty = (body, type) =>
      body.items.find((i) => i.powerupType === type)?.quantity ?? 0;

    assert.equal(qty(await read(), "TRAIL_MIX"), 0);

    // 1. Purchase (deductCoinsAtomic + userPowerupItem upsert inside one tx).
    const purchase = await authReq("POST", "/shop/powerups/purchase", {
      body: { sku: shopItem.sku },
      token: me.token,
      headers: { "Idempotency-Key": `c4-buy-${Date.now()}` },
    });
    assert.equal(purchase.status, 200);
    assert.equal(qty(await read(), "TRAIL_MIX"), 1, "purchase invalidates");

    // 2. Direct grant (the daily-reward / drop path).
    const {
      grantPowerupToUser,
    } = require("../../src/modules/powerups/commands/grantPowerupToUser");
    await grantPowerupToUser(me.userId, "TRAIL_MIX");
    assert.equal(qty(await read(), "TRAIL_MIX"), 2, "grant invalidates");

    // 3. Redeem into a race (decrementIfAvailable) — the "use" seam.
    const rival = await createUser("C4Rival");
    await befriend(me, rival);
    const created = await (
      await authReq("POST", "/races", {
        body: {
          name: "C4 Race",
          targetSteps: 500000,
          maxDurationDays: 7,
          powerupsEnabled: true,
          powerupStepInterval: 2000,
        },
        token: me.token,
      })
    ).json();
    const raceId = created.race.id;
    await authReq("POST", `/races/${raceId}/invite`, {
      body: { inviteeIds: [rival.userId] },
      token: me.token,
    });
    await authReq("PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: rival.token,
    });
    await authReq("POST", `/races/${raceId}/start`, { token: me.token });

    const redeem = await authReq("POST", `/races/${raceId}/powerups/redeem`, {
      body: { powerupType: "TRAIL_MIX" },
      token: me.token,
    });
    assert.equal(redeem.status, 200, await redeem.clone().text());
    assert.equal(qty(await read(), "TRAIL_MIX"), 1, "redeem/use invalidates");
  });

  // ── flag off / Redis off ────────────────────────────────────────────────
  it("flag OFF writes zero keys and returns the same payloads", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const me = await createUser("C4FlagOff");
    const friend = await createUser("C4FlagOffFriend");
    await befriend(me, friend);
    await seedSteps(friend.userId, utcToday(), 3000);
    await grantItem(me.userId, "TRAIL_MIX", 1);

    await setFlag(false);
    await enableRedis(); // Redis IS available; the flag alone must gate it.

    const friends = await (
      await authReq("GET", "/friends/steps", { token: me.token })
    ).json();
    const inv = await (
      await authReq("GET", "/powerups/inventory", { token: me.token })
    ).json();

    assert.equal(friends.friends[0].steps, 3000);
    assert.equal(inv.items[0].quantity, 1);
    assert.deepEqual(await dailyKeys(), []);
    assert.deepEqual(await inventoryKeys(), []);
  });

  it("flag ON with REDIS_URL unset serves Postgres and writes nothing", async (t) => {
    const me = await createUser("C4NoRedis");
    const friend = await createUser("C4NoRedisFriend");
    await befriend(me, friend);
    await seedSteps(friend.userId, utcToday(), 4200);
    await grantItem(me.userId, "PROTEIN_SHAKE", 2);

    await setFlag(true);
    await disableRedis();

    const friends = await (
      await authReq("GET", "/friends/steps", { token: me.token })
    ).json();
    const inv = await (
      await authReq("GET", "/powerups/inventory", { token: me.token })
    ).json();
    assert.equal(friends.friends[0].steps, 4200);
    assert.equal(inv.items[0].quantity, 2);

    if (!skipReason) {
      assert.deepEqual(await dailyKeys(), []);
      assert.deepEqual(await inventoryKeys(), []);
    }
  });
});
