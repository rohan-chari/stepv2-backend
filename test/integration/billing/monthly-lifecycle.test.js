const assert = require("node:assert/strict");
const { before, after, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  prisma,
  request,
  startServer,
} = require("../setup");
const { createRevenueCatProvider } = require("../../../src/modules/billing/services/revenueCatProvider");
const { runBillingReconciliation } = require("../../../src/modules/billing/services/reconciliationWorker");

const CUTOVER = "2026-09-01T00:00:00.000Z";
const config = {
  projectId: "bara-gold-monthly-lifecycle",
  secretApiKey: "integration-only",
  webhookAuthorization: "Bearer bara-gold-monthly-lifecycle",
  iosAppId: "bara-gold-monthly-ios",
  androidAppId: "bara-gold-monthly-android",
  termsUrl: "https://barastep.com/billing-terms",
  privacyUrl: "https://barastep.com/privacy",
  monthlyGoldContractCutoverAt: CUTOVER,
};

let server;
let rawHistory;
let provider;

function iso(value) {
  return new Date(value).toISOString();
}

function rawTransaction(id, purchasedAt, { trial = false, subscriptionId = "monthly-sub" } = {}) {
  const start = new Date(purchasedAt);
  const expires = new Date(start.getTime() + (trial ? 7 : 30) * 86400000);
  return {
    id,
    product_store_identifier: "bara_plus_monthly_v1",
    purchased_at: start.getTime(),
    expiration_date: expires.getTime(),
    effective_expiration_date: expires.getTime(),
    revenue_in_usd: { gross: trial ? 0 : 2.99 },
    subscription_id: subscriptionId,
  };
}

function makeHistory(identityId, {
  initialAt = "2026-09-02T12:00:00.000Z",
  renewalAt = null,
  trial = false,
  reverseTransactions = false,
  initialId = "monthly-initial",
  renewalId = "monthly-renewal",
  subscriptionId = "monthly-sub",
} = {}) {
  const transactions = [rawTransaction(initialId, initialAt, { trial, subscriptionId })];
  if (renewalAt) transactions.push(rawTransaction(renewalId, renewalAt, { subscriptionId }));
  const ordered = reverseTransactions ? [...transactions].reverse() : transactions;
  const current = renewalAt || initialAt;
  const currentEnd = new Date(new Date(current).getTime() + 30 * 86400000);
  const initial = new Date(initialAt);
  return {
    customerId: identityId,
    purchases: [],
    subscriptions: [{
      id: subscriptionId,
      customer_id: identityId,
      original_customer_id: identityId,
      ownership: "purchased",
      environment: "production",
      store: "app_store",
      product_id: "monthly",
      starts_at: initial.getTime(),
      current_period_starts_at: new Date(current).getTime(),
      current_period_ends_at: currentEnd.getTime(),
      gives_access: true,
      status: trial && !renewalAt ? "trialing" : "active",
      auto_renewal_status: "will_renew",
      management_url: "https://example.test/manage",
      transactionRows: ordered,
    }],
    observedAt: new Date().toISOString(),
  };
}

function emptyHistory(identityId) {
  return { ...makeHistory(identityId), subscriptions: [], purchases: [] };
}

function providerFetch() {
  return async (url) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const customerMarker = "/customers/";
    if (path.endsWith("/purchases")) {
      return Response.json({ items: rawHistory?.customerId ? rawHistory.purchases : [], next_page: null });
    }
    if (path.endsWith("/subscriptions")) {
      return Response.json({
        items: (rawHistory?.customerId ? rawHistory.subscriptions : []).map(({ transactionRows, ...row }) => row),
        next_page: null,
      });
    }
    if (path.includes("/transactions")) {
      const rows = rawHistory?.subscriptions?.find((row) => path.includes(`/subscriptions/${row.id}/`))?.transactionRows || [];
      return Response.json({ items: rows, next_page: null });
    }
    if (path.includes("/products/")) {
      const product = path.endsWith("/monthly")
        ? { id: "monthly", app_id: config.iosAppId, store_identifier: "bara_plus_monthly_v1" }
        : { id: "unknown", app_id: config.iosAppId, store_identifier: "bara_plus_monthly_v1" };
      return Response.json(product);
    }
    if (path.includes(customerMarker)) return Response.json({});
    throw new Error(`Unexpected RevenueCat fixture request: ${path}`);
  };
}

