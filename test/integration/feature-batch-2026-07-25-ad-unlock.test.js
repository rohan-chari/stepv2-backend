// Feature batch 2026-07-25 — §7 ad-to-buy.
//
// Covers spec §9 tests 4, 5, 6, 7, 8, 9 and 19:
//   4  — daily cap: the second unlock in a local day 409s DAILY_CAP_REACHED and
//        debits no coins / consumes no ad grant.
//   5  — the cap is ONE TOTAL across powerups and cosmetics (D4).
//   6  — old-client compat: a request with NO `localDate` still succeeds. This
//        is the regression that would break every currently-shipped binary.
//   7  — shortfall: with MAX_SHORTFALL=20, 15 short succeeds on 1 ad; 90 short
//        400s SHORTFALL_TOO_LARGE with no grant consumed.
//   8  — cosmetics: grants into user_shop_items, zeroes coins, writes the
//        ledger row, idempotent on retry, testOnly not unlockable on prod.
//   9  — the catalog `adUnlock` block reflects the env values.
//   19 — the SHORTFALL_TOO_LARGE path really is "wasted time only".
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { grantAdReward } = require("../../src/modules/economy/commands/grantAdReward");

let server;
let nextAppleId = 0;

const ALL_FEATURES = {
  "X-Client-Features": "characters,jammer,powerups2,powerups3,powerups4,powerups5,ads",
};

const POWERUP_SKU = "POWERUP_CLEANSE";
const COSMETIC_SKU = "test_corgi_puppy";

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function seedCatalog() {
  await prisma.powerupShopItem.upsert({
    where: { sku: POWERUP_SKU },
    update: { priceCoins: 150, active: true, testOnly: false, powerupType: "CLEANSE" },
    create: {
      sku: POWERUP_SKU,
      name: "Cleanse",
      description: "Cleanse test row",
      powerupType: "CLEANSE",
      priceCoins: 150,
      sortOrder: 1,
      active: true,
      testOnly: false,
    },
  });
  return prisma.shopItem.create({
    data: {
      sku: COSMETIC_SKU,
      name: "Corgi Puppy",
      description: "A stubby-legged speedster. Zoomies: 3x steps for 10 minutes, twice a day!",
      slot: "CHARACTER",
      priceCoins: 400,
      assetKey: "corgi_puppy",
      active: true,
      testOnly: false,
      earnOnly: false,
      sortOrder: 5,
    },
  });
}

