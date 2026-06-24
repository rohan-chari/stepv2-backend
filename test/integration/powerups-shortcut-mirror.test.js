const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// ---------------------------------------------------------------------------
// SHORTCUT vs MIRROR (end-to-end)
//
// The attacker uses Shortcut on a target holding an active Mirror. The Mirror
// reflects the Shortcut back onto the attacker, so the steal runs in reverse:
// 1000 steps are taken FROM the attacker and given to the original target.
//
// Expectation under test: the net result is the attacker ("the user") just
// losing 1000 steps.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-scm-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  if (displayName) {
    await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      body: { displayName },
      token: body.sessionToken,
    });
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

async function createActiveRace(alice, bob) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Shortcut vs Mirror",
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
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });
  const defaultStart = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: defaultStart } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: defaultStart } });
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  const rareTypes = ["COMPRESSION_SOCKS", "MIRROR"];
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: rareTypes.includes(type) ? "RARE" : "COMMON",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function giveBonusSteps(raceId, userId, amount) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  await prisma.raceParticipant.update({
    where: { id: participant.id },
    data: { bonusSteps: { increment: amount }, totalSteps: amount },
  });
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token });
  return (await res.json()).progress;
}

function findUser(progress, userId) {
  return progress.participants.find((p) => p.userId === userId);
}

async function usePowerup(token, raceId, powerupId, targetUserId) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body: targetUserId ? { targetUserId } : {},
    token,
  });
}

describe("shortcut reflected by mirror", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {});

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("net result is the attacker just losing 1000 steps", async () => {
    const alice = await createUser("AliceAttacker"); // uses the shortcut
    const bob = await createUser("BobMirror"); // holds the mirror
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // Both start with 5000 steps. Alice needs steps so the reflected steal has
    // something to take; Bob needs steps so the shortcut is a valid attack.
    await giveBonusSteps(raceId, alice.userId, 5000);
    await giveBonusSteps(raceId, bob.userId, 5000);

    // Bob activates Mirror (self-applied, no target).
    const mirror = await giveHeldPowerup(raceId, bob.userId, "MIRROR", 99901);
    const mirrorRes = await usePowerup(bob.token, raceId, mirror.id);
    assert.equal(mirrorRes.status, 200);

    // Alice uses Shortcut on Bob — Bob's Mirror reflects it back at Alice.
    const shortcut = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99902);
    const res = await usePowerup(alice.token, raceId, shortcut.id, bob.userId);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.result.outcome, "REFLECTED");
    assert.equal(body.result.stolen, 1000);

    // End result: Alice (the user who used the shortcut) is down exactly 1000.
    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    const bobP = findUser(progress, bob.userId);

    assert.equal(aliceP.totalSteps, 4000, "attacker should lose 1000 steps");
    assert.equal(bobP.totalSteps, 6000, "the reflected steps go to the mirror holder");
  });
});
