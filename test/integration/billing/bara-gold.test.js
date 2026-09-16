const assert = require("node:assert/strict");
const { before, after, beforeEach, describe, it } = require("node:test");
const { randomUUID } = require("node:crypto");

const {
  cleanDatabase,
  createTestUser,
  prisma,
  request,
  startServer,
} = require("../setup");

const config = {
  projectId: "bara-gold-integration",
  secretApiKey: "integration-only",
  webhookAuthorization: "Bearer bara-gold-integration",
  iosAppId: "bara-gold-ios",
  androidAppId: "bara-gold-android",
  termsUrl: "https://barastep.com/billing-terms",
  privacyUrl: "https://barastep.com/privacy",
};

let server;
let history;

before(async () => {
  server = await startServer({
    billingConfig: config,
    billingProvider: { async getCustomerHistory() { return history; } },
  });
});

after(async () => server?.close());

beforeEach(async () => {
  await cleanDatabase();
  history = { purchases: [], subscriptions: [], observedAt: new Date().toISOString() };
});

async function bootstrap(token, features = "") {
  const response = await request(server.baseUrl, "GET", "/billing/bootstrap?platform=ios", {
    token,
    headers: features ? { "X-Client-Features": features } : undefined,
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function goldMember(userId, plan = "monthly") {
  const identity = await prisma.billingIdentity.create({ data: { userId } });
  await prisma.billingSubscription.create({
    data: {
      id: randomUUID(),
      identityId: identity.id,
      productId: `plus_${plan}`,
      startsAt: new Date(),
      periodStartsAt: new Date(),
      accessUntil: new Date(Date.now() + 7 * 86400000),
      givesAccess: true,
      trial: false,
      renews: true,
      providerStatus: "active",
      benefitContract: "bara_gold_v1",
      observedAt: new Date(),
    },
  });
  return identity;
}

function subscription(overrides = {}) {
  const startsAt = new Date().toISOString();
  return {
    providerId: "gold-subscription-1",
    productId: "plus_monthly",
    appId: config.iosAppId,
    store: "app_store",
    environment: "production",
    startsAt,
    periodStartsAt: startsAt,
    accessUntil: new Date(Date.now() + 30 * 86400000).toISOString(),
    givesAccess: true,
    status: "active",
    trial: false,
    renews: true,
    ...overrides,
  };
}

function purchase(overrides = {}) {
  return {
    transactionId: "gold-transaction-1",
    providerId: "gold-provider-1",
    productId: "plus_monthly",
    appId: config.iosAppId,
    store: "app_store",
    environment: "production",
    purchasedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    quantity: 1,
    paid: true,
    refunded: false,
    subscriptionId: "gold-subscription-1",
    benefitContract: "bara_gold_v1",
    ...overrides,
  };
}

describe("Bara Gold backend contract", () => {
  it("does not upgrade a historical monthly transaction without a Gold contract", async () => {
    const { token, user } = await createTestUser();
    history = {
      purchases: [purchase({ benefitContract: undefined, transactionId: "legacy-monthly-1" })],
      subscriptions: [subscription({ benefitContract: undefined })],
      observedAt: new Date().toISOString(),
    };
    const response = await request(server.baseUrl, "POST", "/billing/sync?platform=ios", {
      token,
      headers: { "X-Client-Features": "bara_gold_v1" },
      body: { transactionId: "legacy-monthly-1" },
    });
    assert.equal(response.status, 200);
    const saved = await prisma.billingPurchase.findFirst({ where: { transactionId: "legacy-monthly-1" } });
    assert.equal(saved.benefitContract, null);
    assert.equal(saved.grantedCoins, 500);
    assert.equal(await prisma.coinTransaction.count({ where: { userId: user.id, reason: "billing_purchase" } }), 1);
  });

  it("keeps the legacy bootstrap shape while exposing Gold fields only to capable clients", async () => {
    const { token } = await createTestUser();
    const legacy = await bootstrap(token);
    assert.equal(legacy.goldPolicy, undefined);
    assert.equal(legacy.products.some((p) => p.id === "plus_weekly"), false);
    assert.deepEqual(legacy.credits, { paid: 0, trial: 0, trialExpiresAt: null });

    const gold = await bootstrap(token, "characters,bara_gold_v1");
    assert.deepEqual(
      gold.products.filter((p) => p.kind === "subscription").map((p) => [
        p.id,
        p.plan,
        p.coins,
        p.trialCoins,
        p.credits,
        p.benefitVersion,
      ]),
      [
        ["plus_weekly", "weekly", 200, 200, 0, "bara_gold_v1"],
        ["plus_monthly", "monthly", 1000, 1000, 0, "bara_gold_v1"],
      ],
    );
    assert.deepEqual(gold.goldPolicy, {
      version: "bara_gold_v1",
      isMember: false,
      weeklyProductId: "bara_plus_weekly_v1",
      monthlyProductId: "bara_plus_monthly_v1",
    });
  });

  it("fulfills Gold paid subscription grants once and never creates new credits", async () => {
    const { token, user } = await createTestUser();
    await bootstrap(token, "bara_gold_v1");
    history = {
      purchases: [purchase()],
      subscriptions: [subscription()],
      observedAt: new Date().toISOString(),
    };

    for (let i = 0; i < 2; i++) {
      const response = await request(server.baseUrl, "POST", "/billing/sync?platform=ios", {
        token,
        body: { transactionId: "gold-transaction-1" },
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).coins, 1000);
    }
    assert.equal(await prisma.billingCreditLot.count({ where: { identityId: { not: "" } } }), 0);
    assert.equal(await prisma.coinTransaction.count({ where: { userId: user.id, reason: "billing_purchase" } }), 1);
    const saved = await prisma.billingPurchase.findFirst({ where: { transactionId: "gold-transaction-1" } });
    assert.equal(saved.benefitKind, "paid");
    assert.equal(saved.grantedCoins, 1000);
    assert.equal(saved.grantedCredits, 0);
    assert.equal(saved.benefitContract, "bara_gold_v1");
  });

  it("grants a seven-day trial once across a weekly-to-monthly plan switch", async () => {
    const { token, user } = await createTestUser();
    await bootstrap(token, "bara_gold_v1");
    const trialStart = new Date().toISOString();
    const trialEnd = new Date(Date.now() + 7 * 86400000).toISOString();
    history = {
      purchases: [purchase({
        transactionId: "gold-trial-weekly",
        providerId: "gold-trial-weekly",
        productId: "plus_weekly",
        subscriptionId: "gold-weekly",
        paid: false,
        expiresAt: trialEnd,
        purchasedAt: trialStart,
      })],
      subscriptions: [subscription({
        providerId: "gold-weekly",
        productId: "plus_weekly",
        startsAt: trialStart,
        periodStartsAt: trialStart,
        accessUntil: trialEnd,
        trial: true,
        status: "trialing",
      })],
      observedAt: new Date().toISOString(),
    };
    let response = await request(server.baseUrl, "POST", "/billing/sync?platform=ios", { token, body: {} });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).coins, 200);

    history.purchases.push(purchase({
      transactionId: "gold-trial-monthly-replay",
      providerId: "gold-trial-monthly-replay",
      productId: "plus_monthly",
      subscriptionId: "gold-monthly",
      paid: false,
      expiresAt: trialEnd,
      purchasedAt: trialStart,
    }));
    history.subscriptions.push(subscription({
      providerId: "gold-monthly",
      productId: "plus_monthly",
      startsAt: trialStart,
      periodStartsAt: trialStart,
      accessUntil: trialEnd,
      trial: true,
      status: "trialing",
    }));
    response = await request(server.baseUrl, "POST", "/billing/sync?platform=ios", { token, body: {} });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).coins, 200);
    assert.equal(await prisma.coinTransaction.count({ where: { userId: user.id, reason: "billing_trial" } }), 1);
  });

  it("uses backend membership for a free single reroll and preserves idempotency", async () => {
    const { token, user } = await createTestUser({ coins: 100 });
    await goldMember(user.id);
    const race = await prisma.race.create({ data: { creatorId: user.id, name: "Gold reroll", targetSteps: 1000, status: "ACTIVE", startedAt: new Date(), maxDurationDays: 1 } });
    const participant = await prisma.raceParticipant.create({ data: { raceId: race.id, userId: user.id, status: "ACCEPTED" } });
    const powerup = await prisma.racePowerup.create({ data: { raceId: race.id, participantId: participant.id, userId: user.id, type: "PROTEIN_SHAKE", rarity: "COMMON" } });
    const key = randomUUID();
    const body = { powerupIds: [powerup.id], funding: "coins", expectedCoinCost: 50 };
    const first = await request(server.baseUrl, "POST", `/races/${race.id}/powerups/reroll-purchase`, {
      token,
      headers: { "Idempotency-Key": key, "X-Client-Features": "bara_gold_v1,powerups5" },
      body,
    });
    assert.equal(first.status, 200);
    const result = await first.json();
    assert.deepEqual(result.charged, { coins: 0, paidCredits: 0, trialCredits: 0, freeGold: 1 });
    assert.equal(result.coins, 100);
    const replay = await request(server.baseUrl, "POST", `/races/${race.id}/powerups/reroll-purchase`, {
      token,
      headers: { "Idempotency-Key": key, "X-Client-Features": "bara_gold_v1,powerups5" },
      body,
    });
    assert.deepEqual(await replay.json(), result);
    assert.equal(await prisma.coinTransaction.count({ where: { userId: user.id, reason: "billing_reroll" } }), 0);
  });
});
