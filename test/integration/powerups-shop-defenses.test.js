const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// ---------------------------------------------------------------------------
// Shop-powerup defense rules (integration): the three coin-shop-only powerups
// (IMPOSTER, RAINSTORM, SIGNAL_JAMMER) can NEVER be reflected by a Mirror, but
// CAN be blocked by Compression Socks. Also covers CLEANSE as a shop item:
// buy -> redeem -> use clears an opponent-inflicted debuff.
//
// (Signal Jammer's own mirror/socks cases live in powerups-signal-jammer.test.js.)
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

// Catalog rows the seed ships (cleanDatabase cascades powerup rows via the users
// truncate, but powerup_shop_items has no user FK, so we upsert them each test).
const STORE_POWERUPS = [
  { sku: "POWERUP_IMPOSTER", name: "Imposter", powerupType: "IMPOSTER", priceCoins: 75, sortOrder: 0 },
  { sku: "POWERUP_RAINSTORM", name: "Rainstorm", powerupType: "RAINSTORM", priceCoins: 75, sortOrder: 1 },
  { sku: "POWERUP_SIGNAL_JAMMER", name: "Signal Jammer", powerupType: "SIGNAL_JAMMER", priceCoins: 75, sortOrder: 2 },
  { sku: "POWERUP_CLEANSE", name: "Cleanse", powerupType: "CLEANSE", priceCoins: 150, sortOrder: 3 },
];

const FEATURES = { "X-Client-Features": "characters,jammer" };

async function seedStoreCatalog() {
  for (const p of STORE_POWERUPS) {
    await prisma.powerupShopItem.upsert({
      where: { sku: p.sku },
      update: { priceCoins: p.priceCoins, active: true, testOnly: false },
      create: { ...p, description: `${p.name} test row`, active: true, testOnly: false },
    });
  }
}

async function createUser(displayName, coins = 0) {
  const appleId = `apple-shopdef-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  if (coins > 0) {
    await prisma.user.update({ where: { id: body.user.id }, data: { coins } });
  }
  return { userId: body.user.id, token: body.sessionToken };
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
  });
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
    body: { accept: true },
    token: b.token,
  });
}

async function createActiveRace(alice, opponents) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Shop Defense Test",
      targetSteps: 200000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: opponents.map((o) => o.userId) },
    token: alice.token,
  });
  for (const o of opponents) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });
  const start = new Date(Date.now() - 7 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps, rarity = "RARE") {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: { raceId, participantId: p.id, userId, type, rarity, status: "HELD", earnedAtSteps },
  });
}

async function giveActiveEffect(raceId, targetUserId, sourceUserId, type, powerupId, expiresAt, metadata) {
  const p = await participant(raceId, targetUserId);
  return prisma.raceActiveEffect.create({
    data: {
      raceId,
      targetParticipantId: p.id,
      targetUserId,
      sourceUserId,
      powerupId,
      type,
      status: "ACTIVE",
      startsAt: new Date(),
      expiresAt,
      metadata,
    },
  });
}

async function usePowerup(token, raceId, powerupId, body = {}) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body,
    token,
  });
}

async function purchase(token, sku, key) {
  return request(server.baseUrl, "POST", "/shop/powerups/purchase", {
    body: { sku },
    token,
    headers: { "Idempotency-Key": key, ...FEATURES },
  });
}

async function redeem(token, raceId, powerupType) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/redeem`, {
    body: { powerupType },
    token,
  });
}

