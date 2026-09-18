process.env.ADMOB_SSV_SKIP_VERIFY = "true";
process.env.ADS_BOX_REROLL_ENABLED = "true";
process.env.ADS_RACE_PAYOUT_DOUBLE_PREPARE_ENABLED = "true";
process.env.ADS_RACE_PAYOUT_DOUBLE_CLAIM_ENABLED = "true";
process.env.ADMOB_RACE_PAYOUT_DOUBLE_AD_UNIT_IDS = "ca-app-pub-3940256099942544/5224354917";
process.env.RACE_PAYOUT_DOUBLE_MAX_BONUS_COINS = "500";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { before, after, beforeEach, describe, it } = require("node:test");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const { grantAdReward } = require("../../src/modules/economy/commands/grantAdReward");

let server;
const today = () => new Date().toISOString().slice(0, 10);
const FEATURES = { "X-Client-Features": "ads,characters,powerups2,powerups3,powerups4,powerups5,race_payout_double,bara_gold_v1" };

async function goldMember(userId) {
  const identity = await prisma.billingIdentity.create({ data: { userId } });
  await prisma.billingSubscription.create({
    data: {
      id: crypto.randomUUID(),
      identityId: identity.id,
      productId: "plus_monthly",
      startsAt: new Date(Date.now() - 60_000),
      periodStartsAt: new Date(Date.now() - 60_000),
      accessUntil: new Date(Date.now() + 86400000),
      givesAccess: true,
      trial: false,
      renews: true,
      providerStatus: "active",
      benefitContract: "bara_gold_v1",
      observedAt: new Date(),
    },
  });
}

async function seedCoinGrant(userId, index, amount = null) {
  return prisma.adRewardGrant.create({
    data: {
      userId,
      transactionId: `gold-coins-${userId}-${index}-${crypto.randomUUID()}`,
      rewardKind: "coin_reward",
      grantedDate: today(),
      ...(amount == null ? {} : { coinAmount: amount }),
    },
  });
}

async function seedRacePowerup(userId, { rerolledAt = null } = {}) {
  const race = await prisma.race.create({
    data: {
      creatorId: userId,
      name: `Gold rewarded ${crypto.randomUUID()}`,
      targetSteps: 1000,
      status: "ACTIVE",
      startedAt: new Date(Date.now() - 3600000),
      maxDurationDays: 1,
    },
  });
  const participant = await prisma.raceParticipant.create({
    data: { raceId: race.id, userId, status: "ACCEPTED" },
  });
  const powerup = await prisma.racePowerup.create({
    data: {
      raceId: race.id,
      participantId: participant.id,
      userId,
      type: "PROTEIN_SHAKE",
      rarity: "COMMON",
      status: "HELD",
      rerolledAt,
    },
  });
  return { race, participant, powerup };
}

async function addRacePowerup(race, participant, userId, { rerolledAt = null } = {}) {
  const powerup = await prisma.racePowerup.create({
    data: {
      raceId: race.id,
      participantId: participant.id,
      userId,
      type: "PROTEIN_SHAKE",
      rarity: "COMMON",
      status: "HELD",
      rerolledAt,
    },
  });
  return { race, participant, powerup };
}

async function completedRace(userId) {
  const race = await prisma.race.create({
    data: {
      creatorId: userId,
      name: `Gold payout ${crypto.randomUUID()}`,
      targetSteps: 1000,
      status: "COMPLETED",
      completedAt: new Date(),
    },
  });
  const participant = await prisma.raceParticipant.create({
    data: { raceId: race.id, userId, status: "ACCEPTED", payoutCoins: 40, placement: 1 },
  });
  await prisma.coinTransaction.create({
    data: { userId, amount: 40, reason: "race_prize_pool_payout", refId: `${race.id}:1` },
  });
  return { race, participant };
}

async function claimCoins(token) {
  return claimCoinsOnDate(token, today());
}

async function claimCoinsOnDate(token, localDate) {
  const response = await request(server.baseUrl, "POST", "/coins/claim-ad-reward", {
    token,
    headers: FEATURES,
    body: { localDate },
  });
  return { status: response.status, body: await response.json() };
}

