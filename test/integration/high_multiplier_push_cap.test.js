const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { EventEmitter } = require("node:events");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { eventBus } = require("../../src/shared/events/eventBus");
const { registerNotificationHandlers } = require("../../src/modules/notifications/notificationHandlers");

// High-multiplier push hardening (2026-08-07):
// 1. The APNs collapse id was `himult_<raceId>_<actorUserId>` — two full UUIDs,
//    80 bytes, over APNs' 64-byte `apns-collapse-id` limit, so EVERY send 400'd
//    with InvalidCollapseId in prod. It must now fit within 64 bytes.
// 2. Once-per-day recipient cap: a user receives at most ONE high-multiplier
//    push per rolling 24h across ALL races/actors (first spike wins), keyed off
//    the recorded notification row so it holds across pm2 cluster workers.

let server;
let nextAppleId = 0;
let alerts = [];

function createUser(displayName) {
  return (async () => {
    const appleId = `apple-himultcap-${++nextAppleId}`;
    const res = await request(server.baseUrl, "POST", "/auth/apple", { body: { identityToken: appleId } });
    const body = await res.json();
    await request(server.baseUrl, "PUT", "/auth/me/display-name", { body: { displayName }, token: body.sessionToken });
    return { userId: body.user.id, token: body.sessionToken };
  })();
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", { body: { addresseeId: b.userId }, token: a.token });
  const fId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${fId}`, { body: { accept: true }, token: b.token });
}

async function createActiveRace(alice, bob) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: { name: "HiMult Cap Test", targetSteps: 500000, maxDurationDays: 7, powerupsEnabled: true, powerupStepInterval: 5000 },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, { body: { inviteeIds: [bob.userId] }, token: alice.token });
  await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, { body: { accept: true }, token: bob.token });
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: twoHoursAgo } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: twoHoursAgo } });
  return raceId;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

let seedSeq = 0;
async function seedBuffEffect(raceId, part, type) {
  const pw = await prisma.racePowerup.create({
    data: { raceId, participantId: part.id, userId: part.userId, type, rarity: "UNCOMMON", status: "USED", earnedAtSteps: 700000 + seedSeq++ },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId, targetParticipantId: part.id, targetUserId: part.userId, sourceUserId: part.userId,
      powerupId: pw.id, type, status: "ACTIVE",
      startsAt: new Date(Date.now() - 60 * 1000), expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      metadata: {},
    },
  });
}

// Drive a participant to 6x so the evaluator (threshold 4, strict >) fires.
async function spike(raceId, userId) {
  const p = await participant(raceId, userId);
  await seedBuffEffect(raceId, p, "RUNNERS_HIGH");
  await seedBuffEffect(raceId, p, "RUNNERS_HIGH");
  await seedBuffEffect(raceId, p, "RUNNERS_HIGH");
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token });
  return (await res.json()).progress;
}

async function waitFor(fn, ms = 4000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bobRows(bobUserId) {
  return prisma.notification.findMany({
    where: { userId: bobUserId, type: "HIGH_MULTIPLIER_ALERT" },
    orderBy: { createdAt: "asc" },
  });
}

describe("high-multiplier push — collapse id + once-per-day recipient cap", () => {
  before(async () => {
    server = await getSharedServer();
    eventBus.on("HIGH_MULTIPLIER_ALERT", (data) => alerts.push(data));
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.globalStepEvent.deleteMany({});
    nextAppleId = 0;
    alerts = [];
    delete process.env.HIGH_MULTIPLIER_PUSH_DISABLED;
    delete process.env.HIGH_MULTIPLIER_PUSH_THRESHOLD;
  });

  // ── Handler-level: the APNs boundary (fake push service, real DB) ─────────
  describe("push handler (injected push boundary)", () => {
    function buildHandlerHarness() {
      const bus = new EventEmitter();
      const sent = [];
      const fakePush = {
        sendNotification: async (args) => {
          sent.push(args);
          return { success: true };
        },
      };
      const fakeDeviceTokens = {
        findByUserId: async (userId) => [{ token: `tok-${userId}`, platform: "ios" }],
        deleteToken: async () => {},
      };
      registerNotificationHandlers({
        eventBus: bus,
        apnsService: fakePush,
        fcmService: fakePush,
        DeviceToken: fakeDeviceTokens,
        logger: { error() {}, warn() {} },
      });
      return { bus, sent };
    }

    it("sends a collapse id within APNs' 64-byte limit (the prod InvalidCollapseId bug)", async () => {
      const alice = await createUser("HiMultAliceA");
      const bob = await createUser("HiMultBobAAA");
      const { bus, sent } = buildHandlerHarness();

      bus.emit("HIGH_MULTIPLIER_ALERT", {
        raceId: "bdec7e3f-ddc0-4d70-8d34-4637293705e7",
        raceName: "Race",
        actorUserId: alice.userId,
        actorName: "HiMultAliceA",
        multiplier: 6,
        recipientUserIds: [bob.userId],
      });

      await waitFor(() => sent.length === 1);
      const { collapseId } = sent[0];
      assert.ok(collapseId, "collapse id still set");
      assert.ok(
        Buffer.byteLength(collapseId, "utf8") <= 64,
        `collapse id must be <= 64 bytes for APNs, got ${Buffer.byteLength(collapseId, "utf8")} (${collapseId})`
      );
    });

    it("caps a recipient at one push per rolling 24h across races/actors, then re-allows", async () => {
      const alice = await createUser("HiMultAliceB");
      const bob = await createUser("HiMultBobBBB");
      const carol = await createUser("HiMultCarolB");
      const { bus, sent } = buildHandlerHarness();

      const emitAlert = (raceId, actor) =>
        bus.emit("HIGH_MULTIPLIER_ALERT", {
          raceId,
          raceName: "Race",
          actorUserId: actor.userId,
          actorName: "Actor",
          multiplier: 5,
          recipientUserIds: [bob.userId],
        });

      // First spike → push sent + one row recorded.
      emitAlert("11111111-1111-4111-8111-111111111111", alice);
      await waitFor(() => sent.length === 1);
      await waitFor(async () => (await bobRows(bob.userId)).length === 1);

      // Different race, different actor, same day → capped: no push, no new row.
      emitAlert("22222222-2222-4222-8222-222222222222", carol);
      await sleep(400);
      assert.equal(sent.length, 1, "second same-day alert must not send a push");
      assert.equal((await bobRows(bob.userId)).length, 1, "capped alert must not record a row");

      // Age the recorded row past 24h → the next spike sends again.
      await prisma.notification.updateMany({
        where: { userId: bob.userId, type: "HIGH_MULTIPLIER_ALERT" },
        data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
      });
      emitAlert("33333333-3333-4333-8333-333333333333", carol);
      await waitFor(() => sent.length === 2);
      await waitFor(async () => (await bobRows(bob.userId)).length === 2);
    });
  });

  // ── End-to-end: two real races through the public progress path ───────────
  // The prod entrypoint (src/index.js) registers the notification handlers on
  // the global event bus; the integration test server (createApp) does not. To
  // exercise the REAL chain — progress request → evaluator → event bus →
  // handler → cap → recorded row — register the real handlers on the real bus
  // here, faking only the push transport (the alternative is Apple's live API).
  // Each test file runs in its own process, so this registration can't leak.
  it("E2E: spikes in two races on the same day yield exactly one push + one recorded alert for the rival", async () => {
    // Other real handlers (race invite/start, etc.) also push to Bob's token —
    // capture only this feature's sends.
    const allSent = [];
    const sent = { get length() { return allSent.filter((a) => a.payload?.type === "HIGH_MULTIPLIER_ALERT").length; }, at(i) { return allSent.filter((a) => a.payload?.type === "HIGH_MULTIPLIER_ALERT")[i]; } };
    registerNotificationHandlers({
      apnsService: { sendNotification: async (args) => { allSent.push(args); return { success: true }; } },
      fcmService: { sendNotification: async () => ({ success: true }) },
      logger: { error() {}, warn() {} },
    });

    const alice = await createUser("HiMultAliceC");
    const bob = await createUser("HiMultBobCCC");
    await makeFriends(alice, bob);
    // The handler `continue`s past token-less recipients before recording, so
    // Bob needs a device token row for anything to be observable.
    await prisma.deviceToken.create({
      data: { userId: bob.userId, token: "himult-e2e-token", platform: "ios" },
    });
    const race1 = await createActiveRace(alice, bob);
    const race2 = await createActiveRace(alice, bob);

    // Race 1 spike → evaluator emits, the REAL handler records one row for Bob
    // (no device tokens exist in test, so only the record side is observable).
    await spike(race1, alice.userId);
    await getProgress(bob.token, race1);
    assert.equal(alerts.filter((a) => a.raceId === race1).length, 1);
    await waitFor(async () => (await bobRows(bob.userId)).length === 1);
    assert.equal(sent.length, 1, "one push through the real chain");
    assert.ok(Buffer.byteLength(sent.at(0).collapseId, "utf8") <= 64);

    // Race 2 spike the same day → the evaluator still emits (its once-per-spike
    // state is per race), but the daily cap swallows the notification.
    await spike(race2, alice.userId);
    await getProgress(bob.token, race2);
    assert.equal(alerts.filter((a) => a.raceId === race2).length, 1);
    await sleep(500);
    assert.equal((await bobRows(bob.userId)).length, 1, "same-day second race must not add a row");
    assert.equal(sent.length, 1, "same-day second race must not push");

    // Age the row past 24h → a fresh race's spike notifies again.
    await prisma.notification.updateMany({
      where: { userId: bob.userId, type: "HIGH_MULTIPLIER_ALERT" },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    const race3 = await createActiveRace(alice, bob);
    await spike(race3, alice.userId);
    await getProgress(bob.token, race3);
    await waitFor(async () => (await bobRows(bob.userId)).length === 2);
  });
});