describe("shop-powerup defenses — integration", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedStoreCatalog();
    nextAppleId = 0;
  });

  // ── RAINSTORM vs MIRROR ────────────────────────────────────────────────
  it("RAINSTORM is NOT reflected by a Mirror — the victim is soaked and the Mirror stays intact", async () => {
    const alice = await createUser("StormCaster1", 200);
    const bob = await createUser("StormMirror1");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    // Bob holds an active Mirror.
    const mirrorPw = await giveHeldPowerup(raceId, bob.userId, "MIRROR", 3000);
    const mirror = await giveActiveEffect(
      raceId, bob.userId, bob.userId, "MIRROR", mirrorPw.id,
      new Date(Date.now() + 60 * 60 * 1000)
    );

    await purchase(alice.token, "POWERUP_RAINSTORM", "storm-mirror-1");
    const r = await redeem(alice.token, raceId, "RAINSTORM");
    const stormId = (await r.json()).result.powerup.id;
    const res = await usePowerup(alice.token, raceId, stormId, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.affected, 1, "bob is soaked");
    assert.equal(body.result.blockedCount, 0);
    assert.equal(body.result.reflectedOntoCaster, false);

    // Bob has a RAINSTORM debuff; the caster does NOT.
    const bobP = await participant(raceId, bob.userId);
    const aliceP = await participant(raceId, alice.userId);
    const onBob = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "RAINSTORM", targetParticipantId: bobP.id, status: "ACTIVE" },
    });
    assert.ok(onBob, "victim is soaked");
    const onAlice = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "RAINSTORM", targetParticipantId: aliceP.id },
    });
    assert.equal(onAlice, null, "caster is never soaked");

    // Mirror is NOT consumed and no reflect event was written.
    const mirrorNow = await prisma.raceActiveEffect.findUnique({ where: { id: mirror.id } });
    assert.equal(mirrorNow.status, "ACTIVE", "mirror not consumed by rainstorm");
    const reflectEvents = await prisma.racePowerupEvent.findMany({
      where: { raceId, eventType: "POWERUP_REFLECTED" },
    });
    assert.equal(reflectEvents.length, 0, "no reflect event");
  });

  // ── RAINSTORM vs COMPRESSION SOCKS ─────────────────────────────────────
  it("RAINSTORM is blocked for a socked victim — no debuff, socks consumed", async () => {
    const alice = await createUser("StormCaster2", 200);
    const bob = await createUser("StormSocks2");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    const socksPw = await giveHeldPowerup(raceId, bob.userId, "COMPRESSION_SOCKS", 3000);
    const shield = await giveActiveEffect(
      raceId, bob.userId, bob.userId, "COMPRESSION_SOCKS", socksPw.id,
      new Date(Date.now() + 60 * 60 * 1000)
    );

    await purchase(alice.token, "POWERUP_RAINSTORM", "storm-socks-2");
    const r = await redeem(alice.token, raceId, "RAINSTORM");
    const stormId = (await r.json()).result.powerup.id;
    const res = await usePowerup(alice.token, raceId, stormId, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.affected, 0, "socked victim not soaked");
    assert.equal(body.result.blockedCount, 1);

    const bobP = await participant(raceId, bob.userId);
    const onBob = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "RAINSTORM", targetParticipantId: bobP.id },
    });
    assert.equal(onBob, null, "no rainstorm debuff on shielded victim");
    const shieldNow = await prisma.raceActiveEffect.findUnique({ where: { id: shield.id } });
    assert.equal(shieldNow.status, "BLOCKED", "socks consumed");
    const blocked = await prisma.racePowerupEvent.findFirst({
      where: { raceId, eventType: "POWERUP_BLOCKED", powerupType: "RAINSTORM" },
    });
    assert.ok(blocked, "writes POWERUP_BLOCKED");
  });

  // ── IMPOSTER vs COMPRESSION SOCKS ──────────────────────────────────────
  it("IMPOSTER is blocked by the target's Compression Socks — no swap, socks consumed", async () => {
    const alice = await createUser("ImpAttacker1", 200);
    const bob = await createUser("ImpSocks1");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    const socksPw = await giveHeldPowerup(raceId, bob.userId, "COMPRESSION_SOCKS", 3000);
    const shield = await giveActiveEffect(
      raceId, bob.userId, bob.userId, "COMPRESSION_SOCKS", socksPw.id,
      new Date(Date.now() + 60 * 60 * 1000)
    );

    await purchase(alice.token, "POWERUP_IMPOSTER", "imp-socks-1");
    const r = await redeem(alice.token, raceId, "IMPOSTER");
    const impId = (await r.json()).result.powerup.id;
    const res = await usePowerup(alice.token, raceId, impId, { targetUserId: bob.userId });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.blocked, true);
    assert.equal(body.result.blockedBy, "COMPRESSION_SOCKS");

    // No IMPOSTER effect created; socks consumed; imposter powerup USED.
    const impEffect = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "IMPOSTER" },
    });
    assert.equal(impEffect, null, "no display-swap effect created");
    const shieldNow = await prisma.raceActiveEffect.findUnique({ where: { id: shield.id } });
    assert.equal(shieldNow.status, "BLOCKED", "socks consumed");
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: impId } })).status, "USED");
    const blocked = await prisma.racePowerupEvent.findFirst({
      where: { raceId, eventType: "POWERUP_BLOCKED", powerupType: "IMPOSTER" },
    });
    assert.ok(blocked, "writes POWERUP_BLOCKED");
  });

  // ── IMPOSTER vs MIRROR ─────────────────────────────────────────────────
  it("IMPOSTER is NOT reflected by a Mirror — the swap applies and the Mirror stays intact", async () => {
    const alice = await createUser("ImpAttacker2", 200);
    const bob = await createUser("ImpMirror2");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    const mirrorPw = await giveHeldPowerup(raceId, bob.userId, "MIRROR", 3000);
    const mirror = await giveActiveEffect(
      raceId, bob.userId, bob.userId, "MIRROR", mirrorPw.id,
      new Date(Date.now() + 60 * 60 * 1000)
    );

    await purchase(alice.token, "POWERUP_IMPOSTER", "imp-mirror-2");
    const r = await redeem(alice.token, raceId, "IMPOSTER");
    const impId = (await r.json()).result.powerup.id;
    const res = await usePowerup(alice.token, raceId, impId, { targetUserId: bob.userId });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.notEqual(body.result.blocked, true);
    assert.notEqual(body.result.reflected, true);

    // Self-applied IMPOSTER effect on the caster records the swap target.
    const aliceP = await participant(raceId, alice.userId);
    const impEffect = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "IMPOSTER", targetParticipantId: aliceP.id, status: "ACTIVE" },
    });
    assert.ok(impEffect, "imposter effect applied on caster");
    assert.equal(impEffect.metadata.swapWithUserId, bob.userId);
    // Mirror is NOT consumed.
    const mirrorNow = await prisma.raceActiveEffect.findUnique({ where: { id: mirror.id } });
    assert.equal(mirrorNow.status, "ACTIVE", "mirror not consumed by imposter");
  });

  // ── CLEANSE as a shop item: buy -> redeem -> use ───────────────────────
  it("a shop-purchased CLEANSE can be redeemed to a race and used to clear an opponent debuff", async () => {
    const alice = await createUser("Cleanser", 300);
    const bob = await createUser("Debuffer");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    // Bob has inflicted an opponent debuff (LEG_CRAMP) on Alice.
    const crampPw = await giveHeldPowerup(raceId, bob.userId, "LEG_CRAMP", 4000, "UNCOMMON");
    const cramp = await giveActiveEffect(
      raceId, alice.userId, bob.userId, "LEG_CRAMP", crampPw.id,
      new Date(Date.now() + 60 * 60 * 1000),
      { stepsAtFreezeStart: 0 }
    );

    // Alice buys Cleanse (150 coins), redeems it, and uses it.
    const buy = await purchase(alice.token, "POWERUP_CLEANSE", "cleanse-buy-1");
    assert.equal(buy.status, 200);
    assert.equal((await buy.json()).coins, 150, "300 - 150 cleanse price");

    const r = await redeem(alice.token, raceId, "CLEANSE");
    assert.equal(r.status, 200);
    const cleanseId = (await r.json()).result.powerup.id;

    const res = await usePowerup(alice.token, raceId, cleanseId, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.cleared, 1, "cleared the one opponent debuff");

    // The leg cramp is ended; the cleanse powerup is consumed.
    const crampNow = await prisma.raceActiveEffect.findUnique({ where: { id: cramp.id } });
    assert.equal(crampNow.status, "EXPIRED", "opponent debuff cleared");
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: cleanseId } })).status, "USED");
  });
});
