const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { balanceConfig } = require("../../src/modules/economy/balanceConfig");
const { defaultConfig } = require("../../src/modules/economy/balanceConfig.defaults");

// THE invariant (owner decision, 2026-07-28): a powerup is winnable from the
// daily spin exactly when it is visible in that client's shop. Both surfaces
// share isPowerupVisibleToClient over findActive rows; there is no separate
// spin-exclusion list. Backstory: the old `dailyBoxExcludedTypes` config key
// had a stale stored copy in prod that let the spinner pay out COIN_FLIP six
// times while the shop had moved on — the key is gone, so that whole class of
// drift is unrepresentable.

let server;
let nextAppleId = 0;

const FULL_HEADER = {
  "X-Client-Features": "jammer,spinPowerups,powerups2,powerups3,powerups4,powerups5",
};
// spinpowerups-capable but WITHOUT powerups5 (a pre-wave-5 binary).
const NO_W5_HEADER = { "X-Client-Features": "jammer,spinPowerups" };

async function createUser() {
  const appleId = `apple-parity-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  return { userId: body.user.id, token: body.sessionToken };
}

function todayLocal() {
  return new Date().toISOString().slice(0, 10);
}

async function seedPowerup(
  sku,
  powerupType,
  { active = true, testOnly = false, dailyRewardEligible = true } = {},
) {
  return prisma.powerupShopItem.create({
    data: {
      sku,
      name: sku,
      priceCoins: 75,
      powerupType,
      active,
      testOnly,
      dailyRewardEligible,
    },
  });
}

async function shopTypes(user, headers) {
  const res = await request(server.baseUrl, "GET", "/shop/powerups", {
    token: user.token,
    headers,
  });
  assert.equal(res.status, 200);
  return (await res.json()).items.map((i) => i.powerupType).sort();
}

async function spinPoolTypes(user, headers) {
  const res = await request(
    server.baseUrl,
    "GET",
    `/daily-reward/status?localDate=${todayLocal()}`,
    { token: user.token, headers }
  );
  assert.equal(res.status, 200);
  return (await res.json()).box.powerupPool.map((p) => p.powerupType).sort();
}

describe("daily spin ⟺ shop parity", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.powerupShopItem.deleteMany({});
    await prisma.balanceConfig.deleteMany({});
    balanceConfig.bustCache();
  });

  after(async () => {
    await prisma.powerupShopItem.deleteMany({});
    await prisma.balanceConfig.deleteMany({});
    balanceConfig.bustCache();
  });

  it("the spin's powerup pool is exactly the shop catalog, for capable and old clients alike", async () => {
    const user = await createUser();
    await seedPowerup("par-rainstorm", "RAINSTORM");
    await seedPowerup("par-coin-flip", "COIN_FLIP");
    await seedPowerup("par-leech", "LEECH");
    await seedPowerup("par-hidden-decoy", "DECOY", { active: false });

    // Fully-capable client: identical sets, DECOY in neither (active=false).
    const shopFull = await shopTypes(user, FULL_HEADER);
    assert.deepEqual(await spinPoolTypes(user, FULL_HEADER), shopFull);
    assert.deepEqual(shopFull, ["COIN_FLIP", "LEECH", "RAINSTORM"]);

    // Pre-wave-5 client: COIN_FLIP (powerups5) and LEECH (powerups3) drop out
    // of BOTH surfaces together.
    const shopOld = await shopTypes(user, NO_W5_HEADER);
    assert.deepEqual(await spinPoolTypes(user, NO_W5_HEADER), shopOld);
    assert.deepEqual(shopOld, ["RAINSTORM"]);
  });

  it("hiding an item from the store removes it from the spin in the same breath", async () => {
    const user = await createUser();
    await seedPowerup("par-toggle-flip", "COIN_FLIP");

    assert.deepEqual(await spinPoolTypes(user, FULL_HEADER), ["COIN_FLIP"]);

    await prisma.powerupShopItem.update({
      where: { sku: "par-toggle-flip" },
      data: { active: false },
    });

    assert.deepEqual(await shopTypes(user, FULL_HEADER), []);
    assert.deepEqual(await spinPoolTypes(user, FULL_HEADER), []);
  });

  it("keeps an active Hitchhike in the capable shop but out of the daily pool", async () => {
    const user = await createUser();
    await seedPowerup("POWERUP_HITCHHIKE", "HITCHHIKE", {
      dailyRewardEligible: false,
    });
    await seedPowerup("par-rainstorm", "RAINSTORM");

    assert.deepEqual(await shopTypes(user, FULL_HEADER), ["HITCHHIKE", "RAINSTORM"]);
    assert.deepEqual(await spinPoolTypes(user, FULL_HEADER), ["RAINSTORM"]);
    assert.deepEqual(await shopTypes(user, NO_W5_HEADER), ["RAINSTORM"]);
  });

  it("a stored config still carrying the old dailyBoxExcludedTypes key has no effect", async () => {
    const user = await createUser();
    await seedPowerup("par-legacy-rainstorm", "RAINSTORM");

    // A legacy stored row that tries to bar RAINSTORM the pre-2026-07-28 way.
    const legacy = defaultConfig();
    legacy.dailyBoxExcludedTypes = ["RAINSTORM"];
    await prisma.balanceConfig.create({
      data: { version: 1, config: legacy, active: true, note: "legacy-key fixture" },
    });
    balanceConfig.bustCache();
    await balanceConfig.getSnapshot();

    assert.deepEqual(
      await spinPoolTypes(user, FULL_HEADER),
      ["RAINSTORM"],
      "the retired config key must not diverge the spin from the shop"
    );
  });

  it("testOnly rows stay out of the prod channel's shop AND spin together", async () => {
    const user = await createUser();
    await seedPowerup("par-live-rainstorm", "RAINSTORM");
    await seedPowerup("par-test-potion", "MYSTERY_POTION", { testOnly: true });

    // No release-channel header → prod channel.
    assert.deepEqual(await shopTypes(user, FULL_HEADER), ["RAINSTORM"]);
    assert.deepEqual(await spinPoolTypes(user, FULL_HEADER), ["RAINSTORM"]);
  });
});
