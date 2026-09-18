const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { balanceConfig } = require("../../src/modules/economy/balanceConfig");
const {
  defaultConfig,
} = require("../../src/modules/economy/balanceConfig.defaults");

// 2026-07-24 (owner decision): Pocket Watch is pulled OUT of the in-race
// mystery-box drop pool and sold in the shop at the cheapest coin tier (40).
// It is deliberately NOT feature-gated and NOT testOnly — every shipped binary
// has rendered Pocket Watch since it was droppable.

let server;
let nextAppleId = 0;

const POCKET_WATCH_ROW = {
  sku: "POWERUP_POCKET_WATCH",
  name: "Pocket Watch",
  description: "Pocket Watch row",
  powerupType: "POCKET_WATCH",
  priceCoins: 40,
};

// The oldest client shape we still serve: no X-Client-Features at all.
const NO_FEATURES = {};

async function seedCatalog() {
  await prisma.powerupShopItem.upsert({
    where: { sku: POCKET_WATCH_ROW.sku },
    update: {
      priceCoins: POCKET_WATCH_ROW.priceCoins,
      active: true,
      testOnly: false,
      powerupType: "POCKET_WATCH",
    },
    create: { ...POCKET_WATCH_ROW, active: true, testOnly: false },
  });
}

async function createUser(coins = 0) {
  const appleId = `apple-pocketwatch-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  if (coins > 0) {
    await prisma.user.update({
      where: { id: body.user.id },
      data: { coins },
    });
  }
  return { userId: body.user.id, token: body.sessionToken };
}

describe("Pocket Watch moves from the race drop pool to the store", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedCatalog();
    nextAppleId = 0;
  });

  it("is gone from every mystery-box drop tier and marked store-only", async () => {
    const config = await balanceConfig.getConfig();
    for (const rarity of ["COMMON", "UNCOMMON", "RARE"]) {
      assert.ok(
        !config.dropPool[rarity].includes("POCKET_WATCH"),
        `POCKET_WATCH must not be droppable at ${rarity}`
      );
    }
    // The shipped defaults are what make it store-only; a config row stored
    // before this change keeps its own (older) storeOnlyTypes list, and the
    // exclusion is still applied to the pool above.
    assert.ok(defaultConfig().storeOnlyTypes.includes("POCKET_WATCH"));
    // Still a real powerup with a rarity (owned copies, icons, upgrades).
    assert.equal(config.rarityByType.POCKET_WATCH, "RARE");
  });

  it("is offered in the shop at the cheapest tier to a client advertising no features at all", async () => {
    const user = await createUser();
    const res = await request(server.baseUrl, "GET", "/shop/powerups", {
      token: user.token,
      headers: NO_FEATURES,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const item = (body.items || body.powerups || []).find(
      (i) => i.powerupType === "POCKET_WATCH"
    );
    assert.ok(item, "Pocket Watch is listed in the powerup store");
    assert.equal(item.priceCoins, 40);
  });

  it("can be bought with coins and lands in the buyer's inventory", async () => {
    const user = await createUser(100);
    const res = await request(server.baseUrl, "POST", "/shop/powerups/purchase", {
      token: user.token,
      headers: { "Idempotency-Key": "pocket-watch-buy-1" },
      body: { sku: "POWERUP_POCKET_WATCH" },
    });
    assert.equal(res.status, 200, `purchase status ${res.status}`);

    const owned = await prisma.userPowerupItem.findFirst({
      where: { userId: user.userId, powerupType: "POCKET_WATCH" },
    });
    assert.ok(owned, "Pocket Watch is in the inventory");
    assert.ok(owned.quantity >= 1);

    const after = await prisma.user.findUnique({
      where: { id: user.userId },
      select: { coins: true },
    });
    assert.equal(after.coins, 60, "cheapest tier costs 40 coins");
  });
});
