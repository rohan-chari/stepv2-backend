const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { describe, it, before, after, beforeEach } = require("node:test");
const {
  prisma,
  cleanDatabase,
  createTestUser,
  request,
  getSharedServer,
  startServer,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const {
  buildRacePayoutDoubleReconcile,
} = require("../../src/modules/races/jobs/racePayoutDoubleReconcile");

const CAPABLE = { "X-Client-Features": "race_payout_double" };
const ALLOWED_UNIT = "ca-app-pub-3940256099942544/5224354917";
// AdMob's real SSV callback sends `ad_unit` as the bare unit ID (no publisher
// prefix) — this is what actually lands in the ad_unit query param and gets
// stored on ad_reward_grants.adUnit, so every simulated grant/callback below
// must use this, not ALLOWED_UNIT, or the test stops reflecting production.
const ALLOWED_UNIT_SUFFIX = "5224354917";

let server;

async function completedRace(userId, {
  payoutCoins = 0,
  placement = 1,
  seen = false,
  status = "ACCEPTED",
  reason = null,
  amount = payoutCoins,
  refId = null,
} = {}) {
  const race = await prisma.race.create({
    data: {
      creatorId: userId,
      name: `Settled ${crypto.randomUUID()}`,
      targetSteps: 1000,
      status: "COMPLETED",
      completedAt: new Date(),
    },
  });
  const participant = await prisma.raceParticipant.create({
    data: {
      raceId: race.id,
      userId,
      status,
      payoutCoins,
      placement,
      resultsSeenAt: seen ? new Date() : null,
    },
  });
  if (reason && amount > 0) {
    const exactRef = refId || (reason === "race_finish_reward"
      ? `${race.id}:rank:${placement}`
      : `${race.id}:${placement}`);
    await prisma.coinTransaction.create({
      data: { userId, amount, reason, refId: exactRef },
    });
  }
  return { race, participant };
}

async function list(token, headers = CAPABLE) {
  const res = await request(server.baseUrl, "GET", "/races", { token, headers });
  return { res, body: await res.json() };
}

async function prepare(token, raceIds, headers = CAPABLE) {
  const res = await request(
    server.baseUrl,
    "POST",
    "/races/results/double-payout/offer",
    { token, headers, body: { raceIds } },
  );
  return { res, body: await res.json() };
}

async function verifyAndClaim({ userId, token, offerId }) {
  await prisma.adRewardGrant.create({
    data: {
      userId,
      transactionId: crypto.randomUUID(),
      adUnit: ALLOWED_UNIT_SUFFIX,
      rewardKind: "race_payout_double",
      grantedDate: "2026-08-12",
      contextId: offerId,
    },
  });
  const response = await request(
    server.baseUrl,
    "POST",
    `/races/results/double-payout/${offerId}/claim`,
    { token, headers: CAPABLE, body: {} },
  );
  return { response, body: await response.json() };
}

describe("race payout double rewarded ad", () => {
  before(async () => {
    process.env.ADS_RACE_PAYOUT_DOUBLE_PREPARE_ENABLED = "true";
    process.env.ADS_RACE_PAYOUT_DOUBLE_CLAIM_ENABLED = "true";
    process.env.ADMOB_RACE_PAYOUT_DOUBLE_AD_UNIT_IDS = ALLOWED_UNIT;
    process.env.RACE_PAYOUT_DOUBLE_MAX_BONUS_COINS = "500";
    process.env.REDIS_URL = "";
    server = await getSharedServer();
  });

  after(() => {
    delete process.env.ADS_RACE_PAYOUT_DOUBLE_PREPARE_ENABLED;
    delete process.env.ADS_RACE_PAYOUT_DOUBLE_CLAIM_ENABLED;
    delete process.env.ADMOB_RACE_PAYOUT_DOUBLE_AD_UNIT_IDS;
    delete process.env.RACE_PAYOUT_DOUBLE_MAX_BONUS_COINS;
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.appSetting.upsert({
      where: { key: "racePayoutDoubleRolloutPercent" },
      create: { key: "racePayoutDoubleRolloutPercent", value: 100 },
      update: { value: 100 },
    });
    appSettings.bustCache();
  });

  it("keeps tokenless GET /races byte-compatible and derives exact eligible sums for capable clients", async () => {
    const { user, token } = await createTestUser({ appleId: `apple-${crypto.randomUUID()}` });
    const first = await completedRace(user.id, {
      payoutCoins: 70,
      amount: 40,
      reason: "race_prize_pool_payout",
    });
    const second = await completedRace(user.id, {
      payoutCoins: 80,
      amount: 80,
      reason: "race_finish_reward",
    });
    await completedRace(user.id, { payoutCoins: 25 });

    const old = await list(token, {});
    assert.equal(old.res.status, 200);
    assert.equal(Object.hasOwn(old.body, "payoutDoubleOffer"), false);

    const capable = await list(token);
    assert.equal(capable.res.status, 200);
    assert.deepEqual(new Set(capable.body.payoutDoubleOffer.raceIds), new Set([
      first.race.id,
      second.race.id,
    ]));
    assert.deepEqual(capable.body.payoutDoubleOffer, {
      offerId: null,
      raceIds: capable.body.payoutDoubleOffer.raceIds,
      baseCoins: 120,
      bonusCoins: 100,
      maxBonusCoins: 100,
      rolling24hRemainingBeforeClaim: 100,
    });
    assert.equal(capable.body.completed.length, 3);
  });

  it("caps the prospective offer while preserving the authoritative base", async () => {
    const { user, token } = await createTestUser();
    await completedRace(user.id, {
      payoutCoins: 800,
      amount: 800,
      reason: "race_prize_pool_payout",
    });
    const { body } = await list(token);
    assert.equal(body.payoutDoubleOffer.baseCoins, 800);
    assert.equal(body.payoutDoubleOffer.bonusCoins, 100);
    assert.equal(body.payoutDoubleOffer.maxBonusCoins, 100);
  });

  it("caps an oversized payout double at 100 through offer persistence and claim settlement", async () => {
    const { user, token } = await createTestUser({ coins: 0 });
    const race = await completedRace(user.id, {
      payoutCoins: 853,
      amount: 853,
      reason: "race_prize_pool_payout",
    });

    const prospective = await list(token);
    assert.equal(prospective.body.payoutDoubleOffer.baseCoins, 853);
    assert.equal(prospective.body.payoutDoubleOffer.bonusCoins, 100);
    assert.equal(prospective.body.payoutDoubleOffer.maxBonusCoins, 100);
    assert.equal(
      prospective.body.payoutDoubleOffer.rolling24hRemainingBeforeClaim,
      100,
    );

    const offer = await prepare(token, [race.race.id]);
    assert.equal(offer.res.status, 201);
    assert.equal(offer.body.baseCoins, 853);
    assert.equal(offer.body.bonusCoins, 100);
    assert.equal(offer.body.maxBonusCoins, 100);

    const claim = await verifyAndClaim({
      userId: user.id,
      token,
      offerId: offer.body.offerId,
    });
    assert.equal(claim.response.status, 200);
    assert.equal(claim.body.bonusCoins, 100);
    assert.equal(claim.body.coins, 100);

    const [ledger, velocity, receipt, grant] = await Promise.all([
      prisma.coinTransaction.findFirst({
        where: {
          userId: user.id,
          reason: "race_payout_ad_double",
          refId: offer.body.offerId,
        },
      }),
      prisma.racePayoutDoubleVelocityGrant.findUnique({
        where: { offerId: offer.body.offerId },
      }),
      prisma.racePayoutDoubleClaimReceipt.findUnique({
        where: { offerId: offer.body.offerId },
      }),
      prisma.adRewardGrant.findFirst({
        where: {
          userId: user.id,
          rewardKind: "race_payout_double",
          contextId: offer.body.offerId,
        },
      }),
    ]);
    assert.equal(ledger.amount, 100);
    assert.equal(velocity.bonusCoins, 100);
    assert.equal(receipt.bonusCoins, 100);
    assert.equal(grant.coinAmount, 100);
  });

  it("re-caps and repairs a legacy persisted offer before issuing any coins", async () => {
    const { user, token } = await createTestUser({ coins: 0 });
    const race = await completedRace(user.id, {
      payoutCoins: 500,
      amount: 500,
      reason: "race_prize_pool_payout",
    });
    const offer = await prepare(token, [race.race.id]);
    assert.equal(offer.res.status, 201);

    // Simulate an offer persisted by the briefly deployed uncapped code. The
    // original database constraint allowed values through 500.
    await prisma.racePayoutDoubleOffer.update({
      where: { id: offer.body.offerId },
      data: {
        bonusCoins: 500,
        maxBonusCoins: 500,
        rolling24hRemainingBeforeClaim: 500,
      },
    });

    const retry = await prepare(token, [race.race.id]);
    assert.equal(retry.res.status, 200);
    assert.equal(retry.body.offerId, offer.body.offerId);
    assert.equal(retry.body.baseCoins, 500);
    assert.equal(retry.body.bonusCoins, 100);
    assert.equal(retry.body.maxBonusCoins, 100);
    assert.equal(retry.body.rolling24hRemainingBeforeClaim, 100);

    const recovered = await list(token);
    assert.equal(recovered.body.payoutDoubleOffer.offerId, offer.body.offerId);
    assert.equal(recovered.body.payoutDoubleOffer.baseCoins, 500);
    assert.equal(recovered.body.payoutDoubleOffer.bonusCoins, 100);
    assert.equal(recovered.body.payoutDoubleOffer.maxBonusCoins, 100);

    const claim = await verifyAndClaim({
      userId: user.id,
      token,
      offerId: offer.body.offerId,
    });
    assert.equal(claim.response.status, 200);
    assert.equal(claim.body.bonusCoins, 100);
    assert.equal(claim.body.coins, 100);

    const repaired = await prisma.racePayoutDoubleOffer.findUnique({
      where: { id: offer.body.offerId },
    });
    assert.equal(repaired.status, "CLAIMED");
    assert.equal(repaired.bonusCoins, 100);
    assert.equal(repaired.maxBonusCoins, 100);
    assert.equal(repaired.rolling24hRemainingBeforeClaim, 100);
    assert.equal(await prisma.coinTransaction.count({
      where: {
        userId: user.id,
        reason: "race_payout_ad_double",
        refId: offer.body.offerId,
        amount: { gt: 100 },
      },
    }), 0);
  });

  it("recomputes a pending offer against a lowered runtime cap and current rolling usage", async () => {
    const { user, token } = await createTestUser({ coins: 0 });
    const race = await completedRace(user.id, {
      payoutCoins: 100,
      amount: 100,
      reason: "race_prize_pool_payout",
    });
    const offer = await prepare(token, [race.race.id]);
    assert.equal(offer.res.status, 201);
    const persisted = await prisma.racePayoutDoubleOffer.findUnique({
      where: { id: offer.body.offerId },
    });
    const databaseNow = (await prisma.$queryRaw`SELECT NOW() AS now`)[0].now;
    await prisma.racePayoutDoubleVelocityGrant.create({
      data: {
        providerSubHash: persisted.providerSubHash,
        offerId: crypto.randomUUID(),
        bonusCoins: 20,
        // Keep the fixture inside the database-owned half-open window without
        // risking the application clock landing a few milliseconds after NOW().
        claimedAt: new Date(databaseNow.getTime() - 1000),
      },
    });
    process.env.RACE_PAYOUT_DOUBLE_MAX_BONUS_COINS = "40";
    try {
      const recovered = await list(token);
      assert.equal(recovered.body.payoutDoubleOffer.bonusCoins, 20);
      assert.equal(recovered.body.payoutDoubleOffer.maxBonusCoins, 40);
      assert.equal(
        recovered.body.payoutDoubleOffer.rolling24hRemainingBeforeClaim,
        20,
      );
      const retry = await prepare(token, [race.race.id]);
      assert.equal(retry.res.status, 200);
      assert.equal(retry.body.bonusCoins, 20);
      assert.equal(retry.body.maxBonusCoins, 40);
      assert.equal(retry.body.rolling24hRemainingBeforeClaim, 20);

      const claim = await verifyAndClaim({
        userId: user.id,
        token,
        offerId: offer.body.offerId,
      });
      assert.equal(claim.response.status, 200);
      assert.equal(claim.body.bonusCoins, 20);
      assert.equal(claim.body.maxBonusCoins, 40);
      assert.equal(claim.body.coins, 20);
    } finally {
      process.env.RACE_PAYOUT_DOUBLE_MAX_BONUS_COINS = "500";
    }

    const [repaired, ledger, velocity, receipt, grant] = await Promise.all([
      prisma.racePayoutDoubleOffer.findUnique({
        where: { id: offer.body.offerId },
      }),
      prisma.coinTransaction.findFirst({
        where: {
          userId: user.id,
          reason: "race_payout_ad_double",
          refId: offer.body.offerId,
        },
      }),
      prisma.racePayoutDoubleVelocityGrant.findUnique({
        where: { offerId: offer.body.offerId },
      }),
      prisma.racePayoutDoubleClaimReceipt.findUnique({
        where: { offerId: offer.body.offerId },
      }),
      prisma.adRewardGrant.findFirst({
        where: {
          userId: user.id,
          rewardKind: "race_payout_double",
          contextId: offer.body.offerId,
        },
      }),
    ]);
    assert.equal(repaired.bonusCoins, 20);
    assert.equal(repaired.maxBonusCoins, 40);
    assert.equal(repaired.rolling24hRemainingBeforeClaim, 20);
    assert.equal(ledger.amount, 20);
    assert.equal(velocity.bonusCoins, 20);
    assert.equal(receipt.bonusCoins, 20);
    assert.equal(grant.coinAmount, 20);
  });

  it("excludes malformed, broad-prefix, buy-in, refund, and unrelated ledger sources", async () => {
    const { user, token } = await createTestUser();
    const eligible = await completedRace(user.id, {
      payoutCoins: 90,
      amount: 30,
      reason: "race_finish_reward",
    });
    const bad = await completedRace(user.id, { payoutCoins: 200 });
    await prisma.coinTransaction.createMany({ data: [
      { userId: user.id, amount: 90, reason: "race_prize_pool_payout", refId: `${bad.race.id}:1:collision` },
      { userId: user.id, amount: 50, reason: "race_buy_in_payout", refId: `${bad.race.id}:1` },
      { userId: user.id, amount: 50, reason: "race_buy_in_refund", refId: `${bad.race.id}:1` },
      { userId: user.id, amount: 50, reason: "referral_reward", refId: `${bad.race.id}:1` },
    ] });
    const { body } = await list(token);
    assert.deepEqual(body.payoutDoubleOffer.raceIds, [eligible.race.id]);
    assert.equal(body.payoutDoubleOffer.baseCoins, 30);
  });

  it("prepares an immutable exact batch and exact retry is idempotent", async () => {
    const { user, token } = await createTestUser();
    const a = await completedRace(user.id, { payoutCoins: 40, reason: "race_prize_pool_payout" });
    const b = await completedRace(user.id, { payoutCoins: 80, reason: "race_finish_reward" });
    const ids = [a.race.id, b.race.id];

    const first = await prepare(token, ids);
    assert.equal(first.res.status, 201);
    assert.equal(first.body.status, "PENDING");
    assert.equal(first.body.baseCoins, 120);
    assert.equal(first.body.bonusCoins, 100);
    assert.deepEqual(new Set(first.body.raceIds), new Set(ids));

    const retry = await prepare(token, [...ids].reverse());
    assert.equal(retry.res.status, 200);
    assert.equal(retry.body.offerId, first.body.offerId);
    assert.equal(await prisma.racePayoutDoubleOffer.count(), 1);
    assert.equal(await prisma.racePayoutDoubleOfferItem.count(), 2);

    const changed = await prepare(token, [ids[0]]);
    assert.equal(changed.res.status, 409);
    assert.equal(changed.body.code, "OFFER_PENDING");
  });

  it("serializes concurrent exact preparations into one immutable offer", async () => {
    const { user, token } = await createTestUser();
    const race = await completedRace(user.id, { payoutCoins: 40, reason: "race_prize_pool_payout" });
    const [left, right] = await Promise.all([
      prepare(token, [race.race.id]),
      prepare(token, [race.race.id]),
    ]);
    assert.deepEqual(new Set([left.res.status, right.res.status]), new Set([200, 201]));
    assert.equal(left.body.offerId, right.body.offerId);
    assert.equal(await prisma.racePayoutDoubleOffer.count(), 1);
    assert.equal(await prisma.racePayoutDoubleOfferItem.count(), 1);
  });

  it("rejects duplicate IDs and a changed snapshot before creating an offer", async () => {
    const { user, token } = await createTestUser();
    const a = await completedRace(user.id, { payoutCoins: 40, reason: "race_prize_pool_payout" });
    const duplicate = await prepare(token, [a.race.id, a.race.id]);
    assert.equal(duplicate.res.status, 400);
    assert.equal(duplicate.body.code, "INVALID_REQUEST");
    const changed = await prepare(token, [crypto.randomUUID()]);
    assert.equal(changed.res.status, 409);
    assert.equal(changed.body.code, "OFFER_CHANGED");
    assert.equal(await prisma.racePayoutDoubleOffer.count(), 0);
  });

  it("returns AD_NOT_VERIFIED without changing economic rows", async () => {
    const { user, token } = await createTestUser({ coins: 10 });
    const a = await completedRace(user.id, { payoutCoins: 40, reason: "race_prize_pool_payout" });
    const offer = await prepare(token, [a.race.id]);
    const claim = await request(
      server.baseUrl,
      "POST",
      `/races/results/double-payout/${offer.body.offerId}/claim`,
      { token, headers: CAPABLE, body: {} },
    );
    assert.equal(claim.status, 409);
    assert.equal((await claim.json()).code, "AD_NOT_VERIFIED");
    assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).coins, 10);
    assert.equal(await prisma.coinTransaction.count({ where: { reason: "race_payout_ad_double" } }), 0);
  });

  it("rejects an SSV callback for a foreign ad unit and mints no grant", async () => {
    const { user, token } = await createTestUser({ coins: 10 });
    const a = await completedRace(user.id, { payoutCoins: 40, reason: "race_prize_pool_payout" });
    const offer = await prepare(token, [a.race.id]);
    const offerId = offer.body.offerId;
    const ssvServer = await startServer({ verifySsv: async () => true });
    try {
      const qs = new URLSearchParams({
        transaction_id: crypto.randomUUID(),
        user_id: user.id,
        ad_unit: "9999999999",
        custom_data: `race_payout_double:${user.id}:${offerId}`,
      });
      const ssv = await fetch(`${ssvServer.baseUrl}/ads/ssv?${qs}`);
      assert.equal(ssv.status, 200);
    } finally {
      await ssvServer.close();
    }
    const grant = await prisma.adRewardGrant.findFirst({
      where: { userId: user.id, rewardKind: "race_payout_double", contextId: offerId },
    });
    assert.equal(grant, null);
  });

  it("accepts only allowlisted exact SSV namespace and claims once with idempotent replay", async () => {
    const { user, token } = await createTestUser({ coins: 10 });
    const a = await completedRace(user.id, { payoutCoins: 40, reason: "race_prize_pool_payout" });
    const offer = await prepare(token, [a.race.id]);
    const offerId = offer.body.offerId;
    const ssvServer = await startServer({ verifySsv: async () => true });
    try {
      const qs = new URLSearchParams({
        transaction_id: crypto.randomUUID(),
        user_id: user.id,
        ad_unit: ALLOWED_UNIT_SUFFIX,
        custom_data: `race_payout_double:${user.id}:${offerId}`,
      });
      const ssv = await fetch(`${ssvServer.baseUrl}/ads/ssv?${qs}`);
      assert.equal(ssv.status, 200);
    } finally {
      await ssvServer.close();
    }
    const grant = await prisma.adRewardGrant.findFirst({
      where: { userId: user.id, rewardKind: "race_payout_double", contextId: offerId },
    });
    assert.ok(grant);

    const first = await request(server.baseUrl, "POST", `/races/results/double-payout/${offerId}/claim`, {
      token, headers: CAPABLE, body: {},
    });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      awarded: true,
      alreadyClaimed: false,
      baseCoins: 40,
      bonusCoins: 40,
      maxBonusCoins: 100,
      rolling24hRemainingBeforeClaim: 100,
      coins: 50,
      raceIds: [a.race.id],
    });

    const replay = await request(server.baseUrl, "POST", `/races/results/double-payout/${offerId}/claim`, {
      token, headers: CAPABLE, body: {},
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), {
      awarded: false,
      alreadyClaimed: true,
      baseCoins: 40,
      bonusCoins: 40,
      maxBonusCoins: 100,
      rolling24hRemainingBeforeClaim: 100,
      coins: 50,
      raceIds: [a.race.id],
    });
    assert.equal(await prisma.coinTransaction.count({
      where: { userId: user.id, reason: "race_payout_ad_double", refId: offerId },
    }), 1);
  });

  it("serializes concurrent claims and awards the combined batch once", async () => {
    const { user, token } = await createTestUser();
    const race = await completedRace(user.id, { payoutCoins: 40, reason: "race_prize_pool_payout" });
    const offer = await prepare(token, [race.race.id]);
    await prisma.adRewardGrant.create({
      data: {
        userId: user.id,
        transactionId: crypto.randomUUID(),
        adUnit: ALLOWED_UNIT_SUFFIX,
        rewardKind: "race_payout_double",
        grantedDate: "2026-08-12",
        contextId: offer.body.offerId,
      },
    });
    const claim = () => request(
      claimServer.baseUrl,
      "POST",
      `/races/results/double-payout/${offer.body.offerId}/claim`,
      { token, headers: CAPABLE, body: {} },
    );
    const errors = [];
    const claimServer = await startServer({
      onRacePayoutDoubleError(error) {
        errors.push({ code: error.code, meta: error.meta, message: error.message });
      },
    });
    const responses = await Promise.all([claim(), claim()]);
    await claimServer.close();
    if (responses.some((response) => response.status !== 200)) {
      assert.fail(JSON.stringify(errors));
    }
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    assert.equal(bodies.filter((body) => body.awarded).length, 1);
    assert.equal(bodies.filter((body) => body.alreadyClaimed).length, 1);
    assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).coins, 40);
    assert.equal(await prisma.coinTransaction.count({ where: { reason: "race_payout_ad_double" } }), 1);
  });

  it("rolls back grant, offer, ledger, and balance together on a mid-transaction failure", async () => {
    const { user, token } = await createTestUser({ coins: 5 });
    const race = await completedRace(user.id, { payoutCoins: 40, reason: "race_prize_pool_payout" });
    const offer = await prepare(token, [race.race.id]);
    const grant = await prisma.adRewardGrant.create({
      data: {
        userId: user.id,
        transactionId: crypto.randomUUID(),
        adUnit: ALLOWED_UNIT_SUFFIX,
        rewardKind: "race_payout_double",
        grantedDate: "2026-08-12",
        contextId: offer.body.offerId,
      },
    });
    const failingServer = await startServer({
      beforeRacePayoutDoubleCommit: async () => { throw new Error("injected"); },
    });
    try {
      const response = await request(
        failingServer.baseUrl,
        "POST",
        `/races/results/double-payout/${offer.body.offerId}/claim`,
        { token, headers: CAPABLE, body: {} },
      );
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "REWARD_TEMPORARILY_UNAVAILABLE");
    } finally {
      await failingServer.close();
    }
    assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).coins, 5);
    assert.equal(await prisma.coinTransaction.count({ where: { reason: "race_payout_ad_double" } }), 0);
    assert.equal((await prisma.racePayoutDoubleOffer.findUnique({ where: { id: offer.body.offerId } })).status, "PENDING");
    assert.equal((await prisma.adRewardGrant.findUnique({ where: { id: grant.id } })).consumedAt, null);
    assert.equal(await prisma.racePayoutDoubleVelocityGrant.count(), 0);
    assert.equal(await prisma.racePayoutDoubleClaimReceipt.count(), 0);
  });

  it("capable results acknowledgement forfeits pending offers; tokenless acknowledgement preserves them", async () => {
    const capableUser = await createTestUser();
    const capableRace = await completedRace(capableUser.user.id, { payoutCoins: 40, reason: "race_prize_pool_payout" });
    const capableOffer = await prepare(capableUser.token, [capableRace.race.id]);
    const capableSeen = await request(server.baseUrl, "POST", "/races/results/seen", {
      token: capableUser.token,
      headers: CAPABLE,
      body: { raceIds: [capableRace.race.id] },
    });
    assert.equal(capableSeen.status, 200);
    assert.equal((await prisma.racePayoutDoubleOffer.findUnique({ where: { id: capableOffer.body.offerId } })).status, "FORFEITED");

    await cleanDatabase();
    await prisma.appSetting.upsert({
      where: { key: "racePayoutDoubleRolloutPercent" },
      create: { key: "racePayoutDoubleRolloutPercent", value: 100 },
      update: { value: 100 },
    });
    appSettings.bustCache();
    const oldUser = await createTestUser();
    const oldRace = await completedRace(oldUser.user.id, { payoutCoins: 40, reason: "race_prize_pool_payout" });
    const oldOffer = await prepare(oldUser.token, [oldRace.race.id]);
    const oldSeen = await request(server.baseUrl, "POST", "/races/results/seen", {
      token: oldUser.token,
      body: { raceIds: [oldRace.race.id] },
    });
    assert.equal(oldSeen.status, 200);
    assert.equal((await prisma.racePayoutDoubleOffer.findUnique({ where: { id: oldOffer.body.offerId } })).status, "PENDING");
    const recovery = await list(oldUser.token);
    assert.equal(recovery.body.payoutDoubleOffer.offerId, oldOffer.body.offerId);
    assert.equal(recovery.body.completed.some((race) => race.id === oldRace.race.id), true);
  });

  it("default-off switches, missing capability, and empty allowlist create nothing", async () => {
    const { user, token } = await createTestUser();
    const a = await completedRace(user.id, { payoutCoins: 40, reason: "race_prize_pool_payout" });
    process.env.ADS_RACE_PAYOUT_DOUBLE_PREPARE_ENABLED = "false";
    let attempt = await prepare(token, [a.race.id]);
    assert.equal(attempt.res.status, 403);
    assert.equal(attempt.body.code, "PREPARATION_DISABLED");
    process.env.ADS_RACE_PAYOUT_DOUBLE_PREPARE_ENABLED = "true";
    attempt = await prepare(token, [a.race.id], {});
    assert.equal(attempt.res.status, 403);
    assert.equal(attempt.body.code, "PREPARATION_DISABLED");
    process.env.ADMOB_RACE_PAYOUT_DOUBLE_AD_UNIT_IDS = "";
    attempt = await prepare(token, [a.race.id]);
    assert.equal(attempt.res.status, 403);
    assert.equal(attempt.body.code, "PREPARATION_DISABLED");
    process.env.ADMOB_RACE_PAYOUT_DOUBLE_AD_UNIT_IDS = ALLOWED_UNIT;
    assert.equal(await prisma.racePayoutDoubleOffer.count(), 0);
  });

  it("enforces the durable 100-coin rolling allowance across batches", async () => {
    const { user, token } = await createTestUser();
    const firstRace = await completedRace(user.id, {
      payoutCoins: 80,
      amount: 80,
      reason: "race_prize_pool_payout",
    });
    const firstOffer = await prepare(token, [firstRace.race.id]);
    const firstClaim = await verifyAndClaim({ userId: user.id, token, offerId: firstOffer.body.offerId });
    assert.equal(firstClaim.response.status, 200);
    assert.equal(firstClaim.body.bonusCoins, 80);
    await request(server.baseUrl, "POST", "/races/results/seen", {
      token, headers: CAPABLE, body: { raceIds: [firstRace.race.id] },
    });

    const secondRace = await completedRace(user.id, {
      payoutCoins: 100,
      amount: 100,
      reason: "race_finish_reward",
    });
    const prospective = await list(token);
    assert.equal(prospective.body.payoutDoubleOffer.baseCoins, 100);
    assert.equal(prospective.body.payoutDoubleOffer.bonusCoins, 20);
    assert.equal(prospective.body.payoutDoubleOffer.rolling24hRemainingBeforeClaim, 20);
    const secondOffer = await prepare(token, [secondRace.race.id]);
    assert.equal(secondOffer.body.bonusCoins, 20);
    const secondClaim = await verifyAndClaim({ userId: user.id, token, offerId: secondOffer.body.offerId });
    assert.equal(secondClaim.response.status, 200);
    assert.equal(secondClaim.body.coins, 100);
    await request(server.baseUrl, "POST", "/races/results/seen", {
      token, headers: CAPABLE, body: { raceIds: [secondRace.race.id] },
    });
    await completedRace(user.id, {
      payoutCoins: 10,
      amount: 10,
      reason: "race_prize_pool_payout",
    });
    const exhausted = await list(token);
    assert.equal(Object.hasOwn(exhausted.body, "payoutDoubleOffer"), false);
  });

  it("injects a pending offer's old races beyond the 10-row page only for capable clients", async () => {
    const { user, token } = await createTestUser();
    const old = await completedRace(user.id, {
      payoutCoins: 40,
      reason: "race_prize_pool_payout",
    });
    const pending = await prepare(token, [old.race.id]);
    await request(server.baseUrl, "POST", "/races/results/seen", {
      token,
      body: { raceIds: [old.race.id] },
    });
    for (let index = 0; index < 11; index += 1) {
      await completedRace(user.id, { payoutCoins: 0 });
    }
    const frozen = await list(token, {});
    assert.equal(frozen.body.completed.length, 10);
    assert.equal(frozen.body.completed.some((race) => race.id === old.race.id), false);
    assert.equal(Object.hasOwn(frozen.body, "payoutDoubleOffer"), false);

    const capable = await list(token);
    assert.equal(capable.body.payoutDoubleOffer.offerId, pending.body.offerId);
    assert.equal(capable.body.completed.some((race) => race.id === old.race.id), true);
  });

  it("claim switch blocks pending settlement but claimed replay ignores later switches", async () => {
    const { user, token } = await createTestUser();
    const race = await completedRace(user.id, { payoutCoins: 40, reason: "race_prize_pool_payout" });
    const offer = await prepare(token, [race.race.id]);
    await prisma.adRewardGrant.create({
      data: {
        userId: user.id,
        transactionId: crypto.randomUUID(),
        adUnit: ALLOWED_UNIT_SUFFIX,
        rewardKind: "race_payout_double",
        grantedDate: "2026-08-12",
        contextId: offer.body.offerId,
      },
    });
    process.env.ADS_RACE_PAYOUT_DOUBLE_CLAIM_ENABLED = "false";
    let response = await request(server.baseUrl, "POST", `/races/results/double-payout/${offer.body.offerId}/claim`, {
      token, headers: CAPABLE, body: {},
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "CLAIMS_DISABLED");
    process.env.ADS_RACE_PAYOUT_DOUBLE_CLAIM_ENABLED = "true";
    response = await request(server.baseUrl, "POST", `/races/results/double-payout/${offer.body.offerId}/claim`, {
      token, headers: CAPABLE, body: {},
    });
    assert.equal(response.status, 200);
    process.env.ADS_RACE_PAYOUT_DOUBLE_CLAIM_ENABLED = "false";
    process.env.ADMOB_RACE_PAYOUT_DOUBLE_AD_UNIT_IDS = "";
    response = await request(server.baseUrl, "POST", `/races/results/double-payout/${offer.body.offerId}/claim`, {
      token, body: {},
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).alreadyClaimed, true);
    process.env.ADS_RACE_PAYOUT_DOUBLE_CLAIM_ENABLED = "true";
    process.env.ADMOB_RACE_PAYOUT_DOUBLE_AD_UNIT_IDS = ALLOWED_UNIT;
  });

  it("account deletion tombstones receipts while retaining hashed cohort and velocity", async () => {
    const appleId = `apple-delete-${crypto.randomUUID()}`;
    const { user, token } = await createTestUser({ appleId });
    const race = await completedRace(user.id, { payoutCoins: 40, reason: "race_prize_pool_payout" });
    const offer = await prepare(token, [race.race.id]);
    const claim = await verifyAndClaim({ userId: user.id, token, offerId: offer.body.offerId });
    assert.equal(claim.response.status, 200);
    const identityBefore = await prisma.racePayoutDoubleIdentity.findFirst();
    const deleted = await request(server.baseUrl, "DELETE", "/auth/account", { token });
    assert.equal(deleted.status, 204);
    assert.equal(await prisma.racePayoutDoubleOffer.count({ where: { id: offer.body.offerId } }), 0);
    const receipt = await prisma.racePayoutDoubleClaimReceipt.findUnique({ where: { offerId: offer.body.offerId } });
    assert.ok(receipt.accountDeletedAt);
    assert.equal(await prisma.racePayoutDoubleVelocityGrant.count({ where: { offerId: offer.body.offerId } }), 1);

    const recreated = await request(server.baseUrl, "POST", "/auth/apple", {
      body: { identityToken: appleId },
    });
    assert.equal(recreated.status, 200);
    assert.equal((await prisma.racePayoutDoubleIdentity.findFirst()).cohortBucket, identityBefore.cohortBucket);
  });

  it("reconciliation uses the claimed offer as the 24h boundary anchor despite counterpart clock skew", async () => {
    const { user, token } = await createTestUser();
    const race = await completedRace(user.id, {
      payoutCoins: 40,
      reason: "race_prize_pool_payout",
    });
    const offer = await prepare(token, [race.race.id]);
    const claim = await verifyAndClaim({
      userId: user.id,
      token,
      offerId: offer.body.offerId,
    });
    assert.equal(claim.response.status, 200);

    const [settledOffer, settledReceipt, settledVelocity, settledGrant, settledLedger] =
      await Promise.all([
        prisma.racePayoutDoubleOffer.findUnique({ where: { id: offer.body.offerId } }),
        prisma.racePayoutDoubleClaimReceipt.findUnique({ where: { offerId: offer.body.offerId } }),
        prisma.racePayoutDoubleVelocityGrant.findUnique({ where: { offerId: offer.body.offerId } }),
        prisma.adRewardGrant.findFirst({ where: { contextId: offer.body.offerId } }),
        prisma.coinTransaction.findFirst({
          where: { reason: "race_payout_ad_double", refId: offer.body.offerId },
        }),
      ]);
    assert.deepEqual(
      [
        settledOffer.claimedAt,
        settledReceipt.claimedAt,
        settledVelocity.claimedAt,
        settledGrant.consumedAt,
        settledLedger.createdAt,
      ].map((value) => value.toISOString()),
      Array(5).fill(settledOffer.claimedAt.toISOString()),
    );

    const cutoff = new Date("2026-08-12T12:00:00.000Z");
    const inside = new Date(cutoff.getTime() + 1);
    const outside = new Date(cutoff.getTime() - 1);
    const now = new Date(cutoff.getTime() + 24 * 60 * 60 * 1000);
    await prisma.racePayoutDoubleOffer.update({
      where: { id: offer.body.offerId },
      data: { claimedAt: inside },
    });
    await prisma.racePayoutDoubleClaimReceipt.update({
      where: { offerId: offer.body.offerId },
      data: { claimedAt: outside },
    });
    await prisma.racePayoutDoubleVelocityGrant.update({
      where: { offerId: offer.body.offerId },
      data: { claimedAt: cutoff },
    });
    await prisma.adRewardGrant.updateMany({
      where: { contextId: offer.body.offerId },
      data: { consumedAt: outside },
    });
    await prisma.coinTransaction.updateMany({
      where: {
        reason: "race_payout_ad_double",
        refId: offer.body.offerId,
      },
      data: { createdAt: cutoff },
    });

    const result = await buildRacePayoutDoubleReconcile({
      prisma,
      now,
      JobRun: {
        async claimRun() { return true; },
        async markRan() {},
      },
      appSettings: {
        async setFlag() {
          assert.fail("an atomic claim must not stop rollout at a time boundary");
        },
      },
      logger: { info() {} },
    })();
    assert.equal(result.healthy, true);
    assert.deepEqual(result.metrics.failureCodes, []);
  });

  it("reconciliation rejects a valid-looking payout ref for the wrong immutable placement", async () => {
    const { user, token } = await createTestUser();
    const race = await completedRace(user.id, {
      payoutCoins: 40,
      placement: 1,
      reason: "race_prize_pool_payout",
    });
    const offer = await prepare(token, [race.race.id]);
    const claim = await verifyAndClaim({
      userId: user.id,
      token,
      offerId: offer.body.offerId,
    });
    assert.equal(claim.response.status, 200);
    await prisma.racePayoutDoubleOfferItem.updateMany({
      where: { offerId: offer.body.offerId },
      data: { sourceRefId: `${race.race.id}:2` },
    });

    const result = await buildRacePayoutDoubleReconcile({
      prisma,
      now: new Date(Date.now() + 10_000),
      JobRun: { async claimRun() { return true; } },
      appSettings: { async setFlag() {} },
      logger: { info() {} },
    })();
    assert.equal(result.healthy, false);
    assert.ok(result.metrics.failureCodes.includes("source_equation"));
  });

  it("reconciliation stops rollout for a self-consistent claim above the hard ceiling", async () => {
    const { user, token } = await createTestUser();
    const race = await completedRace(user.id, {
      payoutCoins: 100,
      reason: "race_prize_pool_payout",
    });
    const offer = await prepare(token, [race.race.id]);
    const claim = await verifyAndClaim({
      userId: user.id,
      token,
      offerId: offer.body.offerId,
    });
    assert.equal(claim.response.status, 200);

    const oversized = 150;
    await prisma.$transaction([
      prisma.racePayoutDoubleOffer.update({
        where: { id: offer.body.offerId },
        data: {
          bonusCoins: oversized,
          maxBonusCoins: oversized,
          rolling24hRemainingBeforeClaim: oversized,
        },
      }),
      prisma.coinTransaction.updateMany({
        where: { reason: "race_payout_ad_double", refId: offer.body.offerId },
        data: { amount: oversized },
      }),
      prisma.adRewardGrant.updateMany({
        where: { contextId: offer.body.offerId },
        data: { coinAmount: oversized },
      }),
      prisma.racePayoutDoubleVelocityGrant.update({
        where: { offerId: offer.body.offerId },
        data: { bonusCoins: oversized },
      }),
      prisma.racePayoutDoubleClaimReceipt.update({
        where: { offerId: offer.body.offerId },
        data: { bonusCoins: oversized },
      }),
    ]);

    const stops = [];
    const result = await buildRacePayoutDoubleReconcile({
      prisma,
      now: new Date(Date.now() + 10_000),
      JobRun: { async claimRun() { return true; } },
      appSettings: { async setFlag(key, value) { stops.push({ key, value }); } },
      logger: { info() {} },
    })();
    assert.equal(result.healthy, false);
    assert.ok(result.metrics.failureCodes.includes("hard_cap_equation"));
    assert.deepEqual(stops.at(-1), {
      key: "racePayoutDoubleRolloutPercent",
      value: 0,
    });
  });

  it("reconciliation stops rollout when one identity exceeds the rolling hard ceiling", async () => {
    const { user, token } = await createTestUser();
    const firstRace = await completedRace(user.id, {
      payoutCoins: 60,
      reason: "race_prize_pool_payout",
    });
    const firstOffer = await prepare(token, [firstRace.race.id]);
    assert.equal((await verifyAndClaim({
      userId: user.id,
      token,
      offerId: firstOffer.body.offerId,
    })).response.status, 200);

    const secondRace = await completedRace(user.id, {
      payoutCoins: 60,
      reason: "race_prize_pool_payout",
    });
    const secondOffer = await prepare(token, [secondRace.race.id]);
    assert.equal(secondOffer.body.bonusCoins, 40);
    assert.equal((await verifyAndClaim({
      userId: user.id,
      token,
      offerId: secondOffer.body.offerId,
    })).response.status, 200);

    // Simulate two individually valid historical rows whose combined rolling
    // issuance violates the corrected 100-coin identity ceiling.
    await prisma.$transaction([
      prisma.racePayoutDoubleOffer.update({
        where: { id: secondOffer.body.offerId },
        data: { bonusCoins: 60 },
      }),
      prisma.coinTransaction.updateMany({
        where: { reason: "race_payout_ad_double", refId: secondOffer.body.offerId },
        data: { amount: 60 },
      }),
      prisma.adRewardGrant.updateMany({
        where: { contextId: secondOffer.body.offerId },
        data: { coinAmount: 60 },
      }),
      prisma.racePayoutDoubleVelocityGrant.update({
        where: { offerId: secondOffer.body.offerId },
        data: { bonusCoins: 60 },
      }),
      prisma.racePayoutDoubleClaimReceipt.update({
        where: { offerId: secondOffer.body.offerId },
        data: { bonusCoins: 60 },
      }),
    ]);

    const result = await buildRacePayoutDoubleReconcile({
      prisma,
      now: new Date(Date.now() + 10_000),
      JobRun: { async claimRun() { return true; } },
      appSettings: { async setFlag() {} },
      logger: { info() {} },
    })();
    assert.equal(result.healthy, false);
    assert.ok(result.metrics.failureCodes.includes("rolling_cap_equation"));
  });

  it("serializes public HTTP claim against account deletion and reconciles the committed tombstone", async () => {
    const { user, token } = await createTestUser();
    const race = await completedRace(user.id, {
      payoutCoins: 40,
      reason: "race_prize_pool_payout",
    });
    const offer = await prepare(token, [race.race.id]);
    await prisma.adRewardGrant.create({
      data: {
        userId: user.id,
        transactionId: crypto.randomUUID(),
        adUnit: ALLOWED_UNIT_SUFFIX,
        rewardKind: "race_payout_double",
        grantedDate: "2026-08-12",
        contextId: offer.body.offerId,
      },
    });

    let releaseClaim;
    let claimReachedCommit;
    const reachedCommit = new Promise((resolve) => { claimReachedCommit = resolve; });
    const holdClaim = new Promise((resolve) => { releaseClaim = resolve; });
    const raceServer = await startServer({
      beforeRacePayoutDoubleCommit: async () => {
        claimReachedCommit();
        await holdClaim;
      },
    });
    try {
      const claimPromise = request(
        raceServer.baseUrl,
        "POST",
        `/races/results/double-payout/${offer.body.offerId}/claim`,
        { token, headers: CAPABLE, body: {} },
      );
      await reachedCommit;
      const deletePromise = request(raceServer.baseUrl, "DELETE", "/auth/account", { token });
      await new Promise((resolve) => setTimeout(resolve, 25));
      releaseClaim();
      const [claimResponse, deleteResponse] = await Promise.all([claimPromise, deletePromise]);
      assert.equal(claimResponse.status, 200, await claimResponse.text());
      assert.equal(deleteResponse.status, 204, await deleteResponse.text());
    } finally {
      releaseClaim?.();
      await raceServer.close();
    }

    assert.equal(await prisma.user.count({ where: { id: user.id } }), 0);
    assert.equal(await prisma.racePayoutDoubleOffer.count({ where: { id: offer.body.offerId } }), 0);
    assert.equal(await prisma.coinTransaction.count({
      where: { reason: "race_payout_ad_double", refId: offer.body.offerId },
    }), 0);
    const receipt = await prisma.racePayoutDoubleClaimReceipt.findUnique({
      where: { offerId: offer.body.offerId },
    });
    assert.ok(receipt?.accountDeletedAt);
    assert.equal(await prisma.racePayoutDoubleVelocityGrant.count({
      where: { offerId: offer.body.offerId },
    }), 1);

    const result = await buildRacePayoutDoubleReconcile({
      prisma,
      now: new Date(Date.now() + 10_000),
      JobRun: {
        async claimRun() { return true; },
        async markRan() {},
      },
      appSettings: { async setFlag() { assert.fail("valid tombstone must remain healthy"); } },
      logger: { info() {} },
    })();
    assert.equal(result.healthy, true);
  });

  it("reconciliation accepts deletion-tombstoned settlement and stops rollout for an unexplained orphan", async () => {
    const claims = [];
    const stops = [];
    const run = buildRacePayoutDoubleReconcile({
      prisma,
      now: new Date(Date.now() + 10_000),
      JobRun: {
        async claimRun() { return true; },
        async markRan(name, bucket) { claims.push({ name, bucket }); },
      },
      appSettings: { async setFlag(key, value) { stops.push({ key, value }); } },
      logger: { info() {} },
    });
    let result = await run();
    assert.equal(result.healthy, true);
    assert.equal(claims.length, 1);

    const orphanId = crypto.randomUUID();
    await prisma.racePayoutDoubleVelocityGrant.create({
      data: {
        providerSubHash: "a".repeat(64),
        offerId: orphanId,
        bonusCoins: 10,
      },
    });
    await prisma.racePayoutDoubleClaimReceipt.create({
      data: {
        providerSubHash: "a".repeat(64),
        offerId: orphanId,
        bonusCoins: 10,
        claimedAt: new Date(),
      },
    });
    result = await run();
    assert.equal(result.healthy, false);
    assert.deepEqual(stops.at(-1), { key: "racePayoutDoubleRolloutPercent", value: 0 });
    await prisma.racePayoutDoubleClaimReceipt.update({
      where: { offerId: orphanId },
      data: { accountDeletedAt: new Date() },
    });
    result = await run();
    assert.equal(result.healthy, true);
  });
});