async function bootstrap(token, features = "bara_gold_v1") {
  const response = await request(server.baseUrl, "GET", "/billing/bootstrap?platform=ios", {
    token,
    headers: { "X-Client-Features": features },
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function sync(token) {
  const response = await request(server.baseUrl, "POST", "/billing/sync?platform=ios", {
    token,
    headers: { "X-Client-Features": "bara_gold_v1" },
    body: {},
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function setupAccount(options = {}) {
  const owner = await createTestUser();
  const initial = await bootstrap(owner.token);
  rawHistory = makeHistory(initial.identity.appUserId, options);
  return { ...owner, identityId: initial.identity.appUserId };
}

async function runWorker(identityId) {
  const result = await runBillingReconciliation({
    db: prisma,
    config,
    provider,
    identityId,
    logger: { error() {} },
  });
  assert.equal(result.failed, 0);
  assert.equal(result.processed, 1);
  return result;
}

async function stateFor(userId) {
  const identity = await prisma.billingIdentity.findUnique({ where: { userId } });
  const [purchase, subscription, user, grants] = await Promise.all([
    prisma.billingPurchase.findFirst({ where: { identityId: identity.id }, orderBy: { purchasedAt: "asc" } }),
    prisma.billingSubscription.findFirst({ where: { identityId: identity.id } }),
    prisma.user.findUnique({ where: { id: userId }, select: { coins: true } }),
    prisma.coinTransaction.findMany({ where: { userId, reason: { in: ["billing_purchase", "billing_trial"] } } }),
  ]);
  return { purchase, subscription, coins: user.coins, grants };
}

async function deliverWebhook(identityId, eventId = "monthly-webhook") {
  const response = await request(server.baseUrl, "POST", "/billing/webhook/revenuecat", {
    headers: { Authorization: config.webhookAuthorization },
    body: {
      event: {
        id: eventId,
        type: "INITIAL_PURCHASE",
        app_user_id: identityId,
        app_id: config.iosAppId,
        store: "APP_STORE",
        environment: "PRODUCTION",
        product_id: "bara_plus_monthly_v1",
        transaction_id: "monthly-initial",
        event_timestamp_ms: Date.now(),
      },
    },
  });
  assert.equal(response.status, 200);
}

before(async () => {
  provider = createRevenueCatProvider({ config, fetch: providerFetch() });
  server = await startServer({ billingConfig: config, billingProvider: provider });
});

after(async () => server?.close());

beforeEach(async () => {
  await cleanDatabase();
  rawHistory = null;
});

describe("Bara Gold monthly lifecycle integration", () => {
  it("processes webhook-first activation through the real reconciliation worker", async () => {
    const account = await setupAccount();
    await deliverWebhook(account.identityId);
    assert.equal(await prisma.billingPurchase.count(), 0);
    await runWorker(account.identityId);
    const state = await stateFor(account.user.id);
    assert.equal(state.purchase.benefitContract, "bara_gold_v1");
    assert.equal(state.subscription.benefitContract, "bara_gold_v1");
    assert.equal(state.purchase.grantedCoins, 1000);
    assert.equal(state.coins, 1000);
    assert.equal(state.grants.length, 1);
    assert.equal((await bootstrap(account.token)).goldPolicy.isMember, true);
  });

  it("processes reconciliation-first activation without a client hint or webhook", async () => {
    const account = await setupAccount();
    await runWorker(account.identityId);
    const state = await stateFor(account.user.id);
    assert.equal(state.purchase.benefitContract, "bara_gold_v1");
    assert.equal(state.subscription.benefitContract, "bara_gold_v1");
    assert.equal(state.purchase.grantedCoins, 1000);
    assert.equal(state.grants.length, 1);
  });

  it("converges when sync precedes webhook and when webhook precedes sync", async () => {
    const first = await setupAccount();
    await sync(first.token);
    await deliverWebhook(first.identityId, "sync-then-webhook");
    await runWorker(first.identityId);
    const firstState = await stateFor(first.user.id);

    await cleanDatabase();
    rawHistory = null;
    const second = await setupAccount();
    await deliverWebhook(second.identityId, "webhook-then-sync");
    await runWorker(second.identityId);
    await sync(second.token);
    const secondState = await stateFor(second.user.id);

    for (const state of [firstState, secondState]) {
      assert.equal(state.purchase.benefitContract, "bara_gold_v1");
      assert.equal(state.subscription.benefitContract, "bara_gold_v1");
      assert.equal(state.coins, 1000);
      assert.equal(state.grants.length, 1);
    }
    assert.equal(await prisma.billingPurchase.count(), 1);
  });

  it("recovers an app termination and a second-device restore without duplicate fulfillment", async () => {
    const account = await setupAccount();
    await runWorker(account.identityId);
    await sync(account.token);
    await sync(account.token);
    const state = await stateFor(account.user.id);
    assert.equal(state.purchase.benefitContract, "bara_gold_v1");
    assert.equal(state.subscription.benefitContract, "bara_gold_v1");
    assert.equal(state.coins, 1000);
    assert.equal(state.grants.length, 1);
    assert.equal(await prisma.billingPurchase.count(), 1);
  });

  it("keeps a historical monthly restore and post-cutover renewal legacy", async () => {
    const account = await setupAccount({
      initialAt: "2026-08-31T23:59:59.000Z",
      renewalAt: "2026-09-15T12:00:00.000Z",
      initialId: "legacy-initial",
      renewalId: "legacy-renewal",
    });
    await sync(account.token);
    const state = await stateFor(account.user.id);
    assert.equal(state.purchase.benefitContract, null);
    assert.equal(state.subscription.benefitContract, null);
    assert.equal(state.coins, 1000);
    assert.equal(state.grants.length, 2);
    assert.ok(state.grants.every((grant) => grant.amount === 500));
    assert.equal((await bootstrap(account.token)).goldPolicy.isMember, false);
  });

  it("keeps a Gold monthly restore and renewal Gold with one grant per transaction", async () => {
    const account = await setupAccount({ renewalAt: "2026-09-15T12:00:00.000Z" });
    await sync(account.token);
    await sync(account.token);
    const state = await stateFor(account.user.id);
    assert.equal(state.purchase.benefitContract, "bara_gold_v1");
    assert.equal(state.subscription.benefitContract, "bara_gold_v1");
    assert.equal(state.coins, 2000);
    assert.equal(state.grants.length, 2);
    assert.ok(state.grants.every((grant) => grant.amount === 1000));
  });

  it("deduplicates repeated webhook and reconciliation delivery", async () => {
    const account = await setupAccount();
    await deliverWebhook(account.identityId, "duplicate-webhook");
    await deliverWebhook(account.identityId, "duplicate-webhook");
    await runWorker(account.identityId);
    await prisma.billingReconciliation.update({ where: { identityId: account.identityId }, data: { nextAttemptAt: new Date() } });
    await runWorker(account.identityId);
    const state = await stateFor(account.user.id);
    assert.equal(state.coins, 1000);
    assert.equal(state.grants.length, 1);
    assert.equal(await prisma.billingPurchase.count(), 1);
    assert.equal(await prisma.billingInbox.count(), 1);
  });

  it("derives the contract from the first verified transaction, not provider order", async () => {
    const account = await setupAccount({
      initialAt: "2026-08-31T23:59:59.000Z",
      renewalAt: "2026-09-15T12:00:00.000Z",
      reverseTransactions: true,
      initialId: "out-of-order-legacy-initial",
      renewalId: "out-of-order-legacy-renewal",
    });
    await sync(account.token);
    const purchases = await prisma.billingPurchase.findMany({ orderBy: { purchasedAt: "asc" } });
    assert.equal(purchases.length, 2);
    assert.ok(purchases.every((purchase) => purchase.benefitContract === null));
    assert.equal((await bootstrap(account.token)).goldPolicy.isMember, false);
  });

  it("converges across all mixed delivery orders", async () => {
    const orders = ["sync-webhook-reconcile", "webhook-reconcile-sync", "reconcile-webhook-sync"];
    for (const order of orders) {
      await cleanDatabase();
      rawHistory = null;
      const account = await setupAccount();
      if (order === "sync-webhook-reconcile") {
        await sync(account.token);
        await deliverWebhook(account.identityId, `${order}-event`);
        await runWorker(account.identityId);
      } else if (order === "webhook-reconcile-sync") {
        await deliverWebhook(account.identityId, `${order}-event`);
        await runWorker(account.identityId);
        await sync(account.token);
      } else {
        await runWorker(account.identityId);
        await deliverWebhook(account.identityId, `${order}-event`);
        await sync(account.token);
      }
      const state = await stateFor(account.user.id);
      assert.equal(state.purchase.benefitContract, "bara_gold_v1", order);
      assert.equal(state.subscription.benefitContract, "bara_gold_v1", order);
      assert.equal(state.coins, 1000, order);
      assert.equal(state.grants.length, 1, order);
    }
  });

  it("grants Gold trial coins once and preserves legacy trial semantics", async () => {
    const gold = await setupAccount({ trial: true, initialId: "gold-trial" });
    await sync(gold.token);
    await sync(gold.token);
    const goldState = await stateFor(gold.user.id);
    assert.equal(goldState.purchase.benefitContract, "bara_gold_v1");
    assert.equal(goldState.purchase.benefitKind, "trial");
    assert.equal(goldState.purchase.grantedCoins, 1000);
    assert.equal(goldState.grants.length, 1);
    assert.equal((await bootstrap(gold.token)).goldPolicy.isMember, true);

    await cleanDatabase();
    rawHistory = null;
    const legacy = await setupAccount({ trial: true, initialAt: "2026-08-01T12:00:00.000Z", initialId: "legacy-trial" });
    await sync(legacy.token);
    const legacyState = await stateFor(legacy.user.id);
    assert.equal(legacyState.purchase.benefitContract, null);
    assert.equal(legacyState.purchase.grantedCoins, 0);
    assert.equal(legacyState.grants.length, 0);
    assert.equal((await bootstrap(legacy.token)).goldPolicy.isMember, false);
  });
});
