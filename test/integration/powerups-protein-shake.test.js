const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

function authOverrides() {
  return {
    verifyAppleIdentityToken: async (token) => ({
      sub: token,
      email: `${token}@example.com`,
    }),
  };
}

async function createUser(displayName) {
  const appleId = `apple-ps-${++nextAppleId}`;
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
      name: "Protein Shake Test",
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
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: "COMMON",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token });
  return (await res.json()).progress;
}

async function usePowerup(token, raceId, powerupId, targetUserId) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body: targetUserId ? { targetUserId } : {},
    token,
  });
}

describe("protein shake", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("adds 1500 bonus steps to user's total", async () => {
    const alice = await createUser("AliceShakeAA");
    const bob = await createUser("BobShakeAAAA");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const powerup = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);

    const res = await usePowerup(alice.token, raceId, powerup.id);
    assert.equal(res.status, 200);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = progress.participants.find((p) => p.userId === alice.userId);
    assert.equal(aliceP.totalSteps, 1500);
  });

  it("multiple protein shakes stack", async () => {
    const alice = await createUser("AliceShakeBB");
    const bob = await createUser("BobShakeBBBB");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const p1 = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
    const p2 = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99902);

    await usePowerup(alice.token, raceId, p1.id);
    await usePowerup(alice.token, raceId, p2.id);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = progress.participants.find((p) => p.userId === alice.userId);
    assert.equal(aliceP.totalSteps, 3000);
  });

  it("is self-only — rejects if targetUserId provided", async () => {
    const alice = await createUser("AliceShakeCC");
    const bob = await createUser("BobShakeCCCC");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const powerup = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);

    const res = await usePowerup(alice.token, raceId, powerup.id, bob.userId);
    assert.equal(res.status, 400);
  });

  it("bonus steps persist across progress fetches", async () => {
    const alice = await createUser("AliceShakeDD");
    const bob = await createUser("BobShakeDDDD");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const powerup = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
    await usePowerup(alice.token, raceId, powerup.id);

    // Fetch progress multiple times
    const progress1 = await getProgress(alice.token, raceId);
    const progress2 = await getProgress(alice.token, raceId);

    const alice1 = progress1.participants.find((p) => p.userId === alice.userId);
    const alice2 = progress2.participants.find((p) => p.userId === alice.userId);
    assert.equal(alice1.totalSteps, 1500);
    assert.equal(alice2.totalSteps, 1500);
  });

  it("cannot be blocked by compression socks", async () => {
    const alice = await createUser("AliceShakeEE");
    const bob = await createUser("BobShakeEEEE");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // Give alice compression socks and activate them
    const shield = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99901);
    await usePowerup(alice.token, raceId, shield.id);

    // Give alice a protein shake — should work even with shield active
    const shake = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99902);
    const res = await usePowerup(alice.token, raceId, shake.id);
    assert.equal(res.status, 200);

    const body = await res.json();
    // Should NOT be blocked
    assert.ok(!body.result.blocked);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = progress.participants.find((p) => p.userId === alice.userId);
    assert.equal(aliceP.totalSteps, 1500);
  });

  it("bonus steps are not reduced by leg cramp", async () => {
    const alice = await createUser("AliceShakeFF");
    const bob = await createUser("BobShakeFFFF");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // Alice uses protein shake
    const shake = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
    await usePowerup(alice.token, raceId, shake.id);

    // Bob applies leg cramp to alice
    const cramp = await giveHeldPowerup(raceId, bob.userId, "LEG_CRAMP", 99902);
    await usePowerup(bob.token, raceId, cramp.id, alice.userId);

    // Alice's bonus steps should still be 1500 (leg cramp freezes walked steps, not bonus)
    const progress = await getProgress(alice.token, raceId);
    const aliceP = progress.participants.find((p) => p.userId === alice.userId);
    assert.equal(aliceP.totalSteps, 1500);
  });

  it("feed shows protein shake usage event", async () => {
    const alice = await createUser("AliceShakeGG");
    const bob = await createUser("BobShakeGGGG");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const powerup = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
    await usePowerup(alice.token, raceId, powerup.id);

    const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
    assert.equal(feedRes.status, 200);

    const feedBody = await feedRes.json();
    const shakeEvent = feedBody.events.find(
      (e) => e.eventType === "POWERUP_USED" && e.powerupType === "PROTEIN_SHAKE"
    );
    assert.ok(shakeEvent, "feed should contain protein shake usage event");
    assert.ok(shakeEvent.description.includes("Protein Shake"));
  });
});
