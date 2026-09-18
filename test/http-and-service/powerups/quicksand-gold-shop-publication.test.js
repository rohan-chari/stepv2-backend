const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { describe, it, before, beforeEach, after } = require("node:test");
const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  createTestUser,
} = require("./setup");

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../prisma/migrations/20260916180000_gold_premium_powerup_catalog/migration.sql"
);
const CAPABLE_HEADERS = {
  "X-Client-Features": "spinPowerups,powerups4",
};
const TESTFLIGHT_CAPABLE_HEADERS = {
  ...CAPABLE_HEADERS,
  "X-Release-Channel": "testflight",
};

let server;

function assertDisposableDatabase() {
  const target = new URL(process.env.DATABASE_URL || "");
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname),
    "migration fixture must use loopback PostgreSQL"
  );
  assert.match(
    decodeURIComponent(target.pathname.slice(1)),
    /_test$/,
    "migration fixture must use a *_test database"
  );
}

function applyPublicationMigration() {
  assertDisposableDatabase();
  execFileSync(
    "psql",
    [
      process.env.DATABASE_URL,
      "--set=ON_ERROR_STOP=1",
      "--file",
      MIGRATION_PATH,
    ],
    { stdio: "pipe" }
  );
}

async function seedPrePublicationQuicksand() {
  await prisma.powerupShopItem.create({
    data: {
      sku: "POWERUP_QUICKSAND",
      name: "Quicksand",
      description: "Freeze three",
      priceCoins: 300,
      powerupType: "QUICKSAND",
      active: true,
      testOnly: true,
      dailyRewardEligible: false,
      sortOrder: 99,
    },
  });
  applyPublicationMigration();
}

async function makeGold(userId) {
  const identity = await prisma.billingIdentity.create({ data: { userId } });
  await prisma.billingSubscription.create({
    data: {
      id: `quicksand-publication-gold-${userId}`,
      identityId: identity.id,
      productId: "bara_plus_weekly_v1",
      startsAt: new Date(),
      periodStartsAt: new Date(),
      accessUntil: new Date(Date.now() + 86400000),
      givesAccess: true,
      benefitContract: "bara_gold_v1",
      observedAt: new Date(),
    },
  });
}

