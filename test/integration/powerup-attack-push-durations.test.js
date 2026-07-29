const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const {
  registerNotificationHandlers,
} = require("../../src/modules/notifications/notificationHandlers");
const { eventBus } = require("../../src/shared/events/eventBus");

// ---------------------------------------------------------------------------
// Attack-push copy must state the REAL effect duration (§3.4 duration
// standardization, 2026-07-25). The old copy hardcoded pre-standardization
// windows — "frozen for 2 hours" for a Leg Cramp that now runs 1h at base,
// "reversed for 1 hour" for a Wrong Turn that runs 2/3/4h when upgraded, and
// "2 hours" for a Quicksand that now runs 1h — so victims were told the wrong
// window on every push (prod report 2026-07-29).
//
// End-to-end: the real /use HTTP endpoint emits POWERUP_USED (with the caster's
// upgradeLevel) on the singleton event bus; the real notification handler
// composes the push body against a captured stub.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

const captured = [];
const tokenOwner = new Map();

function pushStub() {
  return {
    async sendNotification(args) {
      captured.push(args);
      return { success: true };
    },
  };
}

async function waitForPush(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = captured.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

async function createUser(displayName) {
  const appleId = `apple-pushdur-${++nextAppleId}`;
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

async function createActiveRace(creator, others) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Push Duration Test",
      targetSteps: 200000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: creator.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((o) => o.userId) },
    token: creator.token,
  });
  for (const o of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: creator.token,
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
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity: "COMMON",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function usePowerup(token, raceId, powerupId, { targetUserId, targetUserIds, upgradeLevel, headers } = {}) {
  const body = {};
  if (targetUserId) body.targetUserId = targetUserId;
  if (targetUserIds) body.targetUserIds = targetUserIds;
  if (upgradeLevel != null) body.upgradeLevel = upgradeLevel;
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/use`,
    { body, token, headers }
  );
}

function attackPushTo(userId) {
  return (c) =>
    c.payload &&
    c.payload.type === "POWERUP_USED" &&
    tokenOwner.get(c.deviceToken) === userId;
}

describe("powerup attack push states the real effect duration", () => {
  before(async () => {
    server = await getSharedServer();
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

  it("base Leg Cramp push says 1 hour (standardized), not the old 2 hours", async () => {
    const alice = await createUser("AliceLC0");
    const bob = await createUser("BobLC0");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);
    await giveDeviceToken(bob.userId, "tok-bob-lc0");

    const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 5001);
    const res = await usePowerup(alice.token, raceId, cramp.id, { targetUserId: bob.userId });
    assert.equal(res.status, 200);

    const push = await waitForPush(attackPushTo(bob.userId));
    assert.ok(push, "victim gets an attack push");
    assert.match(push.body, /used Leg Cramp on you/);
    assert.match(push.body, /frozen for 1 hour\b/);
    assert.doesNotMatch(push.body, /2 hours/);
  });

  it("Lvl 2 Leg Cramp push says 3 hours (ladder-aware)", async () => {
    const alice = await createUser("AliceLC2");
    const bob = await createUser("BobLC2");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);
    await giveDeviceToken(bob.userId, "tok-bob-lc2");
    await prisma.user.update({ where: { id: alice.userId }, data: { coins: 1000 } });

    const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 5001);
    const res = await usePowerup(alice.token, raceId, cramp.id, {
      targetUserId: bob.userId,
      upgradeLevel: 2,
    });
    assert.equal(res.status, 200);

    const push = await waitForPush(attackPushTo(bob.userId));
    assert.ok(push, "victim gets an attack push");
    assert.match(push.body, /frozen for 3 hours/);
  });

  it("Lvl 1 Wrong Turn push says 2 hours (ladder-aware), base says 1 hour", async () => {
    const alice = await createUser("AliceWT");
    const bob = await createUser("BobWT");
    const carol = await createUser("CarolWT");
    await makeFriends(alice, bob);
    await makeFriends(alice, carol);
    const raceId = await createActiveRace(alice, [bob, carol]);
    await giveDeviceToken(bob.userId, "tok-bob-wt");
    await giveDeviceToken(carol.userId, "tok-carol-wt");
    await prisma.user.update({ where: { id: alice.userId }, data: { coins: 1000 } });

    const wt0 = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 5001);
    assert.equal(
      (await usePowerup(alice.token, raceId, wt0.id, { targetUserId: bob.userId })).status,
      200
    );
    const basePush = await waitForPush(attackPushTo(bob.userId));
    assert.ok(basePush, "base victim gets an attack push");
    assert.match(basePush.body, /Wrong Turn/);
    assert.match(basePush.body, /reversed for 1 hour\b/);

    const wt1 = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 5002);
    assert.equal(
      (await usePowerup(alice.token, raceId, wt1.id, {
        targetUserId: carol.userId,
        upgradeLevel: 1,
      })).status,
      200
    );
    const lvlPush = await waitForPush(attackPushTo(carol.userId));
    assert.ok(lvlPush, "upgraded victim gets an attack push");
    assert.match(lvlPush.body, /reversed for 2 hours/);
  });

  it("Quicksand push says 1 hour (standardized), not the old 2 hours", async () => {
    const alice = await createUser("AliceQS");
    const bob = await createUser("BobQS");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);
    await giveDeviceToken(bob.userId, "tok-bob-qs");

    const qs = await giveHeldPowerup(raceId, alice.userId, "QUICKSAND", 5001);
    const res = await usePowerup(alice.token, raceId, qs.id, {
      targetUserIds: [bob.userId],
      headers: { "X-Client-Features": "powerups4", "X-Release-Channel": "testflight" },
    });
    assert.equal(res.status, 200);

    const push = await waitForPush(attackPushTo(bob.userId));
    assert.ok(push, "victim gets an attack push");
    assert.match(push.body, /froze your steps for 1 hour\b/);
    assert.doesNotMatch(push.body, /2 hours/);
  });
});
