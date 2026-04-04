const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-fs-${++nextAppleId}`;
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
      name: "Feed Stealth Test",
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
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: "UNCOMMON",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function usePowerup(token, raceId, powerupId, targetUserId) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body: targetUserId ? { targetUserId } : {},
    token,
  });
}

describe("feed stealth filtering", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("opponent sees ??? in feed description for stealthed user's actions", async () => {
    const alice = await createUser("AliceStealth");
    const bob = await createUser("BobbyWatcher");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // Alice goes stealth
    const stealth = await giveHeldPowerup(raceId, alice.userId, "STEALTH_MODE", 99901);
    await usePowerup(alice.token, raceId, stealth.id);

    // Alice uses a protein shake while stealthed
    const shake = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99902);
    await usePowerup(alice.token, raceId, shake.id);

    // Bob views feed — alice's name should be replaced with ???
    const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: bob.token });
    const feedBody = await feedRes.json();

    const shakeEvent = feedBody.events.find(
      (e) => e.eventType === "POWERUP_USED" && e.powerupType === "PROTEIN_SHAKE"
    );
    assert.ok(shakeEvent);
    assert.ok(!shakeEvent.description.includes("AliceStealth"), "stealthed user's real name should not appear in feed");
    assert.ok(shakeEvent.description.includes("???"), "description should use ??? for stealthed user");
  });

  it("stealthed user sees their own real name in feed", async () => {
    const alice = await createUser("AliceStealth");
    const bob = await createUser("BobbyWatcher");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // Alice goes stealth and uses protein shake
    const stealth = await giveHeldPowerup(raceId, alice.userId, "STEALTH_MODE", 99901);
    await usePowerup(alice.token, raceId, stealth.id);

    const shake = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99902);
    await usePowerup(alice.token, raceId, shake.id);

    // Alice views her own feed — should see real name
    const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
    const feedBody = await feedRes.json();

    const shakeEvent = feedBody.events.find(
      (e) => e.eventType === "POWERUP_USED" && e.powerupType === "PROTEIN_SHAKE"
    );
    assert.ok(shakeEvent);
    assert.ok(shakeEvent.description.includes("AliceStealth"), "user should see their own real name");
  });

  it("after stealth expires, name appears normally in new feed events", async () => {
    const alice = await createUser("AliceStealth");
    const bob = await createUser("BobbyWatcher");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // Alice goes stealth
    const stealth = await giveHeldPowerup(raceId, alice.userId, "STEALTH_MODE", 99901);
    await usePowerup(alice.token, raceId, stealth.id);

    // Force stealth expiry
    const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "STEALTH_MODE" } });
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: { expiresAt: new Date(Date.now() - 60000), status: "EXPIRED" },
    });

    // Alice uses protein shake after stealth expired
    const shake = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99902);
    await usePowerup(alice.token, raceId, shake.id);

    // Bob should see alice's real name for the post-stealth event
    const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: bob.token });
    const feedBody = await feedRes.json();

    const shakeEvent = feedBody.events.find(
      (e) => e.eventType === "POWERUP_USED" && e.powerupType === "PROTEIN_SHAKE"
    );
    assert.ok(shakeEvent);
    assert.ok(shakeEvent.description.includes("AliceStealth"), "post-stealth events should show real name");
  });

  it("targeted powerup descriptions hide stealthed target name too", async () => {
    const alice = await createUser("AliceStealth");
    const bob = await createUser("BobbyWatcher");
    const charlie = await createUser("CharlieViews");
    await makeFriends(alice, bob);
    await makeFriends(alice, charlie);
    await makeFriends(bob, charlie);

    const createRes = await request(server.baseUrl, "POST", "/races", {
      body: { name: "3P Feed Test", targetSteps: 200000, maxDurationDays: 7, powerupsEnabled: true, powerupStepInterval: 5000 },
      token: alice.token,
    });
    const raceId = (await createRes.json()).race.id;
    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      body: { inviteeIds: [bob.userId, charlie.userId] },
      token: alice.token,
    });
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, { body: { accept: true }, token: bob.token });
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, { body: { accept: true }, token: charlie.token });
    await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });

    // Alice goes stealth
    const stealth = await giveHeldPowerup(raceId, alice.userId, "STEALTH_MODE", 99901);
    await usePowerup(alice.token, raceId, stealth.id);

    // Bob uses leg cramp on stealthed alice
    const cramp = await giveHeldPowerup(raceId, bob.userId, "LEG_CRAMP", 99902);
    await usePowerup(bob.token, raceId, cramp.id, alice.userId);

    // Charlie views feed — alice's name as TARGET should be hidden
    const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: charlie.token });
    const feedBody = await feedRes.json();

    const crampEvent = feedBody.events.find(
      (e) => e.eventType === "POWERUP_USED" && e.powerupType === "LEG_CRAMP"
    );
    assert.ok(crampEvent);
    assert.ok(!crampEvent.description.includes("AliceStealth"), "stealthed target name should be hidden");
    assert.ok(crampEvent.description.includes("???"), "should use ??? for stealthed target");
    assert.ok(crampEvent.description.includes("BobbyWatcher"), "non-stealthed actor name should still show");
  });
});