describe("Bara Gold rewarded-ad policy", { concurrency: false }, () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); });
  after(() => {
    delete process.env.ADMOB_SSV_SKIP_VERIFY;
    delete process.env.ADS_BOX_REROLL_ENABLED;
    delete process.env.ADS_RACE_PAYOUT_DOUBLE_PREPARE_ENABLED;
    delete process.env.ADS_RACE_PAYOUT_DOUBLE_CLAIM_ENABLED;
    delete process.env.ADMOB_RACE_PAYOUT_DOUBLE_AD_UNIT_IDS;
    delete process.env.RACE_PAYOUT_DOUBLE_MAX_BONUS_COINS;
  });

  it("extraSpin bypasses the ad for Gold, preserves the daily cap, and replays idempotently", async () => {
    const gold = await createTestUser();
    await goldMember(gold.user.id);
    await prisma.user.update({ where: { id: gold.user.id }, data: { lastDailyClaimDate: today(), dailyLoginStreak: 1 } });
    const first = await request(server.baseUrl, "POST", "/daily-reward/claim-extra-box", { token: gold.token, headers: FEATURES, body: { localDate: today() } });
    assert.equal(first.status, 200);
    const result = await first.json();
    assert.equal(result.bypassedByGold, true);
    assert.equal(await prisma.adRewardGrant.count({ where: { userId: gold.user.id } }), 0);
    assert.equal(await prisma.goldActionClaim.count({ where: { userId: gold.user.id, action: "extra_daily_spin" } }), 1);
    const replay = await request(server.baseUrl, "POST", "/daily-reward/claim-extra-box", { token: gold.token, headers: FEATURES, body: { localDate: today() } });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).idempotent, true);
  });

  it("getCoins remains ad-based for Gold and enforces SSV, server reward, date, and cap", async () => {
    const gold = await createTestUser();
    await goldMember(gold.user.id);
    const missing = await claimCoins(gold.token);
    assert.equal(missing.status, 409);
    assert.equal(missing.body.code, "AD_NOT_VERIFIED");
    const wrongDate = await claimCoinsOnDate(
      gold.token,
      new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
    );
    assert.equal(wrongDate.status, 400);

    const firstGrant = await seedCoinGrant(gold.user.id, 0, 37);
    const duplicate = await grantAdReward({ userId: gold.user.id, transactionId: firstGrant.transactionId, customData: `coins:${today()}`, serverDate: today() });
    assert.equal(duplicate.granted, false);
    for (let i = 1; i < 5; i++) await seedCoinGrant(gold.user.id, i, 25 + i);
    await seedCoinGrant(gold.user.id, 5, 50);
    const amounts = [];
    for (let i = 0; i < 5; i++) {
      const claim = await claimCoins(gold.token);
      assert.equal(claim.status, 200);
      amounts.push(claim.body.coinAmount);
    }
    assert.deepEqual(amounts, [37, 26, 27, 28, 29]);
    const capped = await claimCoins(gold.token);
    assert.equal(capped.status, 409);
    assert.equal(capped.body.code, "DAILY_CAP_REACHED");
    assert.equal(await prisma.coinTransaction.count({ where: { userId: gold.user.id, reason: "ad_coin_reward" } }), 5);

    const other = await createTestUser();
    const otherGrant = await seedCoinGrant(other.user.id, 0, 31);
    const otherClaim = await claimCoins(other.token);
    assert.equal(otherClaim.status, 200);
    assert.equal(otherClaim.body.coinAmount, 31);
    assert.notEqual(otherGrant.userId, gold.user.id);
    assert.equal((await claimCoins(gold.token)).body.code, "DAILY_CAP_REACHED");
  });

  it("powerupUnlock bypasses ads for Gold but preserves eligibility and idempotency", async () => {
    const gold = await createTestUser({ coins: 0 });
    await goldMember(gold.user.id);
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_GOLD_TEST" }, update: { name: "Gold Test", description: "", powerupType: "CLEANSE", priceCoins: 15, active: true, testOnly: false }, create: { sku: "POWERUP_GOLD_TEST", name: "Gold Test", description: "", powerupType: "CLEANSE", priceCoins: 15, active: true, testOnly: false } });
    const key = crypto.randomUUID();
    const unlock = await request(server.baseUrl, "POST", "/shop/powerups/unlock-with-ads", { token: gold.token, headers: { ...FEATURES, "Idempotency-Key": key }, body: { sku: "POWERUP_GOLD_TEST", idempotencyKey: key, localDate: today() } });
    assert.equal(unlock.status, 200);
    assert.equal((await unlock.json()).adsWatched, 0);
    assert.equal(await prisma.adRewardGrant.count({ where: { userId: gold.user.id } }), 0);
    assert.equal(await prisma.userPowerupItem.count({ where: { userId: gold.user.id, powerupType: "CLEANSE" } }), 1);
    const replay = await request(server.baseUrl, "POST", "/shop/powerups/unlock-with-ads", { token: gold.token, headers: { ...FEATURES, "Idempotency-Key": key }, body: { sku: "POWERUP_GOLD_TEST", idempotencyKey: key, localDate: today() } });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).idempotent, true);
    assert.equal((await prisma.userPowerupItem.findUnique({ where: { userId_powerupType: { userId: gold.user.id, powerupType: "CLEANSE" } } })).quantity, 1);
  });

  it("cosmeticUnlock bypasses ads for Gold and remains idempotent", async () => {
    const gold = await createTestUser({ coins: 0 });
    await goldMember(gold.user.id);
    const item = await prisma.shopItem.create({ data: { sku: "gold_rewarded_hat", name: "Gold Test Hat", slot: "HEAD", assetKey: "straw_hat", priceCoins: 15 } });
    const key = crypto.randomUUID();
    const unlock = await request(server.baseUrl, "POST", "/shop/unlock-with-ads", { token: gold.token, headers: { ...FEATURES, "Idempotency-Key": key }, body: { sku: item.sku, idempotencyKey: key, localDate: today() } });
    assert.equal(unlock.status, 200);
    assert.equal((await unlock.json()).adsWatched, 0);
    assert.equal(await prisma.adRewardGrant.count({ where: { userId: gold.user.id } }), 0);
    assert.equal(await prisma.userShopItem.count({ where: { userId: gold.user.id, shopItemId: item.id } }), 1);
    const replay = await request(server.baseUrl, "POST", "/shop/unlock-with-ads", { token: gold.token, headers: { ...FEATURES, "Idempotency-Key": key }, body: { sku: item.sku, idempotencyKey: key, localDate: today() } });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).idempotent, true);
  });

  it("single and batch boxReroll are free for Gold and retain the one-reroll fence", async () => {
    const gold = await createTestUser();
    await goldMember(gold.user.id);
    const single = await seedRacePowerup(gold.user.id);
    const singleResponse = await request(server.baseUrl, "POST", `/races/${single.race.id}/powerups/${single.powerup.id}/reroll`, { token: gold.token, headers: FEATURES, body: { localDate: today() } });
    assert.equal(singleResponse.status, 200);
    assert.equal((await singleResponse.json()).funding, "FREE_GOLD");
    const second = await request(server.baseUrl, "POST", `/races/${single.race.id}/powerups/${single.powerup.id}/reroll`, { token: gold.token, headers: FEATURES, body: { localDate: today() } });
    assert.equal(second.status, 409);
    assert.equal((await second.json()).code, "ALREADY_REROLLED");

    const batch = await seedRacePowerup(gold.user.id);
    const batch2 = await addRacePowerup(batch.race, batch.participant, gold.user.id);
    const key = crypto.randomUUID();
    const batchResponse = await request(server.baseUrl, "POST", `/races/${batch.race.id}/powerups/reroll-batch`, { token: gold.token, headers: { ...FEATURES, "Idempotency-Key": key }, body: { powerupIds: [batch.powerup.id, batch2.powerup.id], localDate: today() } });
    assert.equal(batchResponse.status, 200);
    const batchBody = await batchResponse.json();
    assert.ok(batchBody.results.every((row) => row.rerolled));
    assert.equal(batchBody.rerolledCount, 2);
    assert.equal(await prisma.adRewardGrant.count({ where: { userId: gold.user.id } }), 0);
    const replay = await request(server.baseUrl, "POST", `/races/${batch.race.id}/powerups/reroll-batch`, { token: gold.token, headers: { ...FEATURES, "Idempotency-Key": key }, body: { powerupIds: [batch.powerup.id, batch2.powerup.id], localDate: today() } });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), batchBody);
  });

  it("racePayoutDouble bypasses the ad for Gold and cannot be claimed twice", async () => {
    const gold = await createTestUser({ coins: 0 });
    await goldMember(gold.user.id);
    const settled = await completedRace(gold.user.id);
    const offer = await request(server.baseUrl, "POST", "/races/results/double-payout/offer", { token: gold.token, headers: FEATURES, body: { raceIds: [settled.race.id] } });
    assert.equal(offer.status, 201);
    const offerBody = await offer.json();
    const claim = await request(server.baseUrl, "POST", `/races/results/double-payout/${offerBody.offerId}/claim`, { token: gold.token, headers: FEATURES, body: {} });
    assert.equal(claim.status, 200);
    assert.equal((await claim.json()).awarded, true);
    assert.equal(await prisma.adRewardGrant.count({ where: { userId: gold.user.id } }), 0);
    assert.equal(await prisma.coinTransaction.count({ where: { userId: gold.user.id, reason: "race_payout_ad_double" } }), 1);
    const replay = await request(server.baseUrl, "POST", `/races/results/double-payout/${offerBody.offerId}/claim`, { token: gold.token, headers: FEATURES, body: {} });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).alreadyClaimed, true);
  });
});
