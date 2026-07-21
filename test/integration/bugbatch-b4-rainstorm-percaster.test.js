const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// ---------------------------------------------------------------------------
// B4 — Rainstorm concurrency becomes PER-CASTER, and overlapping storms clamp a
// victim at exactly 0.5x (a single -0.5x), never 0.25x / 0x.
//   * two different users can each have an active storm at once;
//   * the same user cannot start a second storm while their own is active;
//   * a victim under two storms scores at 0.5x through the real steps path;
//   * the B3 redeem pre-flight uses the same per-caster rule.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

const STORE_POWERUPS = [
  { sku: "POWERUP_RAINSTORM", name: "Rainstorm", powerupType: "RAINSTORM", priceCoins: 75, sortOrder: 1 },
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
  const appleId = `apple-b4-${++nextAppleId}`;
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

async function createActiveRace(creator, opponents) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "B4 Rainstorm",
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: creator.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: opponents.map((o) => o.userId) },
    token: creator.token,
  });
  for (const o of opponents) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: creator.token });
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

// Buy, redeem, and cast a rainstorm from `user`. Returns the use response.
async function castRainstorm(user, raceId, key) {
  const p = await purchase(user.token, "POWERUP_RAINSTORM", key);
  assert.equal(p.status, 200, "rainstorm purchase ok");
  const r = await redeem(user.token, raceId, "RAINSTORM");
  return { redeemRes: r };
}

async function recordSamples(token, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", {
    body: { samples },
    token,
  });
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token });
  return (await res.json()).progress;
}

function findUser(progress, userId) {
  return progress.participants.find((p) => p.userId === userId);
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}
function minutesAgo(m) {
  return new Date(Date.now() - m * 60 * 1000);
}

describe("B4 — per-caster rainstorm limit + 0.5x stacking clamp", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("two different users can each have an active storm at the same time", async () => {
    await seedStoreCatalog();
    const alice = await createUser("AliceB4a");
    const bob = await createUser("BobB4a");
    const carol = await createUser("CarolB4a");
    await makeFriends(alice, bob);
    await makeFriends(alice, carol);
    const raceId = await createActiveRace(alice, [bob, carol]);

    // Alice casts.
    const a = await castRainstorm(alice, raceId, "b4a-alice");
    assert.equal(a.redeemRes.status, 200);
    const aStorm = (await a.redeemRes.json()).result.powerup.id;
    assert.equal((await usePowerup(alice.token, raceId, aStorm)).status, 200);

    // Bob casts while Alice's storm is still active — allowed under per-caster.
    const b = await castRainstorm(bob, raceId, "b4a-bob");
    assert.equal(b.redeemRes.status, 200);
    const bStorm = (await b.redeemRes.json()).result.powerup.id;
    const bUse = await usePowerup(bob.token, raceId, bStorm);
    assert.equal(bUse.status, 200, "second caster's storm is allowed");

    const casters = await prisma.raceActiveEffect.findMany({
      where: { raceId, type: "RAINSTORM", status: "ACTIVE" },
      distinct: ["sourceUserId"],
    });
    const casterIds = casters.map((e) => e.sourceUserId).sort();
    assert.deepEqual(
      casterIds.sort(),
      [alice.userId, bob.userId].sort(),
      "both casters have active storms"
    );
  });

  it("the same user cannot start a second storm while their own is active", async () => {
    await seedStoreCatalog();
    const alice = await createUser("AliceB4b");
    const bob = await createUser("BobB4b");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    const a1 = await castRainstorm(alice, raceId, "b4b-1");
    const storm1 = (await a1.redeemRes.json()).result.powerup.id;
    assert.equal((await usePowerup(alice.token, raceId, storm1)).status, 200);

    // Redeem a second (allowed to redeem only because... actually pre-flight
    // blocks it) — verify the USE guard copy directly by seeding a HELD storm.
    const aliceP = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: alice.userId },
    });
    const held = await prisma.racePowerup.create({
      data: {
        raceId,
        participantId: aliceP.id,
        userId: alice.userId,
        type: "RAINSTORM",
        status: "HELD",
        earnedAtSteps: null,
      },
    });
    const res = await usePowerup(alice.token, raceId, held.id);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /your rainstorm is already active/i);
    // Not consumed.
    assert.equal(
      (await prisma.racePowerup.findUnique({ where: { id: held.id } })).status,
      "HELD"
    );
  });

  it("B3 redeem pre-flight allows user B to redeem while user A's storm is active", async () => {
    await seedStoreCatalog();
    const alice = await createUser("AliceB4c");
    const bob = await createUser("BobB4c");
    const carol = await createUser("CarolB4c");
    await makeFriends(alice, bob);
    await makeFriends(alice, carol);
    const raceId = await createActiveRace(alice, [bob, carol]);

    const a = await castRainstorm(alice, raceId, "b4c-alice");
    const aStorm = (await a.redeemRes.json()).result.powerup.id;
    assert.equal((await usePowerup(alice.token, raceId, aStorm)).status, 200);

    // Bob redeems his own rainstorm while Alice's is active — must be allowed.
    await purchase(bob.token, "POWERUP_RAINSTORM", "b4c-bob");
    const bobRedeem = await redeem(bob.token, raceId, "RAINSTORM");
    assert.equal(bobRedeem.status, 200, "per-caster: B can redeem while A's storm is active");
  });

  it("a victim under TWO storms scores at exactly 0.5x (not 0.25x)", async () => {
    await seedStoreCatalog();
    const alice = await createUser("AliceB4d");
    const bob = await createUser("BobB4d");
    const carol = await createUser("CarolB4d"); // the victim
    await makeFriends(alice, bob);
    await makeFriends(alice, carol);
    const raceId = await createActiveRace(alice, [bob, carol]);

    // Alice and Bob both cast — Carol is hit by both storms.
    const a = await castRainstorm(alice, raceId, "b4d-alice");
    const aStorm = (await a.redeemRes.json()).result.powerup.id;
    assert.equal((await usePowerup(alice.token, raceId, aStorm)).status, 200);
    const b = await castRainstorm(bob, raceId, "b4d-bob");
    const bStorm = (await b.redeemRes.json()).result.powerup.id;
    assert.equal((await usePowerup(bob.token, raceId, bStorm)).status, 200);

    // Sanity: Carol has two active RAINSTORM effects.
    const carolP = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: carol.userId },
    });
    const carolStorms = await prisma.raceActiveEffect.findMany({
      where: { raceId, type: "RAINSTORM", targetParticipantId: carolP.id, status: "ACTIVE" },
    });
    assert.equal(carolStorms.length, 2, "victim is under two storms");

    // Anchor both storms to a fixed past window so Carol's sample lands inside.
    const windowStart = minutesAgo(40);
    const windowEnd = new Date(Date.now() + 20 * 60 * 1000);
    for (const s of carolStorms) {
      await prisma.raceActiveEffect.update({
        where: { id: s.id },
        data: { startsAt: windowStart, expiresAt: windowEnd },
      });
    }

    // Carol walks 1000 steps entirely within the storm window.
    await recordSamples(carol.token, [
      { periodStart: minutesAgo(30).toISOString(), periodEnd: minutesAgo(20).toISOString(), steps: 1000 },
    ]);

    const progress = await getProgress(carol.token, raceId);
    const carolProg = findUser(progress, carol.userId);
    // Single 0.5x: 1000 - round(1000 * 0.5) = 500. Double-application would be
    // 1000 - (500 + 500) = 0.
    assert.equal(
      carolProg.totalSteps,
      500,
      "overlapping storms clamp the victim at a single 0.5x"
    );
  });
});
