const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const {
  registerNotificationHandlers,
} = require("../../src/modules/notifications/notificationHandlers");
const { eventBus } = require("../../src/shared/events/eventBus");

// ---------------------------------------------------------------------------
// Batch 2026-08-09 item 11 — Stealth Mode must not leak the attacker's name in
// a PUSH NOTIFICATION.
//
// The in-app feed, race messages and the leaderboard have redacted a stealthed
// player to "???" for a long time (getRaceFeed / getRaceMessages /
// raceIllusions). The two push handlers did not, so the single thing Stealth
// Mode sells was leaking out of the app on every attack — and, worse, on the
// high-multiplier alert, which fires precisely when a stealthed player has
// stacked the buffs they are hiding.
//
// End-to-end, following the powerup-attack-push-durations precedent: the real
// /use HTTP endpoint emits on the singleton event bus and the real notification
// handler composes the body against a captured stub. The FAIL-SAFE direction is
// pinned too — an emit without the flag must show the real name, never
// anonymize by accident (that would be a gameplay change, not a bug fix).
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;
let earnCounter = 0;

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
  const appleId = `apple-stealthpush-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  return { userId: body.user.id, token: body.sessionToken, displayName };
}

async function giveDeviceToken(userId, token) {
  await prisma.deviceToken.create({ data: { userId, token, platform: "ios" } });
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
      name: "Stealth Push Test",
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
  await prisma.race.update({
    where: { id: raceId },
    data: { startedAt: start, endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: start },
  });
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity: "COMMON",
      status: "HELD",
      earnedAtSteps: ++earnCounter,
    },
  });
}

// Put a live STEALTH_MODE on the caster, exactly as a real cast would.
async function stealthUp(raceId, userId) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  const backing = await prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type: "STEALTH_MODE",
      rarity: "UNCOMMON",
      status: "USED",
      earnedAtSteps: ++earnCounter,
    },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId,
      targetParticipantId: p.id,
      targetUserId: userId,
      sourceUserId: userId,
      powerupId: backing.id,
      type: "STEALTH_MODE",
      status: "ACTIVE",
      startsAt: new Date(Date.now() - 60 * 1000),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      metadata: {},
    },
  });
}

async function usePowerup(token, raceId, powerupId, body = {}) {
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/use`,
    { body, token, headers: { "X-Client-Features": "characters,powerups3,powerups4,powerups5" } }
  );
}

function attackPushTo(userId) {
  return (c) =>
    c.payload &&
    c.payload.type === "POWERUP_USED" &&
    tokenOwner.get(c.deviceToken) === userId;
}

