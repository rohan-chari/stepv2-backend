const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// Daily-box shop-powerup prizes (spinPowerups feature). Verifies:
//   - a spinpowerups-capable claim can win a POWERUP → UserPowerupItem +1,
//     response shape correct, audit row records the powerup type;
//   - a claim WITHOUT the feature token never returns POWERUP;
//   - the status endpoint exposes the powerup pool/odds only to flagged clients;
//   - the once-per-day guard still holds for powerup grants;
//   - the Signal Jammer is only winnable by jammer-capable clients.

let server;
let nextAppleId = 0;

// `spinpowerups` is what X-Client-Features resolves to (lowercased). `jammer`
// is required for the Signal Jammer to be eligible.
const SPIN_HEADER = { "X-Client-Features": "characters,jammer,spinPowerups" };
const SPIN_NO_JAMMER_HEADER = { "X-Client-Features": "characters,spinPowerups" };

async function createUser() {
  const appleId = `apple-drbp-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  return { userId: body.user.id, token: body.sessionToken };
}

function todayLocal() {
  return new Date().toISOString().slice(0, 10);
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

async function seedPowerup(sku, powerupType, { testOnly = false } = {}) {
  return prisma.powerupShopItem.create({
    data: {
      sku,
      name: sku,
      priceCoins: 75,
      powerupType,
      active: true,
      testOnly,
    },
  });
}

// Make the user own every accessory so the accessory pool is empty — a RARE
// then deterministically resolves to a POWERUP (rollRarePrizeKind: powerup-only
// pool), and rng: () => 0.999 forces the rarity roll to RARE.
async function ownAllAccessories(userId) {
  const items = await prisma.shopItem.findMany({ where: { active: true } });
  for (const item of items) {
    await prisma.userShopItem.create({
      data: { userId, shopItemId: item.id },
    });
  }
}

describe("daily reward box powerup prizes", () => {
  before(async () => {
    server = await getSharedServer();
  });

  // cleanDatabase() does NOT truncate powerup_shop_items (no user FK), so the
  // pool query would otherwise see rows leaked from other tests/files. Clear it
  // ourselves before each test — and after the suite — so every case runs
  // against exactly the powerups it seeds.
  beforeEach(async () => {
    await cleanDatabase();
    await prisma.powerupShopItem.deleteMany({});
  });

  after(async () => {
    await prisma.powerupShopItem.deleteMany({});
  });

  it("status exposes powerupPool + rarePrizeMix only to spinpowerups clients", async () => {
    const user = await createUser();
    await seedPowerup("drbp-imposter", "IMPOSTER");
    await seedPowerup("drbp-rainstorm", "RAINSTORM");

    // Flagged client: powerupPool + rarePrizeMix present.
    const flagged = await request(
      server.baseUrl,
      "GET",
      `/daily-reward/status?localDate=${todayLocal()}`,
      { token: user.token, headers: SPIN_HEADER }
    );
    const flaggedBody = await flagged.json();
    assert.ok(Array.isArray(flaggedBody.box.powerupPool));
    assert.ok(flaggedBody.box.powerupPool.length >= 2);
    assert.ok(flaggedBody.box.powerupPool[0].powerupType);
    assert.ok(flaggedBody.box.rarePrizeMix);

    // Old client (no token): additive fields absent, legacy shape intact.
    const legacy = await request(
      server.baseUrl,
      "GET",
      `/daily-reward/status?localDate=${todayLocal()}`,
      { token: user.token }
    );
    const legacyBody = await legacy.json();
    assert.equal(legacyBody.box.powerupPool, undefined);
    assert.equal(legacyBody.box.rarePrizeMix, undefined);
    assert.equal(legacyBody.box.accessoryPool.length >= 0, true);
  });

  it("owns-everything spinpowerups client: status keeps RARE alive via powerups", async () => {
    const user = await createUser();
    await seedAccessory("drbp-only-hat", 100);
    await ownAllAccessories(user.userId);
    await seedPowerup("drbp-imposter2", "IMPOSTER");

    const res = await request(
      server.baseUrl,
      "GET",
      `/daily-reward/status?localDate=${todayLocal()}`,
      { token: user.token, headers: SPIN_HEADER }
    );
    const body = await res.json();
    assert.equal(body.box.accessoryPool.length, 0);
    // RARE is NOT folded to 0 for flagged clients — powerups back it.
    assert.ok(body.box.odds.RARE > 0);
    assert.equal(body.box.rarePrizeMix.POWERUP, 1);
    assert.equal(body.box.rarePrizeMix.ACCESSORY, 0);

    // A shipped-old client on the SAME user still sees RARE folded to 0.
    const legacy = await request(
      server.baseUrl,
      "GET",
      `/daily-reward/status?localDate=${todayLocal()}`,
      { token: user.token }
    );
    const legacyBody = await legacy.json();
    assert.equal(legacyBody.box.odds.RARE, 0);
  });

  it("spinpowerups claim can win a powerup → inventory +1, correct shape, audit row", async () => {
    const user = await createUser();
    await seedAccessory("drbp-claim-hat", 100);
    await ownAllAccessories(user.userId); // accessory pool empty → RARE = powerup
    await seedPowerup("drbp-claim-imposter", "IMPOSTER");

    // Drive the command directly with a pinned rng to force RARE (0.999) — the
    // empty accessory pool makes the sub-roll resolve to POWERUP deterministically.
    const {
      claimDailyRewardBox,
    } = require("../../src/modules/economy/commands/claimDailyRewardBox");
    const result = await claimDailyRewardBox({
      userId: user.userId,
      localDate: todayLocal(),
      rng: () => 0.999,
      supportsSpinPowerups: true,
      supportsJammer: true,
      channel: "prod",
    });

    assert.equal(result.rarity, "RARE");
    assert.equal(result.rewardType, "POWERUP");
    assert.ok(result.powerup, "result carries the powerup payload");
    assert.equal(result.powerup.powerupType, "IMPOSTER");
    assert.equal(result.shopItem, null);
    assert.equal(result.coinAmount, null);

    // Inventory incremented.
    const inv = await prisma.userPowerupItem.findUnique({
      where: {
        userId_powerupType: { userId: user.userId, powerupType: "IMPOSTER" },
      },
    });
    assert.ok(inv);
    assert.equal(inv.quantity, 1);

    // Audit row records the powerup.
    const claim = await prisma.dailyRewardClaim.findFirst({
      where: { userId: user.userId },
    });
    assert.equal(claim.rewardType, "POWERUP");
    assert.equal(claim.powerupType, "IMPOSTER");
    assert.equal(claim.shopItemId, null);

    // Streak counters still advance.
    const userRow = await prisma.user.findUnique({
      where: { id: user.userId },
    });
    assert.equal(userRow.lastDailyClaimDate, todayLocal());
    assert.equal(userRow.dailyLoginStreak, 1);
  });

  it("claim WITHOUT the feature token never returns POWERUP (folds to coins)", async () => {
    const user = await createUser();
    await seedAccessory("drbp-nofeat-hat", 100);
    await ownAllAccessories(user.userId);
    await seedPowerup("drbp-nofeat-imposter", "IMPOSTER");

    // No supportsSpinPowerups → powerup pool empty AND accessory pool empty, so
    // RARE folds to 0. Even a max roll can't yield POWERUP; it pays coins.
    const {
      claimDailyRewardBox,
    } = require("../../src/modules/economy/commands/claimDailyRewardBox");
    const result = await claimDailyRewardBox({
      userId: user.userId,
      localDate: todayLocal(),
      rng: () => 0.999,
      supportsSpinPowerups: false,
    });
    assert.notEqual(result.rewardType, "POWERUP");
    assert.equal(result.powerup, null);
    assert.equal(result.rarity, "UNCOMMON");
    assert.ok(result.coinAmount > 0);

    // No powerup was granted.
    const inv = await prisma.userPowerupItem.findMany({
      where: { userId: user.userId },
    });
    assert.equal(inv.length, 0);
  });

  it("HTTP claim-box without the feature header never grants a powerup", async () => {
    const user = await createUser();
    await seedAccessory("drbp-http-hat", 100);
    await ownAllAccessories(user.userId);
    await seedPowerup("drbp-http-imposter", "IMPOSTER");

    const res = await request(server.baseUrl, "POST", "/daily-reward/claim-box", {
      body: { localDate: todayLocal() },
      token: user.token, // no X-Client-Features
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.notEqual(body.rewardType, "POWERUP");

    const inv = await prisma.userPowerupItem.findMany({
      where: { userId: user.userId },
    });
    assert.equal(inv.length, 0);
  });

  it("once-per-day guard holds after a powerup grant", async () => {
    const user = await createUser();
    await seedAccessory("drbp-guard-hat", 100);
    await ownAllAccessories(user.userId);
    await seedPowerup("drbp-guard-imposter", "IMPOSTER");

    const {
      claimDailyRewardBox,
    } = require("../../src/modules/economy/commands/claimDailyRewardBox");
    const first = await claimDailyRewardBox({
      userId: user.userId,
      localDate: todayLocal(),
      rng: () => 0.999,
      supportsSpinPowerups: true,
      supportsJammer: true,
    });
    assert.equal(first.rewardType, "POWERUP");

    // Second HTTP claim same day is blocked.
    const again = await request(server.baseUrl, "POST", "/daily-reward/claim-box", {
      body: { localDate: todayLocal() },
      token: user.token,
      headers: SPIN_HEADER,
    });
    assert.equal(again.status, 409);

    // Inventory did not double.
    const inv = await prisma.userPowerupItem.findUnique({
      where: {
        userId_powerupType: { userId: user.userId, powerupType: "IMPOSTER" },
      },
    });
    assert.equal(inv.quantity, 1);
  });

  it("Signal Jammer is only winnable by a jammer-capable client", async () => {
    const user = await createUser();
    await seedAccessory("drbp-jam-hat", 100);
    await ownAllAccessories(user.userId);
    // The ONLY powerup available is the Signal Jammer.
    await seedPowerup("drbp-only-jammer", "SIGNAL_JAMMER");

    const {
      claimDailyRewardBox,
    } = require("../../src/modules/economy/commands/claimDailyRewardBox");

    // Without jammer support the jammer is filtered out → powerup pool empty →
    // accessory pool empty → RARE folds → coins, never the jammer.
    const noJammer = await claimDailyRewardBox({
      userId: user.userId,
      localDate: todayLocal(),
      rng: () => 0.999,
      supportsSpinPowerups: true,
      supportsJammer: false,
    });
    assert.notEqual(noJammer.rewardType, "POWERUP");
    const inv0 = await prisma.userPowerupItem.findMany({
      where: { userId: user.userId },
    });
    assert.equal(inv0.length, 0);

    // A jammer-capable client (fresh user, same seed) CAN win it.
    const user2 = await createUser();
    await ownAllAccessories(user2.userId);
    const withJammer = await claimDailyRewardBox({
      userId: user2.userId,
      localDate: todayLocal(),
      rng: () => 0.999,
      supportsSpinPowerups: true,
      supportsJammer: true,
    });
    assert.equal(withJammer.rewardType, "POWERUP");
    assert.equal(withJammer.powerup.powerupType, "SIGNAL_JAMMER");
  });

  it("status: prod channel hides testOnly powerups from the pool", async () => {
    const user = await createUser();
    await seedPowerup("drbp-live-imposter", "IMPOSTER", { testOnly: false });
    await seedPowerup("drbp-test-rainstorm", "RAINSTORM", { testOnly: true });

    const res = await request(
      server.baseUrl,
      "GET",
      `/daily-reward/status?localDate=${todayLocal()}`,
      { token: user.token, headers: SPIN_HEADER } // prod channel (no testflight header)
    );
    const body = await res.json();
    const types = body.box.powerupPool.map((p) => p.powerupType);
    assert.ok(types.includes("IMPOSTER"));
    assert.ok(
      !types.includes("RAINSTORM"),
      "testOnly powerup must be hidden from the prod channel"
    );
  });
});
