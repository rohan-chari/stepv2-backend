const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { grantAdReward } = require("../../src/modules/economy/commands/grantAdReward");

// Backend batch 2026-07-24 — item 9 (shop catalog category + rarity) and item 10
// (POST /shop/powerups/unlock-with-ads: SSV-verified, zero-out coins).

let server;
let nextAppleId = 0;

const ALL_FEATURES = {
  "X-Client-Features": "characters,jammer,powerups2,powerups3,powerups4,powerups5,ads",
};

// A spread across all three categories.
const STORE_POWERUPS = [
  { sku: "POWERUP_SIGNAL_JAMMER", name: "Signal Jammer", powerupType: "SIGNAL_JAMMER", priceCoins: 75, sortOrder: 0 },
  { sku: "POWERUP_CLEANSE", name: "Cleanse", powerupType: "CLEANSE", priceCoins: 150, sortOrder: 1 },
  { sku: "POWERUP_RUNNERS_HIGH", name: "Runner's High", powerupType: "RUNNERS_HIGH", priceCoins: 75, sortOrder: 2 },
];

async function seedStoreCatalog() {
  for (const p of STORE_POWERUPS) {
    await prisma.powerupShopItem.upsert({
      where: { sku: p.sku },
      update: { priceCoins: p.priceCoins, active: true, testOnly: false, powerupType: p.powerupType },
      create: { ...p, description: `${p.name} test row`, active: true, testOnly: false },
    });
  }
}