describe("stealthed attacks never name the attacker in a push", () => {
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

  async function pair() {
    const attacker = await createUser("SneakySteve");
    const victim = await createUser("VictimVic");
    await makeFriends(attacker, victim);
    const raceId = await createActiveRace(attacker, [victim]);
    await giveDeviceToken(victim.userId, `tok-victim-${nextAppleId}`);
    return { attacker, victim, raceId };
  }

  // ── the attack push ───────────────────────────────────────────────────────

  it("a STEALTHED Leg Cramp push says ??? and never the display name", async () => {
    const { attacker, victim, raceId } = await pair();
    await stealthUp(raceId, attacker.userId);

    const cramp = await giveHeldPowerup(raceId, attacker.userId, "LEG_CRAMP");
    const res = await usePowerup(attacker.token, raceId, cramp.id, {
      targetUserId: victim.userId,
    });
    assert.equal(res.status, 200);

    const push = await waitForPush(attackPushTo(victim.userId));
    assert.ok(push, "victim got an attack push");
    assert.match(push.body, /\?\?\?/, "attacker is redacted");
    assert.ok(
      !push.body.includes("SneakySteve"),
      `display name leaked: ${push.body}`
    );
    // The victim must still learn WHAT hit them and for how long — only WHO is
    // hidden.
    assert.match(push.body, /Leg Cramp/);
    assert.match(push.body, /frozen for 1 hour/);
  });

  it("an UN-stealthed attack still names the attacker (no over-redaction)", async () => {
    const { attacker, victim, raceId } = await pair();

    const cramp = await giveHeldPowerup(raceId, attacker.userId, "LEG_CRAMP");
    const res = await usePowerup(attacker.token, raceId, cramp.id, {
      targetUserId: victim.userId,
    });
    assert.equal(res.status, 200);

    const push = await waitForPush(attackPushTo(victim.userId));
    assert.ok(push);
    assert.match(push.body, /SneakySteve/);
    assert.ok(!push.body.includes("???"));
  });

  // NOTE: deliberately does NOT call cleanDatabase() between iterations. The
  // beforeEach hook owns truncation; truncating from inside a test body
  // deadlocks (40P01) against the rest of the suite file when the runner
  // interleaves. Each iteration just builds a fresh race with fresh users —
  // `nextAppleId` keeps identities unique without touching the DB wholesale.
  it("redaction covers the other allowlisted push types too", async () => {
    for (const type of ["WRONG_TURN", "SHORTCUT"]) {
      captured.length = 0;

      const { attacker, victim, raceId } = await pair();
      await stealthUp(raceId, attacker.userId);
      // Shortcut steals from the target, so give the victim something to take.
      const p = await prisma.raceParticipant.findFirst({
        where: { raceId, userId: victim.userId },
      });
      await prisma.raceParticipant.update({
        where: { id: p.id },
        data: { totalSteps: 9000 },
      });

      const pw = await giveHeldPowerup(raceId, attacker.userId, type);
      const res = await usePowerup(attacker.token, raceId, pw.id, {
        targetUserId: victim.userId,
      });
      assert.equal(res.status, 200, `${type} should apply`);

      const push = await waitForPush(attackPushTo(victim.userId));
      assert.ok(push, `${type}: victim got a push`);
      assert.ok(
        !push.body.includes("SneakySteve"),
        `${type} leaked the name: ${push.body}`
      );
      assert.match(push.body, /\?\?\?/, `${type} should redact`);
    }
  });

  // An expired-but-still-ACTIVE stealth row (lazy expiry hasn't run) must NOT
  // anonymize — the buff is over, so the name is public again. This is the same
  // liveness rule every other stealth read uses.
  it("an EXPIRED stealth row does not anonymize", async () => {
    const { attacker, victim, raceId } = await pair();
    const p = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: attacker.userId },
    });
    const backing = await giveHeldPowerup(raceId, attacker.userId, "STEALTH_MODE");
    await prisma.raceActiveEffect.create({
      data: {
        raceId,
        targetParticipantId: p.id,
        targetUserId: attacker.userId,
        sourceUserId: attacker.userId,
        powerupId: backing.id,
        type: "STEALTH_MODE",
        status: "ACTIVE",
        startsAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 60 * 1000),
        metadata: {},
      },
    });

    const cramp = await giveHeldPowerup(raceId, attacker.userId, "LEG_CRAMP");
    await usePowerup(attacker.token, raceId, cramp.id, {
      targetUserId: victim.userId,
    });

    const push = await waitForPush(attackPushTo(victim.userId));
    assert.ok(push);
    assert.match(push.body, /SneakySteve/, "an expired stealth must not redact");
  });

  // ── fail-safe: an emit WITHOUT the flag shows the real name ────────────────

  it("an emit with no `stealthed` field defaults to the VISIBLE name", async () => {
    const { attacker, victim, raceId } = await pair();

    // Emit by hand, omitting `stealthed` entirely — this is what a future emit
    // site that forgets to thread the flag would produce. It must degrade to
    // today's behavior (real name), never to silent anonymization.
    eventBus.emit("POWERUP_USED", {
      raceId,
      userId: attacker.userId,
      powerupType: "LEG_CRAMP",
      targetUserId: victim.userId,
      upgradeLevel: 0,
    });

    const push = await waitForPush(attackPushTo(victim.userId));
    assert.ok(push, "the push still fires");
    assert.match(push.body, /SneakySteve/);
    assert.ok(!push.body.includes("???"));
  });

  // ── the high-multiplier push (second leak) ────────────────────────────────

  function multiplierPushTo(userId) {
    return (c) =>
      c.payload &&
      c.payload.type === "HIGH_MULTIPLIER_ALERT" &&
      tokenOwner.get(c.deviceToken) === userId;
  }

  it("a stealthed player's high-multiplier alert is anonymized", async () => {
    const { attacker, victim, raceId } = await pair();

    eventBus.emit("HIGH_MULTIPLIER_ALERT", {
      raceId,
      raceName: "Stealth Push Test",
      actorUserId: attacker.userId,
      actorName: attacker.displayName,
      multiplier: 4,
      recipientUserIds: [victim.userId],
      stealthed: true,
    });

    const push = await waitForPush(multiplierPushTo(victim.userId));
    assert.ok(push, "rival got the multiplier push");
    assert.match(push.body, /\?\?\?/);
    assert.ok(
      !push.body.includes("SneakySteve"),
      `high-multiplier push leaked the name: ${push.body}`
    );
    // The number itself is still useful intel and stays.
    assert.match(push.body, /4x/);
  });

  it("an un-stealthed high-multiplier alert still names the actor", async () => {
    const { attacker, victim, raceId } = await pair();

    eventBus.emit("HIGH_MULTIPLIER_ALERT", {
      raceId,
      raceName: "Stealth Push Test",
      actorUserId: attacker.userId,
      actorName: attacker.displayName,
      multiplier: 4,
      recipientUserIds: [victim.userId],
    });

    const push = await waitForPush(multiplierPushTo(victim.userId));
    assert.ok(push);
    assert.match(push.body, /SneakySteve/);
    assert.ok(!push.body.includes("???"));
  });
});
