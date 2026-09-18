const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");
const { cleanDatabase, prisma, request, startServer } = require("./setup");

let server;
let nextAppleId = 0;

const POWERUPS5 = {
  "X-Client-Features": "characters,powerups5",
};
async function createUser(displayName, headers = POWERUPS5) {
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: `apple-decoy-${++nextAppleId}` },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
    headers,
  });
  return { userId: body.user.id, token: body.sessionToken };
}

async function makeFriends(a, b, headers = POWERUPS5) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
    headers,
  });
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
    body: { accept: true },
    token: b.token,
    headers,
  });
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function createSoloRace(users) {
  const [creator, ...opponents] = users;
  for (const opponent of opponents) await makeFriends(creator, opponent);
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Decoy Solo",
      isPublic: true,
      targetSteps: 200000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: creator.token,
    headers: POWERUPS5,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: opponents.map((user) => user.userId) },
    token: creator.token,
    headers: POWERUPS5,
  });
  for (const opponent of opponents) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: opponent.token,
      headers: POWERUPS5,
    });
  }
  const startRes = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: creator.token,
    headers: POWERUPS5,
  });
  assert.equal(startRes.status, 200);
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function usePowerup(user, raceId, powerupId, body = {}, headers = POWERUPS5) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body,
    token: user.token,
    headers,
  });
}

