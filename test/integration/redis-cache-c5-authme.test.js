// Phase E2 / C5 of the Redis derived-data layer
// (docs/redis-derived-data-layer-requirements.md §2 item 4-C5, §3's
// `v1:user:{id}:authme` row, §5 Phase E2 step 11, §8 tests 2 and 6).
//
// `GET /auth/me` is the #2 endpoint by volume (26,492 calls / 8 days) and is a
// multi-table assembly: the users row, a pending-friend-request COUNT, a
// held-buy-in SUM over race_participants, and the app_settings feature flags.
// It is cached for 10 SECONDS, and the TTL is explicitly the BACKSTOP, not the
// mechanism — every field the client re-reads immediately after mutating it is
// invalidated at its write site. The written classification lives in
// `src/modules/users/services/authMeCache.js`; these tests pin the ones the
// frontend audit proved are immediate:
//
//   * coins    — 15 read-back-after-write sites (race/tournament join, leave,
//                forfeit, cancel, create, invite-respond) plus purchases.
//   * heldCoins— same 15 sites; changes when a buy-in is held or released.
//   * onboarding progression (firstRaceOnboardingSeen / tutorialOnboardingSeen)
//   * profile edits (photo save/remove) and equips
//   * incomingFriendRequests — refreshed right after a friend accept/decline
//
// §8 test 6 is the sharpest: a purchase must be visible on the very next
// `/auth/me`, and the test must prove INVALIDATION did it. It does that two
// ways at once — the cached key is asserted GONE immediately after the write,
// and the read happens well inside the 10s TTL window of a pre-warmed value.
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
    where: { key: "redisCacheAuthMeEnabled" },
    update: { value },
    create: { key: "redisCacheAuthMeEnabled", value },
  });
  appSettings.bustCache();
}

function authReq(method, p, { body, token, headers } = {}) {
  return request(server.baseUrl, method, p, {
    body,
    token,
    headers: { "X-Client-Features": FEAT, "X-App-Version": "2.1.2", ...headers },
  });
}

