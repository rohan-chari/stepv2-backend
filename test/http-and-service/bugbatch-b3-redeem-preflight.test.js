const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// ---------------------------------------------------------------------------
// B3 — redeem pre-flight. A rejected cast must not spend global inventory into
// a race it can't be used in (there is no un-redeem). The redeem endpoint runs
// the cheap doom pre-checks BEFORE decrementing inventory:
//   * caster jammed        -> 409 SIGNAL_JAMMED
//   * own rainstorm active -> 409 RAINSTORM_ACTIVE (per-caster, matches B4)
//   * no eligible targets  -> 400 NO_ELIGIBLE_TARGETS
// On rejection, inventory is unchanged and no HELD race_powerups row is minted.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

const STORE_POWERUPS = [
  { sku: "POWERUP_RED_CARD", name: "Red Card", powerupType: "RED_CARD", priceCoins: 75, sortOrder: 0 },
  { sku: "POWERUP_RAINSTORM", name: "Rainstorm", powerupType: "RAINSTORM", priceCoins: 75, sortOrder: 1 },
  { sku: "POWERUP_SIGNAL_JAMMER", name: "Signal Jammer", powerupType: "SIGNAL_JAMMER", priceCoins: 75, sortOrder: 2 },
];

async function seedStoreCatalog() {
  for (const p of STORE_POWERUPS) {
    await prisma.powerupShopItem.upsert({
      where: { sku: p.sku },
      update: { priceCoins: p.priceCoins, active: true },
      create: { ...p, description: `${p.name} test row`, active: true },
    });
  }
}

async function createUser(displayName, coins = 500) {
  const appleId = `apple-b3-${++nextAppleId}`;
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
  const fId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${fId}`, {
    body: { accept: true },
    token: b.token,
  });
}

async function createActiveRace(alice, opponents) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "B3 Redeem Preflight",
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
  const start = new Date(Date.now() - 3 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

async function purchase(token, sku, key) {
  return request(server.baseUrl, "POST", "/shop/powerups/purchase", {
    body: { sku },
    token,
    headers: { "Idempotency-Key": key },
  });
}

async function redeem(token, raceId, powerupType) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/redeem`, {
    body: { powerupType },
    token,
  });
}

async function usePowerup(token, raceId, powerupId, body = {}) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body,
    token,
  });
}

async function inventoryQty(userId, powerupType) {
  const inv = await prisma.userPowerupItem.findUnique({
    where: { userId_powerupType: { userId, powerupType } },
  });
  return inv ? inv.quantity : 0;
}

async function heldRows(raceId, userId, type) {
  return prisma.racePowerup.findMany({
    where: { raceId, userId, type, status: "HELD" },
  });
}

describe("B3 — redeem pre-flight rejections do not strand inventory", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("happy path: a valid redeem still works", async () => {
    await seedStoreCatalog();
    const alice = await createUser("AliceB3ok");
    const bob = await createUser("BobB3ok");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    await purchase(alice.token, "POWERUP_RAINSTORM", "b3-ok-1");
    const res = await redeem(alice.token, raceId, "RAINSTORM");
    assert.equal(res.status, 200);
    assert.equal(await inventoryQty(alice.userId, "RAINSTORM"), 0);
    assert.equal((await heldRows(raceId, alice.userId, "RAINSTORM")).length, 1);
  });

  it("redeeming a RAINSTORM while your own storm is active → 409 RAINSTORM_ACTIVE, no inventory spent", async () => {
    await seedStoreCatalog();
    const alice = await createUser("AliceB3storm");
    const bob = await createUser("BobB3storm");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    await purchase(alice.token, "POWERUP_RAINSTORM", "b3-storm-a");
    await purchase(alice.token, "POWERUP_RAINSTORM", "b3-storm-b");
    assert.equal(await inventoryQty(alice.userId, "RAINSTORM"), 2);

    // Cast the first storm.
    const r1 = await redeem(alice.token, raceId, "RAINSTORM");
    assert.equal(r1.status, 200);
    const stormId = (await r1.json()).result.powerup.id;
    assert.equal((await usePowerup(alice.token, raceId, stormId)).status, 200);
    assert.equal(await inventoryQty(alice.userId, "RAINSTORM"), 1);

    // Attempt to redeem the second — must be rejected BEFORE spending it.
    const heldBefore = (await heldRows(raceId, alice.userId, "RAINSTORM")).length;
    const r2 = await redeem(alice.token, raceId, "RAINSTORM");
    assert.equal(r2.status, 409);
    const body = await r2.json();
    assert.equal(body.code, "RAINSTORM_ACTIVE");
    assert.match(body.error, /already active/i);

    assert.equal(await inventoryQty(alice.userId, "RAINSTORM"), 1, "inventory not spent");
    assert.equal(
      (await heldRows(raceId, alice.userId, "RAINSTORM")).length,
      heldBefore,
      "no new HELD rainstorm minted"
    );
  });

  it("redeeming while jammed → 409 SIGNAL_JAMMED, no inventory spent", async () => {
    await seedStoreCatalog();
    const alice = await createUser("AliceB3jam");
    const bob = await createUser("BobB3jam");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    // Bob jams Alice.
    await purchase(bob.token, "POWERUP_SIGNAL_JAMMER", "b3-jam-bob");
    const jr = await redeem(bob.token, raceId, "SIGNAL_JAMMER");
    const jammerId = (await jr.json()).result.powerup.id;
    assert.equal(
      (await usePowerup(bob.token, raceId, jammerId, { targetUserId: alice.userId })).status,
      200
    );

    // Alice (jammed) buys a live Red Card and tries to redeem it. Imposter is
    // independently tombstoned and cannot be used as a jam preflight fixture.
    await purchase(alice.token, "POWERUP_RED_CARD", "b3-jam-alice");
    assert.equal(await inventoryQty(alice.userId, "RED_CARD"), 1);

    const res = await redeem(alice.token, raceId, "RED_CARD");
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "SIGNAL_JAMMED");

    assert.equal(await inventoryQty(alice.userId, "RED_CARD"), 1, "inventory not spent");
    assert.equal((await heldRows(raceId, alice.userId, "RED_CARD")).length, 0, "no HELD row minted");
  });

  it("redeeming a RAINSTORM with no eligible targets → 400 NO_ELIGIBLE_TARGETS, no inventory spent", async () => {
    await seedStoreCatalog();
    const alice = await createUser("AliceB3empty");
    const bob = await createUser("BobB3empty");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    // The only other runner has finished — no one to rain on.
    const bobP = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
    await prisma.raceParticipant.update({
      where: { id: bobP.id },
      data: { finishedAt: new Date() },
    });

    await purchase(alice.token, "POWERUP_RAINSTORM", "b3-empty-1");
    const res = await redeem(alice.token, raceId, "RAINSTORM");
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "NO_ELIGIBLE_TARGETS");

    assert.equal(await inventoryQty(alice.userId, "RAINSTORM"), 1, "inventory not spent");
    assert.equal((await heldRows(raceId, alice.userId, "RAINSTORM")).length, 0);
  });
});
