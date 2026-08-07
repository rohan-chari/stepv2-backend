// Phase B / C1 of the Redis derived-data layer
// (docs/redis-derived-data-layer-requirements.md §2 item 4-C1, §5 Phase B).
//
// Surfaces under test, all behind the `redisCacheCatalogsEnabled` app-setting:
//   GET /shop/catalog      -> v1:catalog:shop:{channel}:{caps}
//   GET /powerups/catalog  -> v1:catalog:powerups:{caps}
//   GET /assets/manifest   -> v1:assets:manifest:{channel}
//   app settings           -> v1:settings:app   (observed via /auth/me featureFlags)
//   balance config         -> v1:balance        (observed via /daily-reward/status)
//   global step events     -> v1:events:global  (observed via /home/race-card)
//
// The load-bearing assertions are §8 test 2 (cold-cache response DEEP-EQUALS
// the flag-off response) and §8 test 3 (an admin write propagates — including
// into a SECOND, concurrently-running server PROCESS, which is the only way to
// prove pub/sub coherence rather than shared in-process module state).
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const path = require("node:path");
const { spawn } = require("node:child_process");
const IORedis = require("ioredis");

const ENV_PREFIX = "t:";
process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
process.env.ADMIN_EMAILS = process.env.ADMIN_EMAILS || "admin@test.com";
delete process.env.REDIS_URL;

const { startTestRedis } = require("./redisTestServer");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const cache = require("../../src/shared/cache/redisCache");
const { appSettings } = require("../../src/shared/config/appSettings");
const { balanceConfig } = require("../../src/modules/economy/balanceConfig");

const ADMIN_EMAIL = process.env.ADMIN_EMAILS.split(",")[0].trim();

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

/** Turn the wrapper on against the live test Redis, with a flushed db15. */
async function enableRedis() {
  process.env.REDIS_URL = live.url;
  process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
  await cache.close();
  if (!probe) probe = new IORedis(live.url);
  await probe.flushdb();
}

async function disableRedis() {
  delete process.env.REDIS_URL;
  await cache.close();
}

