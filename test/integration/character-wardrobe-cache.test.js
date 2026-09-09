const assert = require("node:assert/strict");
const { it } = require("node:test");
const IORedis = require("ioredis");
process.env.CACHE_ENV_PREFIX = "t:";
delete process.env.REDIS_URL;
const { startTestRedis } = require("./redisTestServer");
const { startRedisFailProxy } = require("./helpers/redisFailProxy");
const { prisma, cleanDatabase, request, getSharedServer } = require("./setup");
// Infrastructure controls only: all appearance reads/writes below use HTTP.
const cache = require("../../src/shared/cache/redisCache");
const derived = require("../../src/shared/cache/derivedCache");
const { appSettings } = require("../../src/shared/config/appSettings");
for (const failedInvalidation of [false, true])
  it(`new wardrobe routes preserve warm public appearance and invalidate/bypass Redis (failed=${failedInvalidation})`, async () => {
    await cleanDatabase();
    const live = await startTestRedis();
    assert.ok(live, "A real local test Redis is required for this validation");
    const proxy = await startRedisFailProxy(live.url);
    const probe = new IORedis(live.url);
    const server = await getSharedServer();
    try {
      process.env.REDIS_URL = proxy.url;
      await cache.close();
      derived.reset();
      await probe.flushdb();
      for (const key of [
        "redisPresentationGenerationGuardEnabled",
        "redisCacheFriendsEnabled",
        "redisCacheAuthMeEnabled",
      ])
        await prisma.appSetting.upsert({
          where: { key },
          create: { key, value: true },
          update: { value: true },
        });
      appSettings.bustCache();
      async function user(name) {
        const r = await request(server.baseUrl, "POST", "/auth/apple", {
          body: { identityToken: `apple-wardrobe-cache-${name}` },
        });
        const b = await r.json();
        return { id: b.user.id, token: b.sessionToken };
      }
      const owner = await user("owner"),
        viewer = await user("viewer");
      await prisma.friendship.create({
        data: {
          requesterId: owner.id,
          addresseeId: viewer.id,
          status: "ACCEPTED",
        },
      });
      const hat = await prisma.shopItem.create({
          data: {
            sku: "cache_hat",
            name: "Hat",
            slot: "HEAD",
            assetKey: "birthday_hat",
            priceCoins: 0,
          },
        }),
        c = await prisma.shopItem.create({
          data: {
            sku: "cache_character",
            name: "Character",
            slot: "CHARACTER",
            assetKey: "corgi_puppy",
            priceCoins: 0,
          },
        });
      await prisma.userShopItem.createMany({
        data: [hat, c].map((i) => ({ userId: owner.id, shopItemId: i.id })),
      });
      await prisma.shopItemCharacterFit.create({
        data: {
          accessoryShopItemId: hat.id,
          characterKey: c.id,
          characterShopItemId: c.id,
        },
      });
      async function call(who, method, path, body) {
        const r = await request(server.baseUrl, method, path, {
          token: who.token,
          body,
          headers: { "X-Client-Features": "characters,remote_assets" },
        });
        assert.equal(r.status, 200, await r.clone().text());
        return r.json();
      }
      // Persist the owner's declared render capabilities before warming public
      // appearance; first-seen capability registration itself invalidates it.
      await call(owner, "GET", "/auth/me");
      const before = await call(viewer, "GET", "/friends");
      assert.equal(before.friends[0].animal, null);
      assert.deepEqual(before.friends[0].accessories, []);
      const key = `t:v1:user:cosmetics:${owner.id}`;
      const warm = await probe.get(key);
      assert.ok(
        warm,
        "Public appearance must actually be cached before the mutation",
      );
      await call(owner, "PUT", `/shop/characters/${c.id}/outfit`, {
        expectedOutfitRevision: 0,
        slots: { HEAD: hat.id, FACE: null, NECK: null, BACK: null, FEET: null },
      });
      assert.equal(await probe.get(key), warm);
      assert.deepEqual(await call(viewer, "GET", "/friends"), before);
      if (failedInvalidation) proxy.arm(["DEL", "EVAL", "EVALSHA"]);
      await call(owner, "PUT", "/shop/active-character", {
        characterKey: c.id,
        expectedOutfitRevision: 1,
        expectedAppearanceRevision: 0,
      });
      if (failedInvalidation) {
        assert.ok(proxy.failedCount() > 0);
        assert.equal(
          await probe.get(key),
          warm,
          "Failed invalidation leaves stale Redis data to exercise bypass",
        );
      } else assert.equal(await probe.get(key), null);
      const after = await call(viewer, "GET", "/friends");
      assert.equal(after.friends[0].animal, "corgi_puppy");
      assert.equal(after.friends[0].accessories[0].id, hat.id);
      // Repeat active save through the new route while Redis is unavailable/bypassed.
      await call(owner, "PUT", `/shop/characters/${c.id}/outfit`, {
        expectedOutfitRevision: 1,
        slots: { HEAD: null, FACE: null, NECK: null, BACK: null, FEET: null },
      });
      assert.deepEqual(
        (await call(viewer, "GET", "/friends")).friends[0].accessories,
        [],
      );
    } finally {
      proxy.disarm();
      await cache.close();
      derived.reset();
      delete process.env.REDIS_URL;
      await probe.quit();
      await proxy.close();
      await live.close();
    }
  });