async function createUser(coins = 0) {
  const appleId = `apple-fb724shop-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  if (coins > 0) {
    await prisma.user.update({ where: { id: body.user.id }, data: { coins } });
  }
  return { userId: body.user.id, token: body.sessionToken };
}

async function getPowerupShop(token) {
  const res = await request(server.baseUrl, "GET", "/shop/powerups", { token, headers: ALL_FEATURES });
  assert.equal(res.status, 200);
  return res.json();
}

// Seed an SSV-verified powerup-unlock watch exactly as the AdMob callback would
// (grantAdReward stamps rewardKind + shopItemId from custom_data
// "powerup_unlock:<userId>:<sku>").
async function seedUnlockWatch(userId, sku, n) {
  return prisma.adRewardGrant.create({
    data: {
      userId,
      transactionId: `txn-unlock-${userId}-${sku}-${n}`,
      rewardKind: "powerup_unlock",
      shopItemId: sku,
      grantedDate: new Date().toISOString().slice(0, 10),
    },
  });
}

async function unlock(token, sku, idempotencyKey) {
  const res = await request(server.baseUrl, "POST", "/shop/powerups/unlock-with-ads", {
    body: { sku, idempotencyKey },
    token,
    headers: { ...ALL_FEATURES, "Idempotency-Key": idempotencyKey },
  });
  return { status: res.status, body: await res.json() };
}

async function inventoryQty(userId, powerupType) {
  const row = await prisma.userPowerupItem.findUnique({
    where: { userId_powerupType: { userId, powerupType } },
  });
  return row?.quantity ?? 0;
}

async function coinsOf(userId) {
  const u = await prisma.user.findUnique({ where: { id: userId } });
  return u.coins;
}

describe("feature batch 2026-07-24 — shop", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    await seedStoreCatalog();
  });

  // ── Item 9: category + rarity on the powerup shop catalog ──────────────────
  describe("item 9 — category + rarity", () => {
    it("every catalog item carries exactly one category and a rarity", async () => {
      const user = await createUser();
      const catalog = await getPowerupShop(user.token);
      assert.ok(catalog.items.length >= 3);
      const CATS = new Set(["offense", "defense", "utility"]);
      const RARITIES = new Set(["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"]);
      for (const item of catalog.items) {
        assert.ok(CATS.has(item.category), `${item.powerupType} category=${item.category}`);
        assert.ok(RARITIES.has(item.rarity), `${item.powerupType} rarity=${item.rarity}`);
      }
    });

    it("maps offense / defense / utility as specified", async () => {
      const user = await createUser();
      const catalog = await getPowerupShop(user.token);
      const byType = Object.fromEntries(catalog.items.map((i) => [i.powerupType, i]));
      assert.equal(byType.SIGNAL_JAMMER.category, "offense");
      assert.equal(byType.CLEANSE.category, "defense");
      assert.equal(byType.RUNNERS_HIGH.category, "utility");
      // rarity comes from the balance config.
      assert.equal(byType.SIGNAL_JAMMER.rarity, "RARE");
      assert.equal(byType.RUNNERS_HIGH.rarity, "COMMON");
    });
  });

  // ── Item 10: unlock-with-ads ───────────────────────────────────────────────
  describe("item 10 — unlock-with-ads", () => {
    it("grants the powerup and zeroes coins with enough verified watches (shortfall 120 → 3 ads), idempotent on retry", async () => {
      const user = await createUser(30); // CLEANSE=150 → shortfall 120 → 3 ads
      await seedUnlockWatch(user.userId, "POWERUP_CLEANSE", 1);
      await seedUnlockWatch(user.userId, "POWERUP_CLEANSE", 2);
      await seedUnlockWatch(user.userId, "POWERUP_CLEANSE", 3);

      const first = await unlock(user.token, "POWERUP_CLEANSE", "unlock-key-1");
      assert.equal(first.status, 200);
      assert.equal(first.body.coins, 0);
      assert.equal(first.body.adsWatched, 3);
      assert.equal(first.body.inventory.powerupType, "CLEANSE");
      assert.equal(first.body.inventory.quantity, 1);

      assert.equal(await coinsOf(user.userId), 0);
      assert.equal(await inventoryQty(user.userId, "CLEANSE"), 1);

      // Retry with the same key returns the same result and does not double-grant.
      const retry = await unlock(user.token, "POWERUP_CLEANSE", "unlock-key-1");
      assert.equal(retry.status, 200);
      assert.equal(retry.body.idempotent, true);
      assert.equal(await inventoryQty(user.userId, "CLEANSE"), 1);
    });

    it("rejects when a verified watch is missing (no grant, coins unchanged)", async () => {
      const user = await createUser(30); // shortfall 120 → needs 3
      await seedUnlockWatch(user.userId, "POWERUP_CLEANSE", 1);
      await seedUnlockWatch(user.userId, "POWERUP_CLEANSE", 2); // only 2

      const res = await unlock(user.token, "POWERUP_CLEANSE", "unlock-key-2");
      assert.equal(res.status, 409);
      assert.equal(res.body.code, "AD_NOT_VERIFIED");
      assert.equal(await coinsOf(user.userId), 30);
      assert.equal(await inventoryQty(user.userId, "CLEANSE"), 0);
    });

    it("rejects shortfall > 150 (client should route to +coins)", async () => {
      const user = await createUser(0); // CLEANSE=150, coins 0 → shortfall 150 (ok)
      // Make CLEANSE cost more so shortfall exceeds 150.
      await prisma.powerupShopItem.update({
        where: { sku: "POWERUP_CLEANSE" },
        data: { priceCoins: 200 },
      });
      const res = await unlock(user.token, "POWERUP_CLEANSE", "unlock-key-3");
      assert.equal(res.status, 400);
      assert.equal(res.body.code, "SHORTFALL_TOO_LARGE");
      assert.equal(await inventoryQty(user.userId, "CLEANSE"), 0);
    });

    it("rejects when the user can already afford it (shortfall <= 0)", async () => {
      const user = await createUser(200); // CLEANSE=150 → shortfall -50
      const res = await unlock(user.token, "POWERUP_CLEANSE", "unlock-key-4");
      assert.equal(res.status, 400);
      assert.equal(res.body.code, "ALREADY_AFFORDABLE");
      assert.equal(await coinsOf(user.userId), 200);
    });

    it("grantAdReward maps SSV custom_data 'powerup_unlock:<userId>:<sku>' to a consumable watch that the unlock endpoint accepts", async () => {
      const user = await createUser(100); // CLEANSE=150 → shortfall 50 → 1 ad
      // Mint a grant exactly as the AdMob SSV callback would.
      const res = await grantAdReward({
        userId: user.userId,
        transactionId: `ssv-txn-${user.userId}`,
        adUnit: "test-unit",
        customData: `powerup_unlock:${user.userId}:POWERUP_CLEANSE`,
        serverDate: new Date().toISOString().slice(0, 10),
      });
      assert.equal(res.granted, true);
      const grant = await prisma.adRewardGrant.findFirst({
        where: { userId: user.userId, rewardKind: "powerup_unlock" },
      });
      assert.ok(grant);
      assert.equal(grant.shopItemId, "POWERUP_CLEANSE");

      // The unlock endpoint consumes that one verified watch.
      const unlockRes = await unlock(user.token, "POWERUP_CLEANSE", "unlock-key-5");
      assert.equal(unlockRes.status, 200);
      assert.equal(unlockRes.body.adsWatched, 1);
      assert.equal(await inventoryQty(user.userId, "CLEANSE"), 1);
    });
  });
});