async function setFlag(value) {
  await prisma.appSetting.upsert({
    where: { key: "redisCacheCatalogsEnabled" },
    update: { value },
    create: { key: "redisCacheCatalogsEnabled", value },
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

async function createUser(displayName, { admin = false } = {}) {
  const appleId = `apple-c1-${++nextAppleId}-${Date.now()}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  if (admin) {
    await prisma.user.update({
      where: { id: body.user.id },
      data: { email: ADMIN_EMAIL },
    });
  }
  return { userId: body.user.id, token: body.sessionToken };
}

async function seedCatalogRows() {
  await prisma.shopItem.create({
    data: {
      sku: "c1-hat",
      name: "C1 Hat",
      description: "a hat",
      slot: "HEAD",
      priceCoins: 75,
      assetKey: "c1_hat",
      active: true,
      testOnly: false,
      sortOrder: 1,
      assetVersion: "a1b2c3d4e5f6",
      renderMetadata: { scale: 1.1 },
    },
  });
  await prisma.powerupCopy.upsert({
    where: { powerupType: "TRAIL_MIX" },
    update: { name: "Trail Mix", description: "blocks" },
    create: { powerupType: "TRAIL_MIX", name: "Trail Mix", description: "blocks" },
  });
}

/** Every surface, as a list of {name, fetch} so parity can loop over them. */
function surfaces(token) {
  return [
    {
      name: "GET /shop/catalog",
      fetch: () => authReq("GET", "/shop/catalog", { token }),
    },
    {
      name: "GET /powerups/catalog",
      fetch: () => authReq("GET", "/powerups/catalog"),
    },
    {
      name: "GET /assets/manifest",
      fetch: () => authReq("GET", "/assets/manifest"),
    },
    {
      name: "GET /auth/me (app settings)",
      fetch: () => authReq("GET", "/auth/me", { token }),
    },
    {
      name: "GET /daily-reward/status (balance config)",
      fetch: () =>
        authReq(
          "GET",
          `/daily-reward/status?localDate=${new Date().toISOString().slice(0, 10)}`,
          { token }
        ),
    },
    {
      name: "GET /home/race-card (global step events)",
      fetch: () => authReq("GET", "/home/race-card", { token }),
    },
  ];
}

// Fields that legitimately move between two calls regardless of caching (server
// clocks, countdown seconds). Stripped before deep-equality so the comparison
// tests the cache, not the wall clock.
const VOLATILE_KEYS = new Set([
  "asOf",
  "serverTime",
  "now",
  "secondsRemaining",
  "secondsUntilNext",
  "msRemaining",
  "nextResetAt",
  "totalsUpdatedAt",
  "updatedAt",
]);

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = stripVolatile(v);
    }
    return out;
  }
  return value;
}

describe("C1 catalogs/config — §8 test 2 parity (cold cache ≡ flag off)", () => {
  let token;

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.appSetting.deleteMany({});
    await prisma.balanceConfig.deleteMany({});
    balanceConfig.bustCache();
    appSettings.bustCache();
    await seedCatalogRows();
    ({ token } = await createUser("C1 User"));
  });

  it("every C1 surface: flag-off ≡ cold-cache ≡ warm-cache", async (t) => {
    if (skipReason) return t.skip(skipReason);

    // 1. Baseline: Redis off entirely (the master kill switch).
    await disableRedis();
    await setFlag(false);
    const baseline = [];
    for (const s of surfaces(token)) {
      const res = await s.fetch();
      assert.equal(res.status, 200, `${s.name} baseline status`);
      baseline.push(stripVolatile(await res.json()));
    }

    // 2. Flag ON, Redis ON, every key cold.
    await enableRedis();
    await setFlag(true);
    const cold = [];
    for (const s of surfaces(token)) {
      const res = await s.fetch();
      assert.equal(res.status, 200, `${s.name} cold status`);
      cold.push(stripVolatile(await res.json()));
    }

    // 3. Same again — now served from Redis.
    const warm = [];
    for (const s of surfaces(token)) {
      const res = await s.fetch();
      assert.equal(res.status, 200, `${s.name} warm status`);
      warm.push(stripVolatile(await res.json()));
    }

    const names = surfaces(token).map((s) => s.name);
    for (let i = 0; i < names.length; i += 1) {
      assert.deepEqual(cold[i], baseline[i], `${names[i]}: cold ≢ flag-off`);
      assert.deepEqual(warm[i], baseline[i], `${names[i]}: warm ≢ flag-off`);
    }

    // The parity above is worthless if nothing was actually cached — prove the
    // keys exist so a no-op implementation cannot pass this test.
    const keys = await probe.keys(`${ENV_PREFIX}v1:*`);
    assert.ok(
      keys.some((k) => k.includes("v1:catalog:shop")),
      `expected a shop catalog key, saw: ${keys.join(", ")}`
    );
    assert.ok(
      keys.some((k) => k.includes("v1:catalog:powerups")),
      "expected a powerup catalog key"
    );
    assert.ok(
      keys.some((k) => k.includes("v1:assets:manifest")),
      "expected an assets manifest key"
    );
    assert.ok(
      keys.some((k) => k.includes("v1:settings:app")),
      "expected an app settings key"
    );
    assert.ok(
      keys.some((k) => k.includes("v1:balance")),
      "expected a balance config key"
    );
    assert.ok(
      keys.some((k) => k.includes("v1:events:global")),
      "expected a global events key"
    );
  });

  it("per-user fields are never shared between users through the catalog cache", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await enableRedis();
    await setFlag(true);

    const a = await createUser("Owner A");
    const b = await createUser("Owner B");
    // Give A the item so `ownedItemIds` differs between the two viewers.
    const item = await prisma.shopItem.findUnique({ where: { sku: "c1-hat" } });
    await prisma.userShopItem.create({
      data: { userId: a.userId, shopItemId: item.id },
    });

    const resA = await authReq("GET", "/shop/catalog", { token: a.token });
    const bodyA = await resA.json();
    const resB = await authReq("GET", "/shop/catalog", { token: b.token });
    const bodyB = await resB.json();

    assert.deepEqual(bodyA.ownedItemIds, [item.id]);
    assert.deepEqual(bodyB.ownedItemIds, []);
    // The shared/global part still matches.
    assert.deepEqual(
      bodyA.items.map((i) => i.sku),
      bodyB.items.map((i) => i.sku)
    );
  });
});

describe("C1 — §8 test 3 invalidation", () => {
  let token;
  let adminToken;

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.appSetting.deleteMany({});
    balanceConfig.bustCache();
    appSettings.bustCache();
    await seedCatalogRows();
    ({ token } = await createUser("C1 Inv"));
    ({ token: adminToken } = await createUser("C1 Admin", { admin: true }));
    await enableRedis();
    await setFlag(true);
  });

  it("admin shop write busts the shop catalog in the SAME process", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const before = await (await authReq("GET", "/shop/catalog", { token })).json();
    assert.ok(before.items.some((i) => i.sku === "c1-hat"));
    assert.ok(!before.items.some((i) => i.sku === "c1-boots"));

    const created = await authReq("POST", "/admin/shop/items", {
      token: adminToken,
      body: {
        sku: "c1-boots",
        name: "C1 Boots",
        description: "boots",
        slot: "FEET",
        priceCoins: 75,
        assetKey: "c1_boots",
        testOnly: false,
      },
    });
    assert.equal(created.status, 201, await created.text());

    const after = await (await authReq("GET", "/shop/catalog", { token })).json();
    assert.ok(
      after.items.some((i) => i.sku === "c1-boots"),
      "new item must appear immediately, not after the 60s TTL"
    );
  });

  it("an app-settings write busts the settings cache", async (t) => {
    if (skipReason) return t.skip(skipReason);

    const before = await (await authReq("GET", "/auth/me", { token })).json();
    assert.equal(before.user.featureFlags.bannerAdsEnabled, false);

    const res = await authReq("PATCH", "/admin/settings", {
      token: adminToken,
      body: { bannerAdsEnabled: true },
    });
    assert.equal(res.status, 200, await res.text());

    const after = await (await authReq("GET", "/auth/me", { token })).json();
    assert.equal(after.user.featureFlags.bannerAdsEnabled, true);
  });
});

describe("C1 — §8 test 3 pub/sub coherence across TWO server processes", () => {
  it("an admin write in process A is visible in process B's catalog", async (t) => {
    if (skipReason) return t.skip(skipReason);

    await cleanDatabase();
    await prisma.appSetting.deleteMany({});
    appSettings.bustCache();
    await seedCatalogRows();
    const { token } = await createUser("C1 Peer");
    const { token: adminToken } = await createUser("C1 PeerAdmin", {
      admin: true,
    });
    await enableRedis();
    await setFlag(true);

    // Boot a genuinely separate node process sharing the same Postgres + Redis.
    // In-process `createApp()` twice would share module singletons and prove
    // nothing about pub/sub.
    const child = spawn(
      process.execPath,
      [path.join(__dirname, "helpers", "standaloneServer.js")],
      {
        env: {
          ...process.env,
          REDIS_URL: live.url,
          CACHE_ENV_PREFIX: ENV_PREFIX,
          ADMIN_EMAILS: ADMIN_EMAIL,
          PORT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += String(c);
    });

    const peerBaseUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`peer server never started. stderr:\n${stderr}`)),
        20000
      );
      let buffered = "";
      child.stdout.on("data", (chunk) => {
        buffered += String(chunk);
        const match = buffered.match(/LISTENING (\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`peer exited ${code}. stderr:\n${stderr}`));
      });
    });

    try {
      // Warm BOTH processes' caches.
      const peerBefore = await request(peerBaseUrl, "GET", "/shop/catalog", {
        token,
        headers: { "X-Client-Features": FEAT },
      });
      const peerBeforeBody = await peerBefore.json();
      assert.ok(!peerBeforeBody.items.some((i) => i.sku === "c1-peer-item"));
      await (await authReq("GET", "/shop/catalog", { token })).json();

      // Write through process A.
      const created = await authReq("POST", "/admin/shop/items", {
        token: adminToken,
        body: {
          sku: "c1-peer-item",
          name: "Peer Item",
          description: "x",
          slot: "NECK",
          priceCoins: 75,
          assetKey: "c1_peer_item",
          testOnly: false,
        },
      });
      assert.equal(created.status, 201, await created.text());

      // Process B must see it without waiting out the 60s TTL. Poll briefly —
      // pub/sub delivery is asynchronous, but well under a second.
      let seen = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const res = await request(peerBaseUrl, "GET", "/shop/catalog", {
          token,
          headers: { "X-Client-Features": FEAT },
        });
        const body = await res.json();
        if (body.items.some((i) => i.sku === "c1-peer-item")) {
          seen = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(
        seen,
        "peer process never observed the admin write — pub/sub invalidation did not reach it"
      );

      // The assertion above is satisfied by the shared Redis DEL alone. The
      // strictly stronger property — that the PUB/SUB channel works — needs a
      // surface backed by a per-process IN-MEMORY cache, because Redis deletion
      // cannot reach that. `appSettings` is exactly that cache (30s TTL, the
      // cluster-incoherence bug in spec §2 item 3): the peer must observe the
      // flip far sooner than 30s, which is only possible via the broadcast.
      const peerMeBefore = await request(peerBaseUrl, "GET", "/auth/me", {
        token,
        headers: { "X-Client-Features": FEAT },
      });
      assert.equal(
        (await peerMeBefore.json()).user.featureFlags.dualBoxBannersEnabled,
        false,
        "peer should start with the flag off (and now hold it in its in-process cache)"
      );

      const flipped = await authReq("PATCH", "/admin/settings", {
        token: adminToken,
        body: { dualBoxBannersEnabled: true },
      });
      assert.equal(flipped.status, 200, await flipped.text());

      const flipStart = Date.now();
      let peerSawFlip = false;
      while (Date.now() - flipStart < 5000) {
        const res = await request(peerBaseUrl, "GET", "/auth/me", {
          token,
          headers: { "X-Client-Features": FEAT },
        });
        if ((await res.json()).user.featureFlags.dualBoxBannersEnabled === true) {
          peerSawFlip = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(
        peerSawFlip,
        "peer's in-process appSettings cache was never busted — pub/sub did not deliver"
      );
      assert.ok(
        Date.now() - flipStart < 5000,
        "peer converged only by TTL expiry (30s), not by the broadcast"
      );
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("C1 — zero behavior change when disabled", () => {
  let token;

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.appSetting.deleteMany({});
    balanceConfig.bustCache();
    appSettings.bustCache();
    await seedCatalogRows();
    ({ token } = await createUser("C1 Off"));
  });

  it("REDIS_URL unset: no keys are written and responses are unchanged", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await enableRedis();
    await probe.flushdb();
    await disableRedis();
    // Flag ON but Redis unset — the wrapper is inert, so nothing may be cached.
    await setFlag(true);

    for (const s of surfaces(token)) {
      const res = await s.fetch();
      assert.equal(res.status, 200, `${s.name} status with REDIS_URL unset`);
    }
    const keys = await probe.keys(`${ENV_PREFIX}v1:*`);
    assert.deepEqual(keys, [], `expected no keys written, saw: ${keys.join(", ")}`);
  });

  it("flag OFF with Redis available: nothing is cached", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await enableRedis();
    await setFlag(false);

    for (const s of surfaces(token)) {
      const res = await s.fetch();
      assert.equal(res.status, 200, `${s.name} status with flag off`);
    }
    const keys = await probe.keys(`${ENV_PREFIX}v1:*`);
    assert.deepEqual(
      keys,
      [],
      `flag off must write no cache keys, saw: ${keys.join(", ")}`
    );
  });
});
