const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

async function createUser() {
  const appleId = `apple-drb-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  return { userId: body.user.id, token: body.sessionToken };
}

function todayLocal() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayLocal() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function seedAccessory(sku, priceCoins) {
  return prisma.shopItem.create({
    data: {
      sku,
      name: sku,
      slot: "HEAD",
      priceCoins,
      assetKey: sku,
      active: true,
    },
  });
}

describe("daily reward box (v2)", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("status keeps the legacy shape and adds the box field", async () => {
    const user = await createUser();
    const res = await request(
      server.baseUrl,
      "GET",
      `/daily-reward/status?localDate=${todayLocal()}`,
      { token: user.token }
    );
    assert.equal(res.status, 200);
    const body = await res.json();

    // Legacy shape old app builds depend on — must stay intact.
    assert.equal(body.cycleLength, 6);
    assert.equal(body.claimedToday, false);
    assert.equal(body.ladder.length, 6);
    assert.equal(body.currentDay, 1);

    // New box field for v2 clients.
    assert.equal(body.box.streak, 1);
    assert.ok(body.box.streakCap >= 1);
    const { COMMON, UNCOMMON, RARE } = body.box.odds;
    assert.ok(Math.abs(COMMON + UNCOMMON + RARE - 1) < 1e-9);
    // Reel preview data.
    assert.ok(Array.isArray(body.box.accessoryPool));
    assert.equal(body.box.coinRanges.COMMON.length, 2);
    assert.equal(body.box.coinRanges.UNCOMMON.length, 2);
  });

  it("status accessoryPool lists only unowned accessories", async () => {
    const user = await createUser();
    const owned = await seedAccessory("drb-pool-owned", 100);
    const unowned = await seedAccessory("drb-pool-unowned", 500);
    await prisma.userShopItem.create({
      data: { userId: user.userId, shopItemId: owned.id },
    });

    const res = await request(
      server.baseUrl,
      "GET",
      `/daily-reward/status?localDate=${todayLocal()}`,
      { token: user.token }
    );
    const body = await res.json();
    const poolIds = body.box.accessoryPool.map((item) => item.id);
    assert.ok(poolIds.includes(unowned.id));
    assert.ok(!poolIds.includes(owned.id));
    assert.ok(body.box.accessoryPool[0].assetKey);
  });

  it("accessoryPool never includes CHARACTER-slot items, even live ones", async () => {
    const user = await createUser();
    const hat = await seedAccessory("drb-pool-hat", 100);
    const corgi = await prisma.shopItem.create({
      data: {
        sku: "drb-pool-corgi",
        name: "drb-pool-corgi",
        slot: "CHARACTER",
        priceCoins: 5000,
        assetKey: "corgi_puppy",
        active: true,
        testOnly: false,
      },
    });

    const res = await request(
      server.baseUrl,
      "GET",
      `/daily-reward/status?localDate=${todayLocal()}`,
      { token: user.token }
    );
    const body = await res.json();
    const poolIds = body.box.accessoryPool.map((item) => item.id);
    assert.ok(poolIds.includes(hat.id));
    assert.ok(
      !poolIds.includes(corgi.id),
      "characters are purchase-only — never winnable from the daily box"
    );
  });

  it("claim-box awards coins and records rarity", async () => {
    const user = await createUser();
    const res = await request(server.baseUrl, "POST", "/daily-reward/claim-box", {
      body: { localDate: todayLocal() },
      token: user.token,
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.ok(["COMMON", "UNCOMMON", "RARE"].includes(body.rarity));
    assert.equal(body.streak, 1);
    if (body.rewardType === "ACCESSORY") {
      assert.ok(body.shopItem);
    } else {
      assert.ok(body.coinAmount > 0);
      assert.equal(body.coins, body.coinAmount);
    }

    const claim = await prisma.dailyRewardClaim.findFirst({
      where: { userId: user.userId },
    });
    assert.equal(claim.rarity, body.rarity);
    assert.equal(claim.claimedDate, todayLocal());

    const userRow = await prisma.user.findUnique({
      where: { id: user.userId },
    });
    assert.equal(userRow.lastDailyClaimDate, todayLocal());
    assert.equal(userRow.dailyLoginStreak, 1);
    assert.equal(userRow.dailyStreakDay, 1);
  });

  it("claim-box is once per day, and blocks the legacy claim too", async () => {
    const user = await createUser();
    const first = await request(server.baseUrl, "POST", "/daily-reward/claim-box", {
      body: { localDate: todayLocal() },
      token: user.token,
    });
    assert.equal(first.status, 200);

    const again = await request(server.baseUrl, "POST", "/daily-reward/claim-box", {
      body: { localDate: todayLocal() },
      token: user.token,
    });
    assert.equal(again.status, 409);

    const legacy = await request(server.baseUrl, "POST", "/daily-reward/claim", {
      body: { localDate: todayLocal() },
      token: user.token,
    });
    assert.equal(legacy.status, 409);
  });

  it("consecutive-day claim-box increments the streak; status projects it", async () => {
    const user = await createUser();
    await prisma.user.update({
      where: { id: user.userId },
      data: {
        lastDailyClaimDate: yesterdayLocal(),
        dailyLoginStreak: 4,
        dailyStreakDay: 2,
      },
    });

    const status = await request(
      server.baseUrl,
      "GET",
      `/daily-reward/status?localDate=${todayLocal()}`,
      { token: user.token }
    );
    const statusBody = await status.json();
    assert.equal(statusBody.box.streak, 5);

    const res = await request(server.baseUrl, "POST", "/daily-reward/claim-box", {
      body: { localDate: todayLocal() },
      token: user.token,
    });
    const body = await res.json();
    assert.equal(body.streak, 5);

    const userRow = await prisma.user.findUnique({
      where: { id: user.userId },
    });
    assert.equal(userRow.dailyLoginStreak, 5);
    // Legacy cycle keeps advancing for old builds.
    assert.equal(userRow.dailyStreakDay, 3);
  });

  it("missed day resets the streak to 1", async () => {
    const user = await createUser();
    const staleDate = "2026-01-01";
    await prisma.user.update({
      where: { id: user.userId },
      data: {
        lastDailyClaimDate: staleDate,
        dailyLoginStreak: 20,
        dailyStreakDay: 4,
      },
    });

    const res = await request(server.baseUrl, "POST", "/daily-reward/claim-box", {
      body: { localDate: todayLocal() },
      token: user.token,
    });
    const body = await res.json();
    assert.equal(body.streak, 1);
  });

  it("legacy claim keeps its response shape and maintains the login streak", async () => {
    const user = await createUser();
    await prisma.user.update({
      where: { id: user.userId },
      data: {
        lastDailyClaimDate: yesterdayLocal(),
        dailyLoginStreak: 8,
        dailyStreakDay: 2,
      },
    });

    const res = await request(server.baseUrl, "POST", "/daily-reward/claim", {
      body: { localDate: todayLocal() },
      token: user.token,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    // Old-build contract: cycleDay 3 of the ladder pays 30 coins.
    assert.equal(body.cycleDay, 3);
    assert.equal(body.rewardType, "COINS");
    assert.equal(body.coinAmount, 30);

    const userRow = await prisma.user.findUnique({
      where: { id: user.userId },
    });
    assert.equal(userRow.dailyLoginStreak, 9);
  });

  it("rare roll grants an unowned accessory, never an owned one", async () => {
    const user = await createUser();
    const owned = await seedAccessory("drb-owned-hat", 100);
    const unowned = await seedAccessory("drb-unowned-hat", 500);
    await prisma.userShopItem.create({
      data: { userId: user.userId, shopItemId: owned.id },
    });
    // Force a long streak so RARE odds are at their max; still random, so
    // instead exercise the command directly with a pinned rng.
    const {
      claimDailyRewardBox,
    } = require("../../src/modules/economy/commands/claimDailyRewardBox");
    const result = await claimDailyRewardBox({
      userId: user.userId,
      localDate: todayLocal(),
      rng: () => 0.999, // rarity roll → RARE; accessory pick → last by weight walk
    });
    assert.equal(result.rarity, "RARE");
    assert.equal(result.rewardType, "ACCESSORY");
    assert.equal(result.shopItem.id, unowned.id);

    const ownership = await prisma.userShopItem.findMany({
      where: { userId: user.userId },
    });
    assert.equal(ownership.length, 2);
  });

  it("owns-everything user: status serves RARE 0 and a max roll pays UNCOMMON coins", async () => {
    const user = await createUser();
    const item = await seedAccessory("drb-only-hat", 100);
    await prisma.userShopItem.create({
      data: { userId: user.userId, shopItemId: item.id },
    });

    // Status folds RARE into UNCOMMON so shipped clients never draw the "???"
    // mystery-accessory reel tile (COMMON + UNCOMMON must sum to exactly 1).
    const status = await request(
      server.baseUrl,
      "GET",
      `/daily-reward/status?localDate=${todayLocal()}`,
      { token: user.token }
    );
    const statusBody = await status.json();
    assert.equal(statusBody.box.accessoryPool.length, 0);
    assert.equal(statusBody.box.odds.RARE, 0);
    assert.equal(statusBody.box.odds.COMMON + statusBody.box.odds.UNCOMMON, 1);

    // The claim roll uses the same folded odds: even a max roll can't land RARE.
    const {
      claimDailyRewardBox,
    } = require("../../src/modules/economy/commands/claimDailyRewardBox");
    const result = await claimDailyRewardBox({
      userId: user.userId,
      localDate: todayLocal(),
      rng: () => 0.999,
    });
    assert.equal(result.rarity, "UNCOMMON");
    assert.equal(result.rewardType, "COINS");
    assert.ok(result.coinAmount > 0);
  });
});
