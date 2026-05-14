const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-new-pu-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
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

async function createActiveRace() {
  const alice = await createUser("AliceNewPU");
  const bob = await createUser("BobbyNewPU");
  await makeFriends(alice, bob);

  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "New Powerups",
      targetSteps: 200000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;

  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: [bob.userId] },
    token: alice.token,
  });
  await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
    body: { accept: true },
    token: bob.token,
  });
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: alice.token,
  });

  return { alice, bob, raceId };
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps, rarity = "COMMON") {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity,
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function usePowerup(token, raceId, powerupId, body = {}) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body,
    token,
  });
}

describe("new powerups — integration", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("Pinecone Toss targets the adjacent runner by direction", async () => {
    const { alice, bob, raceId } = await createActiveRace();
    const aliceParticipant = await participant(raceId, alice.userId);
    const bobParticipant = await participant(raceId, bob.userId);
    await prisma.raceParticipant.update({
      where: { id: aliceParticipant.id },
      data: { totalSteps: 1000 },
    });
    await prisma.raceParticipant.update({
      where: { id: bobParticipant.id },
      data: { totalSteps: 5000 },
    });

    const pinecone = await giveHeldPowerup(
      raceId,
      alice.userId,
      "PINECONE_TOSS",
      1000,
      "UNCOMMON"
    );
    const res = await usePowerup(alice.token, raceId, pinecone.id, {
      targetDirection: "FRONT",
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.penalty, 750);

    const updatedBob = await participant(raceId, bob.userId);
    assert.equal(updatedBob.bonusSteps, -750);
  });

  it("Sneaky Swap options require Sneaky Swap and reject stealthed targets", async () => {
    const { alice, bob, raceId } = await createActiveRace();
    const bobParticipant = await participant(raceId, bob.userId);

    const bobTrade = await giveHeldPowerup(raceId, bob.userId, "PINECONE_TOSS", 1000, "UNCOMMON");

    const noSneakyRes = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/powerups/sneaky-swap-options/${bob.userId}`,
      { token: alice.token }
    );
    assert.equal(noSneakyRes.status, 400);
    assert.match((await noSneakyRes.json()).error, /required/i);

    await giveHeldPowerup(raceId, alice.userId, "SNEAKY_SWAP", 1000, "RARE");
    const aliceTrade = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MAGNET", 2000, "COMMON");

    const optionsRes = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/powerups/sneaky-swap-options/${bob.userId}`,
      { token: alice.token }
    );
    assert.equal(optionsRes.status, 200);
    const options = await optionsRes.json();
    assert.deepEqual(options.ownPowerups.map((p) => p.id), [aliceTrade.id]);
    assert.deepEqual(options.targetPowerups.map((p) => p.id), [bobTrade.id]);

    const stealth = await giveHeldPowerup(raceId, bob.userId, "STEALTH_MODE", 2000, "UNCOMMON");
    await prisma.raceActiveEffect.create({
      data: {
        raceId,
        targetParticipantId: bobParticipant.id,
        targetUserId: bob.userId,
        sourceUserId: bob.userId,
        powerupId: stealth.id,
        type: "STEALTH_MODE",
        startsAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const blockedRes = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/powerups/sneaky-swap-options/${bob.userId}`,
      { token: alice.token }
    );
    assert.equal(blockedRes.status, 400);
    assert.match((await blockedRes.json()).error, /stealthed/i);
  });
});