describe("Quicksand Gold shop publication — integration", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.powerupShopItem.deleteMany({});
    await seedPrePublicationQuicksand();
  });

  after(async () => {
    await prisma.powerupShopItem.deleteMany({});
  });

  it("publishes the migrated row in prod and TestFlight, but never to pre-powerups4 clients", async () => {
    const user = await createTestUser();

    for (const headers of [CAPABLE_HEADERS, TESTFLIGHT_CAPABLE_HEADERS]) {
      const response = await request(server.baseUrl, "GET", "/shop/powerups", {
        token: user.token,
        headers,
      });
      assert.equal(response.status, 200);
      const item = (await response.json()).items.find(
        (candidate) => candidate.powerupType === "QUICKSAND"
      );
      assert.deepEqual(
        {
          powerupType: item?.powerupType,
          requiresGold: item?.requiresGold,
          goldEligible: item?.goldEligible,
          purchaseEligibility: item?.purchaseEligibility,
        },
        {
          powerupType: "QUICKSAND",
          requiresGold: false,
          goldEligible: true,
          purchaseEligibility: "AVAILABLE",
        }
      );
    }

    const legacy = await request(server.baseUrl, "GET", "/shop/powerups", {
      token: user.token,
    });
    assert.equal(legacy.status, 200);
    assert.equal(
      (await legacy.json()).items.some(
        (item) => item.powerupType === "QUICKSAND"
      ),
      false
    );
  });

  it("keeps Gold purchase policy authoritative without debiting non-Gold users", async () => {
    const free = await createTestUser();
    await prisma.user.update({
      where: { id: free.user.id },
      data: { coins: 1000 },
    });

    const purchase = await request(
      server.baseUrl,
      "POST",
      "/shop/powerups/purchase",
      {
        token: free.token,
        headers: {
          ...CAPABLE_HEADERS,
          "Idempotency-Key": "quicksand-free-purchase",
        },
        body: { sku: "POWERUP_QUICKSAND" },
      }
    );
    assert.equal(purchase.status, 200);
    assert.equal(
      (await prisma.user.findUnique({ where: { id: free.user.id } })).coins,
      1000
    );

    const gold = await createTestUser();
    await makeGold(gold.user.id);
    await prisma.user.update({
      where: { id: gold.user.id },
      data: { coins: 300 },
    });
    const purchased = await request(
      server.baseUrl,
      "POST",
      "/shop/powerups/purchase",
      {
        token: gold.token,
        headers: {
          ...CAPABLE_HEADERS,
          "Idempotency-Key": "quicksand-gold-purchase",
        },
        body: { sku: "POWERUP_QUICKSAND" },
      }
    );
    const purchasedBody = await purchased.json();
    assert.equal(purchased.status, 200, JSON.stringify(purchasedBody));
    assert.equal(purchasedBody.purchase.coinsSpent, 255);
  });

  it("blocks unsupported clients from acquiring Quicksand by type, sku, or ad unlock", async () => {
    const user = await createTestUser();
    await makeGold(user.user.id);
    await prisma.user.update({
      where: { id: user.user.id },
      data: { coins: 1000 },
    });

    const purchaseBySku = await request(
      server.baseUrl,
      "POST",
      "/shop/powerups/purchase",
      {
        token: user.token,
        headers: { "Idempotency-Key": "quicksand-legacy-sku" },
        body: { sku: "POWERUP_QUICKSAND" },
      }
    );
    assert.equal(purchaseBySku.status, 404);

    const purchaseByType = await request(
      server.baseUrl,
      "POST",
      "/shop/powerups/purchase",
      {
        token: user.token,
        headers: { "Idempotency-Key": "quicksand-legacy-type" },
        body: { powerupType: "QUICKSAND" },
      }
    );
    assert.equal(purchaseByType.status, 404);

    const adUnlock = await request(
      server.baseUrl,
      "POST",
      "/shop/powerups/unlock-with-ads",
      {
        token: user.token,
        headers: { "Idempotency-Key": "quicksand-legacy-ad" },
        body: { sku: "POWERUP_QUICKSAND" },
      }
    );
    assert.equal(adUnlock.status, 404);
  });

  it("keeps Daily Spin eligibility Gold-only and preserves grandfathered inventory use", async () => {
    const free = await createTestUser();
    const gold = await createTestUser();
    await makeGold(gold.user.id);

    const pathForStatus = "/daily-reward/status?localDate=2026-09-16";
    const freeStatus = await request(server.baseUrl, "GET", pathForStatus, {
      token: free.token,
      headers: CAPABLE_HEADERS,
    });
    const goldStatus = await request(server.baseUrl, "GET", pathForStatus, {
      token: gold.token,
      headers: CAPABLE_HEADERS,
    });
    const freeBox = (await freeStatus.json()).box;
    const goldBox = (await goldStatus.json()).box;
    assert.ok(
      freeBox.powerupPool.some((item) => item.powerupType === "QUICKSAND")
    );
    assert.equal(freeBox.eligiblePowerupTypes.includes("QUICKSAND"), false);
    assert.equal(goldBox.eligiblePowerupTypes.includes("QUICKSAND"), true);

    await prisma.userPowerupItem.create({
      data: { userId: free.user.id, powerupType: "QUICKSAND", quantity: 1 },
    });
    const legacyInventory = await request(
      server.baseUrl,
      "GET",
      "/powerups/inventory",
      { token: free.token }
    );
    assert.equal(
      (await legacyInventory.json()).items.some(
        (item) => item.powerupType === "QUICKSAND"
      ),
      false
    );
    const capableInventory = await request(
      server.baseUrl,
      "GET",
      "/powerups/inventory",
      { token: free.token, headers: CAPABLE_HEADERS }
    );
    assert.deepEqual(
      (await capableInventory.json()).items.find(
        (item) => item.powerupType === "QUICKSAND"
      ),
      { powerupType: "QUICKSAND", quantity: 1 }
    );
  });

  it("keeps Quicksand excluded from in-race mystery-box drops after publication", async () => {
    const { balanceConfig } = require("../../src/modules/economy/balanceConfig");
    const { config } = await balanceConfig.getSnapshot();
    assert.equal(
      Object.values(config.dropPool).some((pool) => pool.includes("QUICKSAND")),
      false
    );
  });
});
