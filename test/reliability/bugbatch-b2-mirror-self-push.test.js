const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const {
  registerNotificationHandlers,
} = require("../../src/modules/notifications/notificationHandlers");
const { eventBus } = require("../../src/shared/events/eventBus");

// ---------------------------------------------------------------------------
// B2 — a Mirror reflect must not push "you stole steps from yourself" to the
// original attacker.
//
// After a reflect, usePowerup emits POWERUP_USED with userId === targetUserId
// (both the original attacker). The POWERUP_USED notification handler must
// suppress that self-push. A normal (unreflected) attack must still push the
// real victim.
//
// End-to-end: the real /use HTTP endpoint emits POWERUP_USED on the singleton
// event bus; the real notification handler runs against a captured push stub.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

// deviceToken -> capture entries
const captured = [];
const tokenOwner = new Map(); // deviceToken -> userId label

function pushStub() {
  return {
    async sendNotification(args) {
      captured.push(args);
      return { success: true };
    },
  };
}

async function settle(ms = 300) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForPowerupPush(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (captured.some(predicate)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

async function createUser(displayName) {
  const appleId = `apple-b2-${++nextAppleId}`;
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

async function giveDeviceToken(userId, token) {
  await prisma.deviceToken.create({
    data: { userId, token, platform: "ios" },
  });
  tokenOwner.set(token, userId);
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

async function createActiveRace(alice, others) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "B2 Self-Push Test",
      targetSteps: 200000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((o) => o.userId) },
    token: alice.token,
  });
  for (const o of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: alice.token,
  });
  const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start } });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: start },
  });
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  const rare = ["COMPRESSION_SOCKS", "MIRROR"];
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity: rare.includes(type) ? "RARE" : "COMMON",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function giveBonusSteps(raceId, userId, amount) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  await prisma.raceParticipant.update({
    where: { id: p.id },
    data: { bonusSteps: { increment: amount }, totalSteps: amount },
  });
}

async function usePowerup(token, raceId, powerupId, targetUserId) {
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/use`,
    { body: targetUserId ? { targetUserId } : {}, token }
  );
}

function powerupPushesTo(userId) {
  return captured.filter(
    (c) =>
      c.payload &&
      c.payload.type === "POWERUP_USED" &&
      tokenOwner.get(c.deviceToken) === userId
  );
}

describe("B2 — mirror reflect self-push suppression", () => {
  before(async () => {
    server = await getSharedServer();
    // Wire the real notification handlers onto the singleton event bus the
    // /use endpoint emits on, with a captured push stub.
    registerNotificationHandlers({
      eventBus,
      apnsService: pushStub(),
      fcmService: pushStub(),
      logger: { warn() {}, error() {}, info() {}, log() {} },
    });
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    captured.length = 0;
    tokenOwner.clear();
  });

  it("no self-push to the attacker when their Shortcut is reflected by a Mirror", async () => {
    const alice = await createUser("AliceAtkB2"); // attacker
    const bob = await createUser("BobMirrorB2"); // holds mirror
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);
    await giveDeviceToken(alice.userId, "tok-alice-b2");
    await giveDeviceToken(bob.userId, "tok-bob-b2");

    await giveBonusSteps(raceId, alice.userId, 5000);
    await giveBonusSteps(raceId, bob.userId, 5000);

    // Bob arms Mirror.
    const mirror = await giveHeldPowerup(raceId, bob.userId, "MIRROR", 91001);
    assert.equal((await usePowerup(bob.token, raceId, mirror.id)).status, 200);

    // Alice shortcuts Bob → reflected back at Alice.
    const shortcut = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 91002);
    const res = await usePowerup(alice.token, raceId, shortcut.id, bob.userId);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result.outcome, "REFLECTED");

    await settle();

    assert.equal(
      powerupPushesTo(alice.userId).length,
      0,
      "attacker must NOT receive a self-push after their own attack is reflected"
    );
    // And no bogus push to bob either (bob was never actually stolen from).
    assert.equal(powerupPushesTo(bob.userId).length, 0);
  });

  it("a normal (unreflected) Shortcut still pushes the real victim", async () => {
    const alice = await createUser("AliceAtkB2b");
    const bob = await createUser("BobVictimB2b");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);
    await giveDeviceToken(alice.userId, "tok-alice-b2b");
    await giveDeviceToken(bob.userId, "tok-bob-b2b");

    await giveBonusSteps(raceId, alice.userId, 5000);
    await giveBonusSteps(raceId, bob.userId, 5000);

    const shortcut = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 91003);
    const res = await usePowerup(alice.token, raceId, shortcut.id, bob.userId);
    assert.equal(res.status, 200);

    const arrived = await waitForPowerupPush(
      (c) => tokenOwner.get(c.deviceToken) === bob.userId
    );
    assert.ok(arrived, "victim receives the attack push");

    const bobPushes = powerupPushesTo(bob.userId);
    assert.equal(bobPushes.length, 1);
    assert.match(bobPushes[0].body, /stole/i);
    // Attacker gets nothing.
    assert.equal(powerupPushesTo(alice.userId).length, 0);
  });
});