async function createUser(coins = 0) {
  const appleId = `apple-adunlock-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  if (coins > 0) {
    await prisma.user.update({ where: { id: body.user.id }, data: { coins } });
  }
  return { userId: body.user.id, token: body.sessionToken };
}

// Seed an SSV-verified watch exactly as the AdMob callback would.
async function seedWatch(userId, kind, sku, n) {
  return prisma.adRewardGrant.create({
    data: {
      userId,
      transactionId: `txn-${kind}-${userId}-${sku}-${n}-${Math.random()}`,
      rewardKind: kind,
      shopItemId: sku,
      grantedDate: today(),
    },
  });
}

async function unlockPowerup(token, sku, key, body = {}) {
  const res = await request(server.baseUrl, "POST", "/shop/powerups/unlock-with-ads", {
    body: { sku, idempotencyKey: key, ...body },
    token,
    headers: { ...ALL_FEATURES, "Idempotency-Key": key },
  });
  return { status: res.status, body: await res.json() };
}

async function unlockCosmetic(token, sku, key, body = {}) {
  const res = await request(
    server.baseUrl,
    "POST",
    `/shop/${encodeURIComponent(sku)}/unlock-with-ads`,
    {
      body: { idempotencyKey: key, ...body },
      token,
      headers: { ...ALL_FEATURES, "Idempotency-Key": key },
    }
  );
  return { status: res.status, body: await res.json() };
}

async function coinsOf(userId) {
  return (await prisma.user.findUnique({ where: { id: userId } })).coins;
}

async function unconsumedWatches(userId) {
  return prisma.adRewardGrant.count({ where: { userId, consumedAt: null } });
}

describe("feature batch 2026-07-25 — §7 ad-to-buy", () => {
  const envBackup = {};
  before(async () => {
    server = await getSharedServer();
    envBackup.max = process.env.POWERUP_UNLOCK_MAX_SHORTFALL;
    envBackup.cap = process.env.POWERUP_UNLOCK_DAILY_CAP;
  });

  after(() => {
    if (envBackup.max === undefined) delete process.env.POWERUP_UNLOCK_MAX_SHORTFALL;
    else process.env.POWERUP_UNLOCK_MAX_SHORTFALL = envBackup.max;
    if (envBackup.cap === undefined) delete process.env.POWERUP_UNLOCK_DAILY_CAP;
    else process.env.POWERUP_UNLOCK_DAILY_CAP = envBackup.cap;
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    delete process.env.POWERUP_UNLOCK_MAX_SHORTFALL;
    delete process.env.POWERUP_UNLOCK_DAILY_CAP;
    await seedCatalog();
  });

  // ── Test 7 + 19: the 20-coin shortfall ceiling ────────────────────────────
  describe("shortfall ceiling (default 20)", () => {
    it("15 short succeeds on a single ad", async () => {
      const user = await createUser(135); // 150 - 135 = 15
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 1);

      const res = await unlockPowerup(user.token, POWERUP_SKU, "sf-ok-1");
      assert.equal(res.status, 200);
      assert.equal(res.body.adsWatched, 1);
      assert.equal(res.body.coins, 0);
      assert.equal(await coinsOf(user.userId), 0);
    });

    it("90 short is rejected with SHORTFALL_TOO_LARGE", async () => {
      const user = await createUser(60); // 150 - 60 = 90
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 1);
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 2);

      const res = await unlockPowerup(user.token, POWERUP_SKU, "sf-bad-1");
      assert.equal(res.status, 400);
      assert.equal(res.body.code, "SHORTFALL_TOO_LARGE");
    });

    it("test 19 — the SHORTFALL_TOO_LARGE path consumes no grant and debits no coins", async () => {
      const user = await createUser(60);
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 1);
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 2);

      const res = await unlockPowerup(user.token, POWERUP_SKU, "sf-bad-2");
      assert.equal(res.status, 400);
      assert.equal(await coinsOf(user.userId), 60, "no coins debited");
      assert.equal(await unconsumedWatches(user.userId), 2, "no ad grant consumed");
      assert.equal(
        await prisma.userPowerupItem.count({ where: { userId: user.userId } }),
        0
      );
      assert.equal(
        await prisma.coinTransaction.count({ where: { userId: user.userId } }),
        0
      );
    });

    it("the SHORTFALL_TOO_LARGE message explains the new rule to stranded old clients", async () => {
      const user = await createUser(0);
      const res = await unlockPowerup(user.token, POWERUP_SKU, "sf-msg");
      assert.equal(res.status, 400);
      assert.equal(res.body.code, "SHORTFALL_TOO_LARGE");
      assert.match(res.body.error, /20 coins/);
      assert.match(res.body.error, /Update the app/i);
    });

    it("POWERUP_UNLOCK_MAX_SHORTFALL is env-overridable and read per request", async () => {
      process.env.POWERUP_UNLOCK_MAX_SHORTFALL = "150";
      const user = await createUser(60); // shortfall 90
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 1);
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 2);

      const res = await unlockPowerup(user.token, POWERUP_SKU, "sf-env-1");
      assert.equal(res.status, 200, "restoring 150 is the kill switch");
      assert.equal(res.body.adsWatched, 2);
    });

    it("a malformed override falls back to the default rather than disabling the gate", async () => {
      process.env.POWERUP_UNLOCK_MAX_SHORTFALL = "nonsense";
      const user = await createUser(60);
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 1);
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 2);

      const res = await unlockPowerup(user.token, POWERUP_SKU, "sf-env-2");
      assert.equal(res.status, 400);
      assert.equal(res.body.code, "SHORTFALL_TOO_LARGE");
    });
  });

  // ── Test 6: old-client compat ─────────────────────────────────────────────
  describe("old-client compat — localDate is OPTIONAL", () => {
    it("a request with NO localDate succeeds (every currently-shipped binary)", async () => {
      const user = await createUser(140);
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 1);

      const res = await unlockPowerup(user.token, POWERUP_SKU, "nodate-1");
      assert.equal(res.status, 200);
      assert.equal(res.body.adsWatched, 1);
      assert.equal(await coinsOf(user.userId), 0);
    });

    it("a present-but-malformed localDate is a 400", async () => {
      const user = await createUser(140);
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 1);

      const res = await unlockPowerup(user.token, POWERUP_SKU, "baddate-1", {
        localDate: "07/25/2026",
      });
      assert.equal(res.status, 400);
      assert.equal(await coinsOf(user.userId), 140, "nothing was spent");
      assert.equal(await unconsumedWatches(user.userId), 1);
    });

    it("a localDate far from server time is a 400", async () => {
      const user = await createUser(140);
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 1);

      const res = await unlockPowerup(user.token, POWERUP_SKU, "fardate-1", {
        localDate: "2020-01-01",
      });
      assert.equal(res.status, 400);
      assert.equal(await coinsOf(user.userId), 140);
    });

    it("a well-formed localDate is accepted", async () => {
      const user = await createUser(140);
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 1);

      const res = await unlockPowerup(user.token, POWERUP_SKU, "gooddate-1", {
        localDate: today(),
      });
      assert.equal(res.status, 200);
    });
  });

  // ── Test 4 + 5: the daily cap ─────────────────────────────────────────────
  describe("daily cap (default 1, shared across flows)", () => {
    it("test 4 — the second powerup unlock the same day 409s with no debit and no consume", async () => {
      const user = await createUser(140);
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 1);

      const first = await unlockPowerup(user.token, POWERUP_SKU, "cap-1");
      assert.equal(first.status, 200);
      assert.equal(first.body.adUnlockDailyCap, 1);
      assert.equal(first.body.adUnlockRemainingToday, 0);

      // Top the user back up and seed a fresh watch for a second attempt.
      await prisma.user.update({
        where: { id: user.userId },
        data: { coins: 140 },
      });
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 2);

      const second = await unlockPowerup(user.token, POWERUP_SKU, "cap-2");
      assert.equal(second.status, 409);
      assert.equal(second.body.code, "DAILY_CAP_REACHED");
      assert.equal(await coinsOf(user.userId), 140, "no coins debited");
      assert.equal(await unconsumedWatches(user.userId), 1, "the new watch is untouched");
      assert.equal(
        (await prisma.userPowerupItem.findUnique({
          where: { userId_powerupType: { userId: user.userId, powerupType: "CLEANSE" } },
        }))?.quantity,
        1,
        "still exactly one granted powerup"
      );
    });

    it("test 5 — a powerup unlock and then a cosmetic unlock the same day: the second 409s (D4)", async () => {
      const user = await createUser(140);
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 1);
      const first = await unlockPowerup(user.token, POWERUP_SKU, "cross-1");
      assert.equal(first.status, 200);

      await prisma.user.update({
        where: { id: user.userId },
        data: { coins: 390 }, // cosmetic costs 400 -> 10 short
      });
      await seedWatch(user.userId, "shop_unlock", COSMETIC_SKU, 1);

      const second = await unlockCosmetic(user.token, COSMETIC_SKU, "cross-2");
      assert.equal(second.status, 409);
      assert.equal(second.body.code, "DAILY_CAP_REACHED");
      assert.equal(await coinsOf(user.userId), 390);
      assert.equal(
        await prisma.userShopItem.count({ where: { userId: user.userId } }),
        0
      );
    });

    it("and the reverse order: a cosmetic unlock blocks a later powerup unlock", async () => {
      const user = await createUser(390);
      await seedWatch(user.userId, "shop_unlock", COSMETIC_SKU, 1);
      const first = await unlockCosmetic(user.token, COSMETIC_SKU, "rev-1");
      assert.equal(first.status, 200);

      await prisma.user.update({ where: { id: user.userId }, data: { coins: 140 } });
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 1);
      const second = await unlockPowerup(user.token, POWERUP_SKU, "rev-2");
      assert.equal(second.status, 409);
      assert.equal(second.body.code, "DAILY_CAP_REACHED");
    });

    it("an idempotent retry of the SAME unlock is not blocked by the cap", async () => {
      const user = await createUser(140);
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 1);

      const first = await unlockPowerup(user.token, POWERUP_SKU, "idem-cap");
      assert.equal(first.status, 200);
      const retry = await unlockPowerup(user.token, POWERUP_SKU, "idem-cap");
      assert.equal(retry.status, 200);
      assert.equal(retry.body.idempotent, true);
    });

    it("POWERUP_UNLOCK_DAILY_CAP is env-tunable (raising it is the kill switch)", async () => {
      process.env.POWERUP_UNLOCK_DAILY_CAP = "2";
      const user = await createUser(140);
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 1);
      assert.equal((await unlockPowerup(user.token, POWERUP_SKU, "cap2-1")).status, 200);

      await prisma.user.update({ where: { id: user.userId }, data: { coins: 140 } });
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 2);
      const second = await unlockPowerup(user.token, POWERUP_SKU, "cap2-2");
      assert.equal(second.status, 200);
      assert.equal(second.body.adUnlockRemainingToday, 0);
    });

    it("yesterday's consumed unlock does not count against today", async () => {
      const user = await createUser(140);
      const stale = await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 0);
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      await prisma.adRewardGrant.update({
        where: { id: stale.id },
        data: { consumedAt: new Date(), grantedDate: yesterday },
      });

      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 1);
      const res = await unlockPowerup(user.token, POWERUP_SKU, "yday-1");
      assert.equal(res.status, 200);
    });
  });

  // ── Test 8: cosmetics ─────────────────────────────────────────────────────
  describe("cosmetic unlock-with-ads", () => {
    it("grants the cosmetic, zeroes coins, writes a ledger row, and is idempotent", async () => {
      const user = await createUser(390); // 400 - 390 = 10 short -> 1 ad
      await seedWatch(user.userId, "shop_unlock", COSMETIC_SKU, 1);

      const res = await unlockCosmetic(user.token, COSMETIC_SKU, "cos-1");
      assert.equal(res.status, 200);
      assert.equal(res.body.coins, 0);
      assert.equal(res.body.adsWatched, 1);
      assert.equal(res.body.owned, true);
      assert.equal(res.body.idempotent, false);
      assert.equal(res.body.item.sku, COSMETIC_SKU);
      assert.equal(res.body.item.slot, "CHARACTER");
      assert.equal(res.body.item.priceCoins, 400);

      assert.equal(await coinsOf(user.userId), 0);
      assert.equal(
        await prisma.userShopItem.count({ where: { userId: user.userId } }),
        1
      );
      const ledger = await prisma.coinTransaction.findMany({
        where: { userId: user.userId },
      });
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].reason, "shop_unlock_ads");
      assert.equal(ledger[0].amount, -390);

      const retry = await unlockCosmetic(user.token, COSMETIC_SKU, "cos-1");
      assert.equal(retry.status, 200);
      assert.equal(retry.body.idempotent, true);
      assert.equal(
        await prisma.userShopItem.count({ where: { userId: user.userId } }),
        1,
        "no double grant"
      );
      assert.equal(
        await prisma.coinTransaction.count({ where: { userId: user.userId } }),
        1
      );
    });

    it("consumes exactly the verified watches and refuses when one is missing", async () => {
      process.env.POWERUP_UNLOCK_MAX_SHORTFALL = "150";
      const user = await createUser(300); // 100 short -> 2 ads
      await seedWatch(user.userId, "shop_unlock", COSMETIC_SKU, 1);

      const res = await unlockCosmetic(user.token, COSMETIC_SKU, "cos-2");
      assert.equal(res.status, 409);
      assert.equal(res.body.code, "AD_NOT_VERIFIED");
      assert.equal(await coinsOf(user.userId), 300);
      assert.equal(await unconsumedWatches(user.userId), 1);
    });

    it("rejects when the user can already afford it", async () => {
      const user = await createUser(500);
      const res = await unlockCosmetic(user.token, COSMETIC_SKU, "cos-3");
      assert.equal(res.status, 400);
      assert.equal(res.body.code, "ALREADY_AFFORDABLE");
      assert.equal(await coinsOf(user.userId), 500);
    });

    it("a testOnly cosmetic is not unlockable on the prod channel", async () => {
      await prisma.shopItem.update({
        where: { sku: COSMETIC_SKU },
        data: { testOnly: true },
      });
      const user = await createUser(390);
      await seedWatch(user.userId, "shop_unlock", COSMETIC_SKU, 1);

      const res = await unlockCosmetic(user.token, COSMETIC_SKU, "cos-4");
      assert.equal(res.status, 404);
      assert.equal(
        await prisma.userShopItem.count({ where: { userId: user.userId } }),
        0
      );
      assert.equal(await unconsumedWatches(user.userId), 1);
    });

    it("an unknown sku is a 404 (the frozen-old-client / absent-item signal)", async () => {
      const user = await createUser(390);
      const res = await unlockCosmetic(user.token, "no_such_item", "cos-5");
      assert.equal(res.status, 404);
    });

    it("an already-owned cosmetic is not re-charged", async () => {
      const item = await prisma.shopItem.findUnique({ where: { sku: COSMETIC_SKU } });
      const user = await createUser(390);
      await prisma.userShopItem.create({
        data: { userId: user.userId, shopItemId: item.id },
      });
      await seedWatch(user.userId, "shop_unlock", COSMETIC_SKU, 1);

      const res = await unlockCosmetic(user.token, COSMETIC_SKU, "cos-6");
      assert.equal(res.status, 400);
      assert.equal(res.body.code, "ALREADY_OWNED");
      assert.equal(await coinsOf(user.userId), 390);
      assert.equal(await unconsumedWatches(user.userId), 1);
    });

    it("grantAdReward maps SSV custom_data 'shop_unlock:<userId>:<sku>' to a consumable watch", async () => {
      const user = await createUser(390);
      const granted = await grantAdReward({
        userId: user.userId,
        transactionId: `ssv-shop-${user.userId}`,
        adUnit: "test-unit",
        customData: `shop_unlock:${user.userId}:${COSMETIC_SKU}`,
        serverDate: today(),
      });
      assert.equal(granted.granted, true);
      const grant = await prisma.adRewardGrant.findFirst({
        where: { userId: user.userId, rewardKind: "shop_unlock" },
      });
      assert.ok(grant, "the callback minted a shop_unlock grant");
      assert.equal(grant.shopItemId, COSMETIC_SKU);

      const res = await unlockCosmetic(user.token, COSMETIC_SKU, "cos-7");
      assert.equal(res.status, 200);
      assert.equal(res.body.adsWatched, 1);
    });
  });

  // ── Test 9: catalog block ─────────────────────────────────────────────────
  describe("catalog adUnlock block", () => {
    it("the powerup store reports the live env values", async () => {
      const user = await createUser(0);
      const res = await request(server.baseUrl, "GET", "/shop/powerups", {
        token: user.token,
        headers: ALL_FEATURES,
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.adUnlock, "adUnlock block is present");
      assert.equal(body.adUnlock.maxShortfall, 20);
      assert.equal(body.adUnlock.coinsPerAd, 50);
      assert.equal(body.adUnlock.maxAds, 3);
      assert.equal(body.adUnlock.dailyCap, 1);
      assert.equal(body.adUnlock.remainingToday, 1);
    });

    it("the cosmetic catalog carries the same block", async () => {
      const user = await createUser(0);
      const res = await request(server.baseUrl, "GET", "/shop/catalog", {
        token: user.token,
        headers: ALL_FEATURES,
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.adUnlock);
      assert.equal(body.adUnlock.maxShortfall, 20);
      assert.equal(body.adUnlock.dailyCap, 1);
    });

    it("reflects an env override and a spent daily allowance", async () => {
      process.env.POWERUP_UNLOCK_MAX_SHORTFALL = "40";
      process.env.POWERUP_UNLOCK_DAILY_CAP = "2";
      const user = await createUser(140);
      await seedWatch(user.userId, "powerup_unlock", POWERUP_SKU, 1);
      assert.equal((await unlockPowerup(user.token, POWERUP_SKU, "cat-1")).status, 200);

      const res = await request(server.baseUrl, "GET", "/shop/powerups", {
        token: user.token,
        headers: ALL_FEATURES,
      });
      const body = await res.json();
      assert.equal(body.adUnlock.maxShortfall, 40);
      assert.equal(body.adUnlock.dailyCap, 2);
      assert.equal(body.adUnlock.remainingToday, 1, "one of two used today");
    });
  });
});
