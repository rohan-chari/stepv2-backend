const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// Watch-ad-for-coins end to end (grants seeded directly — in prod only the
// verified AdMob SSV callback mints them): status block gating, claim x cap,
// balance and ledger effects.

let server;
let nextAppleId = 0;

const ADS_HEADERS = { "X-Client-Features": "characters,ads" };

async function createUser() {
  const appleId = `apple-acr-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  return { userId: body.user.id, token: body.sessionToken };
}

function todayLocal() {
  return new Date().toISOString().slice(0, 10);
}

async function seedGrant(userId, n, grantedDate = todayLocal()) {
  return prisma.adRewardGrant.create({
    data: {
      userId,
      transactionId: `txn-acr-${userId}-${n}`,
      rewardKind: "coin_reward",
      grantedDate,
    },
  });
}

async function getStatus(token) {
  const res = await request(
    server.baseUrl,
    "GET",
    `/daily-reward/status?localDate=${todayLocal()}`,
    { token, headers: ADS_HEADERS }
  );
  assert.equal(res.status, 200);
  return res.json();
}

async function claim(token) {
  const res = await request(server.baseUrl, "POST", "/coins/claim-ad-reward", {
    body: { localDate: todayLocal() },
    token,
    headers: ADS_HEADERS,
  });
  return { status: res.status, body: await res.json() };
}

describe("ad coin reward (Get Coins hub)", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("status gates the adCoinReward block on the ads client feature", async () => {
    const user = await createUser();

    const withAds = await getStatus(user.token);
    assert.deepEqual(withAds.adCoinReward, {
      available: true,
      pendingGrant: false,
      remainingToday: 3,
      coinAmount: 25,
    });

    const res = await request(
      server.baseUrl,
      "GET",
      `/daily-reward/status?localDate=${todayLocal()}`,
      { token: user.token }
    );
    const withoutAds = await res.json();
    assert.equal("adCoinReward" in withoutAds, false);
  });

  it("claims up to the daily cap, then 409s; coins and ledger add up", async () => {
    const user = await createUser();
    const startCoins = (await prisma.user.findUnique({
      where: { id: user.userId },
      select: { coins: true },
    })).coins;

    for (let i = 0; i < 4; i++) await seedGrant(user.userId, i);

    let pending = await getStatus(user.token);
    assert.equal(pending.adCoinReward.pendingGrant, true);

    for (let i = 0; i < 3; i++) {
      const res = await claim(user.token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.coinAmount, 25);
      assert.equal(res.body.remainingToday, 2 - i);
    }

    // 4th grant exists but the cap is spent.
    const capped = await claim(user.token);
    assert.equal(capped.status, 409);
    assert.equal(capped.body.code, "DAILY_CAP_REACHED");

    const after = await getStatus(user.token);
    assert.equal(after.adCoinReward.available, false);
    assert.equal(after.adCoinReward.remainingToday, 0);

    const userRow = await prisma.user.findUnique({
      where: { id: user.userId },
      select: { coins: true },
    });
    assert.equal(userRow.coins, startCoins + 75);

    const ledger = await prisma.coinTransaction.findMany({
      where: { userId: user.userId, reason: "ad_coin_reward" },
    });
    assert.equal(ledger.length, 3);
    assert.ok(ledger.every((t) => t.amount === 25));
  });

  it("claim without a verified grant is 409 AD_NOT_VERIFIED", async () => {
    const user = await createUser();
    const res = await claim(user.token);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "AD_NOT_VERIFIED");
  });

  it("yesterday's grant never redeems today", async () => {
    const user = await createUser();
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    await seedGrant(user.userId, 0, d.toISOString().slice(0, 10));

    const res = await claim(user.token);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "AD_NOT_VERIFIED");
  });

  it("coin grants never satisfy the extra-spin claim (kinds are disjoint)", async () => {
    const user = await createUser();
    await seedGrant(user.userId, 0);
    // Claim the free daily box first so the extra-spin guard passes.
    const free = await request(
      server.baseUrl,
      "POST",
      "/daily-reward/claim-box",
      { body: { localDate: todayLocal() }, token: user.token, headers: ADS_HEADERS }
    );
    assert.equal(free.status, 200);

    const res = await request(
      server.baseUrl,
      "POST",
      "/daily-reward/claim-extra-box",
      { body: { localDate: todayLocal() }, token: user.token, headers: ADS_HEADERS }
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "AD_NOT_VERIFIED");
  });
});