async function createUser(displayName) {
  const appleId = `apple-c5-${++nextAppleId}-${Date.now()}`;
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

const me = (token, headers) => authReq("GET", "/auth/me", { token, headers });
const authMeKeys = () => probe.keys(`${ENV_PREFIX}v1:user:authme:*`);

describe("C5 — /auth/me response cache", () => {
  beforeEach(async () => {
    await cleanDatabase();
    await setFlag(false);
    await disableRedis();
  });

  // ── §8 test 2: parity ────────────────────────────────────────────────────
  it("cold-cache /auth/me deep-equals the flag-off response (coins, equips, onboarding mid-state)", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const user = await createUser("C5Parity");
    const item = await prisma.shopItem.create({
      data: {
        sku: "c5-hat",
        name: "C5 Hat",
        description: "a hat",
        slot: "HEAD",
        priceCoins: 75,
        assetKey: "c5_hat",
        active: true,
        testOnly: false,
        sortOrder: 1,
      },
    });
    await prisma.userShopItem.create({
      data: { userId: user.userId, shopItemId: item.id },
    });
    await prisma.userEquippedAccessory.create({
      data: { userId: user.userId, slot: "HEAD", shopItemId: item.id },
    });
    // Onboarding MID-state: first race seen, tutorial not.
    await prisma.user.update({
      where: { id: user.userId },
      data: {
        coins: 1234,
        firstRaceOnboardingSeen: true,
        tutorialOnboardingSeen: false,
        hiddenFromLeaderboard: true,
        autoJoinFeaturedRaces: true,
      },
    });
    // A pending incoming friend request so incomingFriendRequests is non-zero.
    const sender = await createUser("C5Sender");
    await authReq("POST", "/friends/request", {
      body: { addresseeId: user.userId },
      token: sender.token,
    });

    await setFlag(false);
    await disableRedis();
    // Prime the STICKY client-features/timezone writes requireAuth performs on
    // first sight of a header set (TR-706). They land AFTER `req.user` is read,
    // so the very first authed request always reports the pre-write row — an
    // artifact of the endpoint, not of caching. Settle it before baselining.
    await me(user.token);
    const off = await (await me(user.token)).json();

    await setFlag(true);
    await enableRedis();
    const cold = await (await me(user.token)).json();
    const warm = await (await me(user.token)).json();

    assert.equal(off.user.coins, 1234);
    assert.equal(off.user.incomingFriendRequests, 1);
    assert.equal(off.user.firstRaceOnboardingSeen, true);
    assert.equal(off.user.tutorialOnboardingSeen, false);
    assert.deepEqual(cold, off, "cold-cache parity");
    assert.deepEqual(warm, off, "warm-cache parity");
    assert.ok((await authMeKeys()).length > 0, "a key was actually written");
  });

  it("keeps the app-version variant separate (stepSampleBucketMinutes gate)", async (t) => {
    if (skipReason) return t.skip(skipReason);

    await prisma.appSetting.upsert({
      where: { key: "stepSampleBucketMinutes" },
      update: { value: 5 },
      create: { key: "stepSampleBucketMinutes", value: 5 },
    });
    appSettings.bustCache();
    const user = await createUser("C5Variant");

    await setFlag(true);
    await enableRedis();

    // Modern build sees the flag; a 1.7.0 build must NOT (it inflates fine
    // buckets — see the 2026-07-23 incident). Warming one must not poison the
    // other.
    const modern = await (
      await me(user.token, { "X-App-Version": "2.1.2" })
    ).json();
    const legacy = await (
      await me(user.token, { "X-App-Version": "1.7.0" })
    ).json();
    assert.equal(modern.user.featureFlags.stepSampleBucketMinutes, 5);
    assert.equal(
      "stepSampleBucketMinutes" in legacy.user.featureFlags,
      false,
      "below-floor build must not receive the fine-bucket flag from a warmed cache"
    );
  });

  // ── §8 test 6: coin freshness by INVALIDATION, not TTL ──────────────────
  it("a shop purchase is reflected by /auth/me within 1s, proven by the key being deleted", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const user = await createUser("C5Buyer");
    await prisma.user.update({
      where: { id: user.userId },
      data: { coins: 1000 },
    });
    // See the C4 suite: powerup_shop_items survives cleanDatabase.
    const item = await prisma.powerupShopItem.upsert({
      where: { sku: "c5-trail-mix" },
      update: { active: true, testOnly: false, priceCoins: 75 },
      create: {
        sku: "c5-trail-mix",
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

    // Pre-warm INSIDE the 10s window. If the assertion below passed only
    // because the value expired, this warm read would have to be >10s old —
    // the elapsed assertion forbids that.
    const warm = await (await me(user.token)).json();
    assert.equal(warm.user.coins, 1000);
    assert.ok((await authMeKeys()).length > 0);

    const startedAt = Date.now();
    const purchase = await authReq("POST", "/shop/powerups/purchase", {
      body: { sku: item.sku },
      token: user.token,
      headers: { "Idempotency-Key": require("node:crypto").randomUUID() },
    });
    assert.equal(purchase.status, 200, await purchase.clone().text());

    // Direct proof of the mechanism: the cached value is GONE, not merely stale.
    assert.deepEqual(
      await authMeKeys(),
      [],
      "the coin seam must DELETE the cached /auth/me, not wait out the TTL"
    );

    const after = await (await me(user.token)).json();
    const elapsedMs = Date.now() - startedAt;
    assert.equal(after.user.coins, 925);
    assert.ok(
      elapsedMs < 1000,
      `new balance must be visible within 1s (took ${elapsedMs}ms)`
    );
  });

  it("awardCoins also invalidates (the other half of the coin seam)", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const user = await createUser("C5Award");
    await setFlag(true);
    await enableRedis();

    const before = await (await me(user.token)).json();
    assert.equal(before.user.coins, 0);

    const { awardCoins } = require("../../src/shared/economy/awardCoins");
    await awardCoins({
      userId: user.userId,
      amount: 250,
      reason: "test_award",
      refId: `c5-${Date.now()}`,
    });

    const after = await (await me(user.token)).json();
    assert.equal(after.user.coins, 250);
  });

  // ── onboarding progression readback ─────────────────────────────────────
  it("an onboarding-progression command is visible on the very next /auth/me", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const user = await createUser("C5Onboard");
    await setFlag(true);
    await enableRedis();

    let body = await (await me(user.token)).json();
    assert.equal(body.user.firstRaceOnboardingSeen, false);
    assert.equal(body.user.tutorialOnboardingSeen, false);

    const skip = await authReq("POST", "/races/onboarding/first-race-seen", {
      token: user.token,
    });
    assert.equal(skip.status, 200);
    body = await (await me(user.token)).json();
    assert.equal(
      body.user.firstRaceOnboardingSeen,
      true,
      "first-race onboarding readback"
    );

    const tut = await authReq("POST", "/tutorial/onboarding-seen", {
      token: user.token,
    });
    assert.equal(tut.status, 200);
    body = await (await me(user.token)).json();
    assert.equal(
      body.user.tutorialOnboardingSeen,
      true,
      "tutorial onboarding readback"
    );
  });

  it("equip/unequip and profile edits invalidate /auth/me", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const user = await createUser("C5Equip");
    const item = await prisma.shopItem.create({
      data: {
        sku: "c5-equip-hat",
        name: "Hat",
        description: "d",
        slot: "HEAD",
        priceCoins: 0,
        assetKey: "c5_equip_hat",
        active: true,
        testOnly: false,
        sortOrder: 1,
      },
    });
    await prisma.userShopItem.create({
      data: { userId: user.userId, shopItemId: item.id },
    });

    await setFlag(true);
    await enableRedis();
    await me(user.token); // warm

    const equip = await authReq("PUT", "/shop/equipment/HEAD", {
      body: { itemId: item.id },
      token: user.token,
    });
    assert.equal(equip.status, 200, await equip.clone().text());
    assert.deepEqual(
      await authMeKeys(),
      [],
      "equip must invalidate the assembled /auth/me"
    );

    await me(user.token); // re-warm
    const rename = await authReq("PUT", "/auth/me/display-name", {
      body: { displayName: "C5Renamed" },
      token: user.token,
    });
    assert.equal(rename.status, 200);
    const body = await (await me(user.token)).json();
    assert.equal(body.user.displayName, "C5Renamed");
  });

  it("a friend request the user receives is visible on the next /auth/me", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const user = await createUser("C5Badge");
    const sender = await createUser("C5BadgeSender");

    await setFlag(true);
    await enableRedis();
    let body = await (await me(user.token)).json();
    assert.equal(body.user.incomingFriendRequests, 0);

    await authReq("POST", "/friends/request", {
      body: { addresseeId: user.userId },
      token: sender.token,
    });

    body = await (await me(user.token)).json();
    assert.equal(
      body.user.incomingFriendRequests,
      1,
      "the friends-tab badge is read back straight after a friend mutation"
    );
  });

  // ── flag off / Redis off ────────────────────────────────────────────────
  it("flag OFF writes zero keys and returns the same payload", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const user = await createUser("C5FlagOff");
    await prisma.user.update({
      where: { id: user.userId },
      data: { coins: 42 },
    });

    await setFlag(false);
    await enableRedis();

    const body = await (await me(user.token)).json();
    assert.equal(body.user.coins, 42);
    assert.deepEqual(await authMeKeys(), []);
  });

  it("flag ON with REDIS_URL unset serves Postgres and writes nothing", async () => {
    const user = await createUser("C5NoRedis");
    await prisma.user.update({
      where: { id: user.userId },
      data: { coins: 77 },
    });

    await setFlag(true);
    await disableRedis();

    const body = await (await me(user.token)).json();
    assert.equal(body.user.coins, 77);
    if (!skipReason) assert.deepEqual(await authMeKeys(), []);
  });
});