const HOUR = 3600000;
const COOLDOWN_ERROR = {
  error: "Wait 1 hour after your Decoy pops before using another in this race",
  code: "DECOY_COOLDOWN",
};
async function seedCatalog() {
  await prisma.powerupShopItem.upsert({
    where: { sku: "POWERUP_DECOY" },
    update: { active: true, testOnly: false, priceCoins: 150, dailyRewardEligible: false },
    create: { sku: "POWERUP_DECOY", name: "Decoy", description: "Decoy", powerupType: "DECOY", active: true, testOnly: false, priceCoins: 150, dailyRewardEligible: false },
  });
}
async function qty(userId) {
  return (await prisma.userPowerupItem.findUnique({ where: { userId_powerupType: { userId, powerupType: "DECOY" } } }))?.quantity || 0;
}
async function assertCooldown(owner, raceId, item, headers = POWERUPS5) {
  const response = await usePowerup(owner, raceId, item.id, {}, headers);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), COOLDOWN_ERROR);
  assert.equal((await prisma.racePowerup.findUnique({ where: { id: item.id } })).status, "HELD");
}
async function poppedFixture(attackType = "SIGNAL_JAMMER", redirect = false) {
  const owner = await createUser("PopOwner");
  const attacker = await createUser("PopAttacker");
  const others = redirect ? [await createUser("PopDestination")] : [];
  const raceId = await createSoloRace([owner, attacker, ...others]);
  const decoy = await giveHeldPowerup(raceId, owner.userId, "DECOY", 1000);
  assert.equal((await usePowerup(owner, raceId, decoy.id)).status, 200);
  const attack = await giveHeldPowerup(raceId, attacker.userId, attackType, 2000);
  const response = await usePowerup(attacker, raceId, attack.id,
    attackType === "SIGNAL_JAMMER" ? { targetUserId: owner.userId } : {});
  assert.equal(response.status, 200);
  const result = (await response.json()).result;
  assert.equal(redirect ? result.redirectedBy : (result.blockedBy || (result.decoyBlockedCount === 1 ? "DECOY" : null)), "DECOY");
  return { owner, attacker, raceId, decoy };
}
describe("Decoy shop restoration and post-pop cooldown — HTTP integration", () => {
  before(async () => {
    server = await startServer({
      verifyAppleIdentityToken: async (token) => ({ sub: token, email: `${token}@example.com` }),
      // Only Google's network signature verification is stubbed. The public
      // SSV handler and grant transaction are real, as are unlock and purchase.
      verifySsv: async () => true,
      feedbackTransport: { async send() { return { accepted: [], rejected: [] }; } },
    });
  });
  after(async () => server.close());
  beforeEach(async () => { await cleanDatabase(); nextAppleId = 0; await seedCatalog(); });

  it("lists Decoy at150, purchases once, and keeps unsupported legacy clients gated", async () => {
    const owner = await createUser("ShopOwner");
    await prisma.user.update({ where: { id: owner.userId }, data: { coins: 300 } });
    const catalog = await request(server.baseUrl, "GET", "/shop/powerups", { token: owner.token, headers: POWERUPS5 });
    assert.equal(catalog.status, 200);
    const item = (await catalog.json()).items.find((row) => row.powerupType === "DECOY");
    assert.ok(item);
    assert.equal(item.priceCoins, 150);
    const purchase = () => request(server.baseUrl, "POST", "/shop/powerups/purchase", { token: owner.token, headers: { ...POWERUPS5, "Idempotency-Key": "decoy-restored" }, body: { sku: item.sku, expectedPriceCoins: 150 } });
    const bought = await purchase();
    assert.equal(bought.status, 200);
    assert.equal((await bought.json()).inventory.quantity, 1);
    assert.equal((await purchase()).status, 200);
    assert.equal(await qty(owner.userId), 1);
    assert.equal((await prisma.user.findUnique({ where: { id: owner.userId } })).coins, 150);
    const oldHeaders = { "X-Client-Features": "characters,powerups2" };
    const legacy = await request(server.baseUrl, "GET", "/shop/powerups", { token: owner.token, headers: oldHeaders });
    assert.equal(legacy.status, 200);
    assert.equal((await legacy.json()).items.some((row) => row.powerupType === "DECOY"), false);
    const denied = await request(server.baseUrl, "POST", "/shop/powerups/purchase", { token: owner.token, headers: { ...oldHeaders, "Idempotency-Key": "legacy-decoy" }, body: { sku: item.sku } });
    assert.equal(denied.status, 404);
    assert.deepEqual(await denied.json(), { error: "Powerup not found" });
  });

  it("preserves the existing 15 percent membership discount:150 base costs128", async () => {
    const owner = await createUser("MemberOwner");
    await prisma.user.update({ where: { id: owner.userId }, data: { coins: 300 } });
    const identity = await prisma.billingIdentity.create({ data: { userId: owner.userId } });
    await prisma.billingSubscription.create({ data: {
      id: "decoy-member-sub", identityId: identity.id, productId: "plus_monthly",
      startsAt: new Date(), accessUntil: new Date(Date.now() + 86400000),
      givesAccess: true, observedAt: new Date(),
    } });
    const catalog = await request(server.baseUrl, "GET", "/shop/powerups", { token: owner.token, headers: POWERUPS5 });
    assert.equal(catalog.status, 200);
    const item = (await catalog.json()).items.find((row) => row.powerupType === "DECOY");
    assert.equal(item.basePriceCoins, 150);
    assert.equal(item.discountPercent, 15);
    assert.equal(item.priceCoins, 128);
    const bought = await request(server.baseUrl, "POST", "/shop/powerups/purchase", {
      token: owner.token, headers: { ...POWERUPS5, "Idempotency-Key": "member-decoy" },
      body: { powerupType: "DECOY", expectedPriceCoins: 128 },
    });
    assert.equal(bought.status, 200);
    assert.equal((await prisma.user.findUnique({ where: { id: owner.userId } })).coins, 172);
    assert.equal(await qty(owner.userId), 1);
  });

  it("accepts a new verified Decoy ad callback through HTTP and unlocks idempotently", async () => {
    const owner = await createUser("AdOwner");
    await prisma.user.update({ where: { id: owner.userId }, data: { coins: 140 } });
    const query = new URLSearchParams({ transaction_id: "new-decoy-watch", user_id: owner.userId, custom_data: `powerup_unlock:${owner.userId}:POWERUP_DECOY` });
    const callback = await request(server.baseUrl, "GET", `/ads/ssv?${query}`);
    assert.equal(callback.status, 200);
    const unlock = () => request(server.baseUrl, "POST", "/shop/powerups/unlock-with-ads", { token: owner.token, headers: { ...POWERUPS5, "Idempotency-Key": "decoy-new-ad" }, body: { sku: "POWERUP_DECOY" } });
    const response = await unlock();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).inventory.quantity, 1);
    assert.equal((await unlock()).status, 200);
    assert.equal(await qty(owner.userId), 1);
    assert.equal((await prisma.user.findUnique({ where: { id: owner.userId } })).coins, 0);
  });

  for (const type of ["SIGNAL_JAMMER", "RAINSTORM", "POWER_OUTAGE"]) {
    for (const redirect of [false, true]) {
      it(`${type} ${redirect ? "redirect" : "absorb"} starts cooldown and retains concurrent held attempts`, async () => {
        const { owner, raceId, decoy } = await poppedFixture(type, redirect);
        const effects = await prisma.raceActiveEffect.findMany({ where: { powerupId: decoy.id } });
        assert.equal(effects[0].status, "EXPIRED");
        assert.ok(effects[0].decoyConsumedAt instanceof Date);
        const next = await giveHeldPowerup(raceId, owner.userId, "DECOY", 3000);
        const other = await giveHeldPowerup(raceId, owner.userId, "DECOY", 4000);
        await Promise.all([assertCooldown(owner, raceId, next), assertCooldown(owner, raceId, other)]);
      });
    }
  }

  it("refunds a redeemed inventory item after cooldown rejection, preserving coins and legacy error envelope", async () => {
    const { owner, raceId } = await poppedFixture();
    await prisma.userPowerupItem.create({ data: { userId: owner.userId, powerupType: "DECOY", quantity: 1 } });
    const beforeCoins = (await prisma.user.findUnique({ where: { id: owner.userId } })).coins;
    const redeemed = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/redeem`, { token: owner.token, headers: POWERUPS5, body: { powerupType: "DECOY" } });
    assert.equal(redeemed.status, 200);
    const id = (await redeemed.json()).result.powerup.id;
    assert.equal(await qty(owner.userId), 0);
    const denied = await usePowerup(owner, raceId, id, {}, { "X-Client-Features": "characters,powerups5" });
    assert.equal(denied.status, 409);
    assert.deepEqual(await denied.json(), COOLDOWN_ERROR);
    assert.equal(await qty(owner.userId), 1);
    assert.equal((await prisma.user.findUnique({ where: { id: owner.userId } })).coins, beforeCoins);
  });

  it("allows exactly one hour after pop but rejects one millisecond before", async (t) => {
    const { owner, raceId, decoy } = await poppedFixture();
    const effect = await prisma.raceActiveEffect.findFirst({ where: { powerupId: decoy.id } });
    const fixedNow = Date.now();
    const next = await giveHeldPowerup(raceId, owner.userId, "DECOY", 3000);
    t.mock.timers.enable({ apis: ["Date"], now: fixedNow });
    await prisma.raceActiveEffect.update({ where: { id: effect.id }, data: { decoyConsumedAt: new Date(fixedNow - HOUR + 1) } });
    await assertCooldown(owner, raceId, next);
    t.mock.timers.setTime(fixedNow + 1);
    assert.equal((await usePowerup(owner, raceId, next.id)).status, 200);
  });

  it("does not start cooldown at activation or natural expiration", async () => {
    const owner = await createUser("NaturalOwner");
    const attacker = await createUser("NaturalRival");
    const raceId = await createSoloRace([owner, attacker]);
    const first = await giveHeldPowerup(raceId, owner.userId, "DECOY", 1000);
    assert.equal((await usePowerup(owner, raceId, first.id)).status, 200);
    const effect = await prisma.raceActiveEffect.findFirst({ where: { powerupId: first.id } });
    assert.equal(effect.decoyConsumedAt, null);
    const next = await giveHeldPowerup(raceId, owner.userId, "DECOY", 3000);
    const activeDenied = await usePowerup(owner, raceId, next.id);
    assert.equal(activeDenied.status, 409);
    assert.equal((await activeDenied.json()).code, "DECOY_ACTIVE");
    await prisma.raceActiveEffect.update({ where: { id: effect.id }, data: { expiresAt: new Date(Date.now() - 1), status: "EXPIRED" } });
    assert.equal((await usePowerup(owner, raceId, next.id)).status, 200);
  });

  it("scopes cooldown to the owning participant in one race", async () => {
    const { owner, attacker, raceId } = await poppedFixture();
    const rivalsDecoy = await giveHeldPowerup(raceId, attacker.userId, "DECOY", 3000);
    assert.equal((await usePowerup(attacker, raceId, rivalsDecoy.id)).status, 200);
    const anotherOpponent = await createUser("OtherRaceRival");
    const otherRace = await createSoloRace([owner, anotherOpponent]);
    const otherDecoy = await giveHeldPowerup(otherRace, owner.userId, "DECOY", 1000);
    assert.equal((await usePowerup(owner, otherRace, otherDecoy.id)).status, 200);
  });
});
