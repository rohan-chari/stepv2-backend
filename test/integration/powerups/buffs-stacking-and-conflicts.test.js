// Canonical powerup integration suite.


// ---- consolidated from powerups-runners-high.test.js ----
(function powerups_runners_high_test_js(){
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");
const {
  buildRaceResolutionWorkerV2,
} = require("../../../src/modules/races/jobs/raceResolutionQueueV2");
const {
  buildRecomputePlacements,
} = require("../../../src/modules/races/jobs/placementRecompute");
const {
  buildHistoricalRaceReconciliationWorker,
} = require("../../../src/modules/races/jobs/historicalRaceReconciliation");

let server;
let nextAppleId = 0;

async function drainRaceResolution() {
  await buildRecomputePlacements({
    requestStepSyncForUsers: async () => {},
    logger: { log() {}, warn() {}, error(error) { throw error; } },
  })();
  const worker = buildRaceResolutionWorkerV2({
    bootAt: 0,
    logger: { log() {}, error(error) { throw error; } },
  });
  while (await worker.processOne()) {}
}

function authOverrides() {
  return {
    verifyAppleIdentityToken: async (token) => ({
      sub: token,
      email: `${token}@example.com`,
    }),
  };
}

async function createUser(displayName) {
  const appleId = `apple-rh-${++nextAppleId}`;
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
      name: "Runners High Test",
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
  // Backdate so step samples recorded with minutesAgo/hoursAgo fall within race window
  const defaultStart = new Date(Date.now() - 7 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: defaultStart } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: defaultStart } });
  return raceId;
}

async function backdateRaceStart(raceId, startTime) {
  await prisma.race.update({
    where: { id: raceId },
    data: { startedAt: startTime },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: startTime },
  });
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: type === "COMPRESSION_SOCKS" ? "RARE" : "UNCOMMON",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function recordSamples(token, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", {
    body: { samples },
    token,
  });
}

async function recordSyncV2(token, samples, steps = 1900) {
  return request(server.baseUrl, "POST", "/steps/sync-v2", {
    body: { date: new Date().toISOString().slice(0, 10), steps, samples },
    headers: { "Idempotency-Key": randomUUID() },
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

async function usePowerup(token, raceId, powerupId, targetUserId) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body: targetUserId ? { targetUserId } : {},
    token,
  });
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

function minutesAgo(m) {
  return new Date(Date.now() - m * 60 * 1000);
}

async function createExpiredEffect(raceId, userId, sourceUserId, powerupId, type, startsAt, expiresAt, metadata) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.raceActiveEffect.create({
    data: {
      raceId,
      targetParticipantId: participant.id,
      targetUserId: userId,
      sourceUserId,
      powerupId,
      type,
      status: "EXPIRED",
      startsAt,
      expiresAt,
      metadata,
    },
  });
}

async function createActiveEffect(raceId, userId, sourceUserId, powerupId, type, startsAt, expiresAt, metadata) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.raceActiveEffect.create({
    data: {
      raceId,
      targetParticipantId: participant.id,
      targetUserId: userId,
      sourceUserId,
      powerupId,
      type,
      status: "ACTIVE",
      startsAt,
      expiresAt,
      metadata,
    },
  });
}

describe("runner's high", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // === CORE MECHANIC ===

  describe("core mechanic", () => {
    it("steps walked during buff window are doubled", async () => {
      const alice = await createUser("AliceHighAAA");
      const bob = await createUser("BobHighAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Activate Runner's High
      const rh = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901);
      const res = await usePowerup(alice.token, raceId, rh.id);
      assert.equal(res.status, 200);

      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "RUNNERS_HIGH" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { startsAt: minutesAgo(20), expiresAt: new Date(Date.now() + 160 * 60 * 1000) },
      });

      // Walk 2000 steps during the buff
      await recordSamples(alice.token, [
        { periodStart: minutesAgo(10).toISOString(), periodEnd: new Date().toISOString(), steps: 2000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      // 2000 base + 2000 buff = 4000
      assert.equal(aliceP.totalSteps, 4000);
    });

    it("steps walked before activation are not doubled", async () => {
      const alice = await createUser("AliceHighBBB");
      const bob = await createUser("BobHighBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Activate Runner's High, then backdate it to 2h ago (expires in 1h)
      const rh = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901);
      await usePowerup(alice.token, raceId, rh.id);
      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "RUNNERS_HIGH" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { startsAt: hoursAgo(2), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
      });

      // Walk steps BEFORE buff (5h-4h ago, before 2h ago start)
      await recordSamples(alice.token, [
        { periodStart: hoursAgo(5).toISOString(), periodEnd: hoursAgo(4).toISOString(), steps: 3000 },
      ]);

      // Walk steps DURING buff (1.5h-1h ago, within 2h ago to +1h)
      await recordSamples(alice.token, [
        { periodStart: hoursAgo(1.5).toISOString(), periodEnd: hoursAgo(1).toISOString(), steps: 1000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      // 3000 (pre-buff, not doubled) + 1000 base + 1000 buff = 5000
      assert.equal(aliceP.totalSteps, 5000);
    });

    it("steps walked after expiry are not doubled", async () => {
      const alice = await createUser("AliceHighCCC");
      const bob = await createUser("BobHighCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);
      await backdateRaceStart(raceId, hoursAgo(6));

      // Create an already-expired Runner's High (ended 1 hour ago)
      const powerup = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901);
      await prisma.racePowerup.update({ where: { id: powerup.id }, data: { status: "USED" } });
      await createExpiredEffect(
        raceId, alice.userId, alice.userId, powerup.id, "RUNNERS_HIGH",
        hoursAgo(4), hoursAgo(1),
        { stepsAtBuffStart: 0, stepsAtExpiry: 0 }
      );

      // Steps during the buff window (4h ago to 1h ago)
      await recordSamples(alice.token, [
        { periodStart: hoursAgo(3).toISOString(), periodEnd: hoursAgo(2).toISOString(), steps: 2000 },
      ]);

      // Steps after expiry (30 min ago)
      await recordSamples(alice.token, [
        { periodStart: minutesAgo(30).toISOString(), periodEnd: new Date().toISOString(), steps: 1000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      // 2000 base + 2000 buff (during window) + 1000 post-expiry (not doubled) = 5000
      assert.equal(aliceP.totalSteps, 5000);
    });
  });

  // === VALIDATION ===

  describe("validation", () => {
    it("self-only — rejects if targetUserId provided", async () => {
      const alice = await createUser("AliceValAAAA");
      const bob = await createUser("BobValAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const rh = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901);
      const res = await usePowerup(alice.token, raceId, rh.id, bob.userId);
      assert.equal(res.status, 400);
    });

    it("cannot stack — rejects second while one is active", async () => {
      const alice = await createUser("AliceValBBBB");
      const bob = await createUser("BobValBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const rh1 = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901);
      const rh2 = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99902);

      await usePowerup(alice.token, raceId, rh1.id);
      const res = await usePowerup(alice.token, raceId, rh2.id);
      assert.equal(res.status, 400);
    });

    it("can use again after first one expires", async () => {
      const alice = await createUser("AliceValCCCC");
      const bob = await createUser("BobValCCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Create an already-expired Runner's High
      const rh1 = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901);
      await usePowerup(alice.token, raceId, rh1.id);

      // Force expiry
      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "RUNNERS_HIGH" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { expiresAt: minutesAgo(1), status: "EXPIRED" },
      });

      // Second one should work
      const rh2 = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99902);
      const res = await usePowerup(alice.token, raceId, rh2.id);
      assert.equal(res.status, 200);
    });
  });

  // === PRORATING (exposes bug) ===

  describe("prorating at window boundaries", () => {
    it("sample overlapping buff start — only portion during buff is doubled", async () => {
      const alice = await createUser("AliceProrAAA");
      const bob = await createUser("BobProrAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Create Runner's High starting 1 hour ago, lasting 3 hours
      const buffStart = hoursAgo(1);
      const buffEnd = new Date(buffStart.getTime() + 3 * 60 * 60 * 1000);
      const powerup = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901);
      await prisma.racePowerup.update({ where: { id: powerup.id }, data: { status: "USED" } });
      const aliceP = await prisma.raceParticipant.findFirst({ where: { raceId, userId: alice.userId } });
      await createActiveEffect(
        raceId, alice.userId, alice.userId, powerup.id, "RUNNERS_HIGH",
        buffStart, buffEnd,
        { stepsAtBuffStart: 0 }
      );

      // Sample: 90min ago to 30min ago (1 hour)
      // Buff started 60min ago, so overlap = 60min-30min = 30min out of 60min sample
      // 1000 steps → 500 should be doubled
      await recordSamples(alice.token, [
        { periodStart: minutesAgo(90).toISOString(), periodEnd: minutesAgo(30).toISOString(), steps: 1000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const aliceEntry = findUser(progress, alice.userId);

      // With correct prorating: base 1000 + buff 500 = 1500
      // Without prorating (current bug): base 1000 + buff 1000 = 2000
      assert.equal(aliceEntry.totalSteps, 1500, "should prorate: only 500 of 1000 steps overlap the buff window");
    });

    it("sample overlapping buff end — only portion during buff is doubled", async () => {
      const alice = await createUser("AliceProrBBB");
      const bob = await createUser("BobProrBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Create expired Runner's High that ended 30 min ago
      const buffStart = hoursAgo(3.5);
      const buffEnd = minutesAgo(30);
      const powerup = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901);
      await prisma.racePowerup.update({ where: { id: powerup.id }, data: { status: "USED" } });
      await createExpiredEffect(
        raceId, alice.userId, alice.userId, powerup.id, "RUNNERS_HIGH",
        buffStart, buffEnd,
        { stepsAtBuffStart: 0, stepsAtExpiry: 0 }
      );

      // Sample: 60min ago to now (1 hour)
      // Buff ended 30min ago, so overlap = 60min-30min = 30min out of 60min
      // 1000 steps → 500 should be doubled
      await recordSamples(alice.token, [
        { periodStart: minutesAgo(60).toISOString(), periodEnd: new Date().toISOString(), steps: 1000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const aliceEntry = findUser(progress, alice.userId);

      // With correct prorating: base 1000 + buff 500 = 1500
      // Without prorating (current bug): base 1000 + buff 1000 = 2000
      assert.equal(aliceEntry.totalSteps, 1500, "should prorate: only 500 of 1000 steps overlap the buff window");
    });
  });

  // === EFFECT INTERACTIONS ===

  describe("effect interactions", () => {
    it("leg cramp during runners high — frozen steps are not doubled", async () => {
      const alice = await createUser("AliceInterAA");
      const bob = await createUser("BobInterAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Alice activates Runner's High
      const rh = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901);
      await usePowerup(alice.token, raceId, rh.id);

      // Bob freezes alice (both effects now overlap)
      const cramp = await giveHeldPowerup(raceId, bob.userId, "LEG_CRAMP", 99902);
      await usePowerup(bob.token, raceId, cramp.id, alice.userId);

      // Backdate both effects to 2h ago so we can place samples inside them
      const effects = await prisma.raceActiveEffect.findMany({ where: { raceId, targetUserId: alice.userId } });
      for (const e of effects) {
        await prisma.raceActiveEffect.update({
          where: { id: e.id },
          data: { startsAt: hoursAgo(2), expiresAt: hoursAgo(0.5) },
        });
      }

      // Alice walks 2000 steps during both effects (1.5h-1h ago)
      await recordSamples(alice.token, [
        { periodStart: hoursAgo(1.5).toISOString(), periodEnd: hoursAgo(1).toISOString(), steps: 2000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      // Leg cramp takes priority — frozen steps should NOT be doubled
      // frozenSteps = 2000, buffedSteps = 2000 - 2000 (overlap dedup) = 0
      // total = 2000 - 2000 + 0 = 0
      assert.equal(aliceP.totalSteps, 0);
    });

    it("wrong turn during runners high — overlapping steps are doubled AND negated", async () => {
      const alice = await createUser("AliceInterBB");
      const bob = await createUser("BobInterBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Alice activates Runner's High
      const rh = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901);
      await usePowerup(alice.token, raceId, rh.id);

      // Bob uses Wrong Turn on alice
      const wt = await giveHeldPowerup(raceId, bob.userId, "WRONG_TURN", 99902);
      await usePowerup(bob.token, raceId, wt.id, alice.userId);

      // Backdate both effects to 2h ago
      const effects = await prisma.raceActiveEffect.findMany({ where: { raceId, targetUserId: alice.userId } });
      for (const e of effects) {
        await prisma.raceActiveEffect.update({
          where: { id: e.id },
          data: { startsAt: hoursAgo(2), expiresAt: hoursAgo(0.5) },
        });
      }

      // Alice walks 1000 steps during both effects (1.5h-1h ago)
      await recordSamples(alice.token, [
        { periodStart: hoursAgo(1.5).toISOString(), periodEnd: hoursAgo(1).toISOString(), steps: 1000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      // Wrong Turn + Runner's High overlap: steps doubled AND negated
      // base = 1000, reversedSteps = 1000, buffedSteps = 1000 - 2*1000 = -1000
      // total = max(0, 1000 + (-1000) - 2*1000) = max(0, -2000) = 0
      assert.equal(aliceP.totalSteps, 0);
    });
  });

  // === OTHER ===

  describe("other", () => {
    it("not blocked by compression socks", async () => {
      const alice = await createUser("AliceOtherAA");
      const bob = await createUser("BobOtherAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Alice has compression socks active
      const shield = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(alice.token, raceId, shield.id);

      // Alice uses Runner's High — should work (self-only, not offensive)
      const rh = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99902);
      const res = await usePowerup(alice.token, raceId, rh.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.ok(!body.result.blocked);
    });

    it("bonus steps from protein shake are not multiplied by runners high", async () => {
      const alice = await createUser("AliceOtherBB");
      const bob = await createUser("BobOtherBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Alice activates Runner's High
      const rh = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901);
      await usePowerup(alice.token, raceId, rh.id);

      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "RUNNERS_HIGH" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { startsAt: minutesAgo(20), expiresAt: new Date(Date.now() + 160 * 60 * 1000) },
      });

      // Alice uses Protein Shake during buff
      const shake = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99902);
      await usePowerup(alice.token, raceId, shake.id);

      // Walk 1000 steps during buff
      await recordSamples(alice.token, [
        { periodStart: minutesAgo(10).toISOString(), periodEnd: new Date().toISOString(), steps: 1000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      // 1000 base + 1000 buff + 1500 bonus (flat, not doubled) = 3500
      assert.equal(aliceP.totalSteps, 3500);
    });

    it("feed shows activation and expiry events", async () => {
      const alice = await createUser("AliceOtherCC");
      const bob = await createUser("BobOtherCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const rh = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901);
      await usePowerup(alice.token, raceId, rh.id);

      // Force expiry
      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "RUNNERS_HIGH" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { expiresAt: minutesAgo(1) },
      });
      await request(server.baseUrl, "POST", "/steps", {
        body: { steps: 1, date: new Date().toISOString().slice(0, 10) },
        token: alice.token,
      });
      await drainRaceResolution();

      const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
      const feedBody = await feedRes.json();

      const useEvent = feedBody.events.find(
        (e) => e.eventType === "POWERUP_USED" && e.powerupType === "RUNNERS_HIGH"
      );
      const expiryEvent = feedBody.events.find(
        (e) => e.eventType === "EFFECT_EXPIRED" && e.powerupType === "RUNNERS_HIGH"
      );
      assert.ok(useEvent, "feed should have activation event");
      assert.ok(expiryEvent, "feed should have expiry event");
    });

    it("late event-time samples admit Runner's High reconciliation without changing its immutable impact", async () => {
      const alice = await createUser("AliceLateRH");
      const bob = await createUser("BobLateRH");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);
      await backdateRaceStart(raceId, hoursAgo(7));
      const powerup = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901);
      await usePowerup(alice.token, raceId, powerup.id);
      const effect = await prisma.raceActiveEffect.findFirstOrThrow({ where: { raceId, type: "RUNNERS_HIGH" } });
      const effectStart = hoursAgo(4);
      const effectEnd = hoursAgo(1);
      await prisma.raceActiveEffect.update({ where: { id: effect.id }, data: { startsAt: effectStart, expiresAt: effectEnd } });
      await recordSamples(alice.token, [{ periodStart: hoursAgo(3.5).toISOString(), periodEnd: hoursAgo(3).toISOString(), steps: 100 }]);
      await drainRaceResolution();
      const before = await prisma.raceImpactEvent.findFirstOrThrow({ where: { raceId, recipientUserId: alice.userId, sourceId: effect.id } });
      await prisma.race.update({ where: { id: raceId }, data: { status: "COMPLETED", endsAt: hoursAgo(0.5), completedAt: hoursAgo(0.5) } });
      const late = [
        { periodStart: hoursAgo(2.5).toISOString(), periodEnd: hoursAgo(2).toISOString(), steps: 500 },
        { periodStart: hoursAgo(2).toISOString(), periodEnd: hoursAgo(1.5).toISOString(), steps: 600 },
        { periodStart: hoursAgo(1.5).toISOString(), periodEnd: hoursAgo(1).toISOString(), steps: 700 },
      ];
      const response = await recordSyncV2(alice.token, late);
      assert.equal(response.status, 202, await response.text());
      const afterVersion = await prisma.userScoringInputVersion.findUniqueOrThrow({ where: { userId: alice.userId } });
      const intent = await prisma.historicalRaceReconciliationIntent.findUniqueOrThrow({ where: { raceId_userId: { raceId, userId: alice.userId } } });
      assert.ok(intent.requestedSourceGeneration <= afterVersion.generation);
      assert.ok(+intent.changedStart <= Date.parse(late[0].periodStart));
      assert.ok(+intent.changedEnd >= Date.parse(late[2].periodEnd));
      assert.equal(await prisma.historicalRaceReconciliationIntent.count({ where: { raceId, userId: alice.userId } }), 1);
      const after = await prisma.raceImpactEvent.findFirstOrThrow({ where: { raceId, recipientUserId: alice.userId, sourceId: effect.id } });
      assert.equal(after.deltaSteps, before.deltaSteps);
      await recordSyncV2(alice.token, late);
      assert.equal(await prisma.historicalRaceReconciliationIntent.count({ where: { raceId, userId: alice.userId } }), 1);
      assert.equal((await prisma.raceImpactEvent.findFirstOrThrow({ where: { raceId, recipientUserId: alice.userId, sourceId: effect.id } })).deltaSteps, before.deltaSteps);
    });

    it("forward-only worker corrects a newly admitted late Runner's High intent", async () => {
      const alice = await createUser("AlicePhase2RH");
      const bob = await createUser("BobPhase2RH");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);
      await backdateRaceStart(raceId, hoursAgo(7));
      const powerup = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99903);
      await usePowerup(alice.token, raceId, powerup.id);
      const effect = await prisma.raceActiveEffect.findFirstOrThrow({ where: { raceId, type: "RUNNERS_HIGH" } });
      const effectStart = hoursAgo(4);
      const effectEnd = hoursAgo(1);
      await prisma.raceActiveEffect.update({ where: { id: effect.id }, data: { startsAt: effectStart, expiresAt: effectEnd } });
      await recordSamples(alice.token, [{ periodStart: hoursAgo(3.5).toISOString(), periodEnd: hoursAgo(3).toISOString(), steps: 100 }]);
      await drainRaceResolution();
      const before = await prisma.raceImpactEvent.findFirstOrThrow({ where: { raceId, recipientUserId: alice.userId, sourceId: effect.id } });
      const participantBefore = await prisma.raceParticipant.findFirstOrThrow({ where: { raceId, userId: alice.userId } });
      await prisma.race.update({ where: { id: raceId }, data: { status: "COMPLETED", endsAt: hoursAgo(0.5), completedAt: hoursAgo(0.5) } });

      const late = [
        { periodStart: hoursAgo(2.5).toISOString(), periodEnd: hoursAgo(2).toISOString(), steps: 500 },
        { periodStart: hoursAgo(2).toISOString(), periodEnd: hoursAgo(1.5).toISOString(), steps: 600 },
        { periodStart: hoursAgo(1.5).toISOString(), periodEnd: hoursAgo(1).toISOString(), steps: 700 },
      ];
      const response = await recordSyncV2(alice.token, late);
      assert.equal(response.status, 202, await response.text());
      const generation = await prisma.userScoringInputVersion.findUniqueOrThrow({ where: { userId: alice.userId } });
      const intent = await prisma.historicalRaceReconciliationIntent.findUniqueOrThrow({ where: { raceId_userId: { raceId, userId: alice.userId } } });
      assert.equal(intent.phase2Eligible, true);
      assert.equal(BigInt(intent.requestedSourceGeneration), BigInt(generation.generation));

      const worker = buildHistoricalRaceReconciliationWorker({
        logger: { log() {}, warn() {}, error(error) { throw error; } },
      });
      const result = await worker.runOnce();
      assert.equal(result.corrected, 1);

      const after = await prisma.raceImpactEvent.findFirstOrThrow({ where: { raceId, recipientUserId: alice.userId, sourceId: effect.id } });
      assert.equal(after.deltaSteps, before.deltaSteps);
      const projection = await prisma.historicalEffectContribution.findUniqueOrThrow({
        where: { raceId_userId_effectId_calculationVersion: { raceId, userId: alice.userId, effectId: effect.id, calculationVersion: 1 } },
      });
      assert.equal(projection.currentDeltaSteps, 1900);
      const participantAfter = await prisma.raceParticipant.findFirstOrThrow({ where: { raceId, userId: alice.userId } });
      assert.equal(participantAfter.totalSteps - participantBefore.totalSteps, projection.currentDeltaSteps - before.deltaSteps);
      assert.equal(await prisma.historicalEffectCorrection.count({ where: { projectionId: projection.id } }), 1);
    });
  });
});

})();


// ---- consolidated from buff-stacking-event-scoring.test.js ----
(function buff_stacking_event_scoring_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");
const { resolveExpiredRaces } = require("../../../src/modules/races/jobs/raceExpiry");
const {
  determineFinishSnapshot,
} = require("../../../src/modules/races/services/raceStateResolution");

// ---------------------------------------------------------------------------
// Buff-stacking (sum) + multiplicative signed event scoring — end-to-end.
// Each scenario walks real steps inside real effect windows and asserts the
// leaderboard total a client would see through GET /races/:id/progress. One
// test per row of the spec §3 worked-example table (100 real steps → the stated
// counted-steps). Samples are placed on CLOSED hour buckets aligned to effect
// windows so proration is exact.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;
let earnCounter = 0;
const HOUR_MS = 60 * 60 * 1000;
const P5 = { "X-Client-Features": "characters,powerups3,powerups4,powerups5" };

// Hour-aligned instant N hours ago (matches giveHourlySamples bucketing).
const alignedHoursAgo = (h) =>
  new Date(Math.floor((Date.now() - h * HOUR_MS) / HOUR_MS) * HOUR_MS);

async function createUser(displayName) {
  const appleId = `apple-bse-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", { body: { identityToken: appleId } });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", { body: { displayName }, token: body.sessionToken });
  return { userId: body.user.id, token: body.sessionToken };
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", { body: { addresseeId: b.userId }, token: a.token });
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, { body: { accept: true }, token: b.token });
}

async function createActiveRace(alice, opponents, opts = {}) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: { name: opts.name || "Buff Stacking Race", targetSteps: 500000, maxDurationDays: 7, powerupsEnabled: true, powerupStepInterval: 5000 },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, { body: { inviteeIds: opponents.map((o) => o.userId) }, token: alice.token });
  for (const o of opponents) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, { body: { accept: true }, token: o.token });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });
  const start = new Date(Date.now() - 8 * HOUR_MS);
  const ends = opts.endsAt !== undefined ? opts.endsAt : new Date(Date.now() + 24 * HOUR_MS);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start, endsAt: ends } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function giveEffect(raceId, targetUserId, sourceUserId, type, { startsAt, expiresAt, metadata } = {}) {
  const p = await participant(raceId, targetUserId);
  const src = await participant(raceId, sourceUserId);
  const pw = await prisma.racePowerup.create({
    data: { raceId, participantId: src.id, userId: sourceUserId, type, rarity: "UNCOMMON", status: "USED", earnedAtSteps: ++earnCounter },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId, targetParticipantId: p.id, targetUserId, sourceUserId, powerupId: pw.id, type, status: "ACTIVE",
      startsAt, expiresAt, metadata: metadata || {},
    },
  });
}

// One closed hourly sample per hour: hours [hoursAgoStart .. hoursAgoStart-hourCount+1].
async function giveHourlySamples(userId, hoursAgoStart, hourCount, stepsPerHour) {
  const now = Date.now();
  for (let i = 0; i < hourCount; i++) {
    const periodStart = new Date(Math.floor((now - (hoursAgoStart - i) * HOUR_MS) / HOUR_MS) * HOUR_MS);
    const periodEnd = new Date(periodStart.getTime() + HOUR_MS);
    await prisma.stepSample.upsert({
      where: { userId_periodStart: { userId, periodStart } },
      update: { steps: stepsPerHour, periodEnd },
      create: { userId, periodStart, periodEnd, steps: stepsPerHour, sourceName: "healthkit" },
    });
  }
}

async function createGlobalEvent({ startsAt, endsAt, multiplier = 2 }) {
  return prisma.globalStepEvent.create({ data: { startsAt, endsAt, multiplier, label: "test 2x event" } });
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token, headers: P5 });
  return (await res.json()).progress;
}
function boardSteps(progress, userId) {
  return (progress.participants || []).find((p) => p.userId === userId)?.totalSteps;
}

})();


// ---- consolidated from powerups-protein-shake.test.js ----
(function powerups_protein_shake_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

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

})();


// ---- consolidated from powerups-second-wind.test.js ----
(function powerups_second_wind_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

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
  const appleId = `apple-sw-${++nextAppleId}`;
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

async function createActiveRaceWith(players, opts = {}) {
  const creator = players[0];
  const others = players.slice(1);
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Second Wind Test",
      targetSteps: opts.targetSteps || 200000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: creator.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((p) => p.userId) },
    token: creator.token,
  });
  for (const other of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: other.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: creator.token });
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
      rarity: "RARE",
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

async function usePowerup(token, raceId, powerupId, targetUserId) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body: targetUserId ? { targetUserId } : {},
    token,
  });
}

function minutesAgo(m) {
  return new Date(Date.now() - m * 60 * 1000);
}

describe("second wind", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // === CORE MECHANIC ===

  describe("core mechanic", () => {
    it("bonus = 25% of gap to leader", async () => {
      const alice = await createUser("AliceWindAAA");
      const bob = await createUser("BobWindAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      // Bob leads with 20000, alice has 12000 → gap = 8000, 25% = 2000
      await giveBonusSteps(raceId, bob.userId, 20000);
      await giveBonusSteps(raceId, alice.userId, 12000);

      const sw = await giveHeldPowerup(raceId, alice.userId, "SECOND_WIND", 99901);
      const res = await usePowerup(alice.token, raceId, sw.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.bonus, 2000);
    });

    it("clamps to minimum 500 when gap is small", async () => {
      const alice = await createUser("AliceWindBBB");
      const bob = await createUser("BobWindBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      // Gap = 100, 25% = 25 → clamp to 500
      await giveBonusSteps(raceId, bob.userId, 5100);
      await giveBonusSteps(raceId, alice.userId, 5000);

      const sw = await giveHeldPowerup(raceId, alice.userId, "SECOND_WIND", 99901);
      const res = await usePowerup(alice.token, raceId, sw.id);
      const body = await res.json();
      assert.equal(body.result.bonus, 500);
    });

    it("clamps to maximum 5000 when gap is huge", async () => {
      const alice = await createUser("AliceWindCCC");
      const bob = await createUser("BobWindCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      // Gap = 50000, 25% = 12500 → clamp to 5000
      await giveBonusSteps(raceId, bob.userId, 51000);
      await giveBonusSteps(raceId, alice.userId, 1000);

      const sw = await giveHeldPowerup(raceId, alice.userId, "SECOND_WIND", 99901);
      const res = await usePowerup(alice.token, raceId, sw.id);
      const body = await res.json();
      assert.equal(body.result.bonus, 5000);
    });

    it("gap calculated against #1 leader in 3+ player race", async () => {
      const alice = await createUser("AliceWindDDD");
      const bob = await createUser("BobWindDDDDD");
      const charlie = await createUser("CharlieWindD");
      await makeFriends(alice, bob);
      await makeFriends(alice, charlie);
      await makeFriends(bob, charlie);
      const raceId = await createActiveRaceWith([alice, bob, charlie]);

      // Charlie leads at 30000, bob at 20000, alice at 10000
      // Alice's gap = 30000 - 10000 = 20000, 25% = 5000 (hits max)
      await giveBonusSteps(raceId, charlie.userId, 30000);
      await giveBonusSteps(raceId, bob.userId, 20000);
      await giveBonusSteps(raceId, alice.userId, 10000);

      const sw = await giveHeldPowerup(raceId, alice.userId, "SECOND_WIND", 99901);
      const res = await usePowerup(alice.token, raceId, sw.id);
      const body = await res.json();
      assert.equal(body.result.bonus, 5000); // gap to #1 charlie, not #2 bob
    });

    it("bonus persists in progress", async () => {
      const alice = await createUser("AliceWindEEE");
      const bob = await createUser("BobWindEEEEE");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      await giveBonusSteps(raceId, bob.userId, 10000);
      await giveBonusSteps(raceId, alice.userId, 2000);

      const sw = await giveHeldPowerup(raceId, alice.userId, "SECOND_WIND", 99901);
      await usePowerup(alice.token, raceId, sw.id);
      // gap = 8000, 25% = 2000

      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      assert.equal(aliceP.totalSteps, 4000); // 2000 original + 2000 bonus
    });
  });

  // === VALIDATION ===

  describe("validation", () => {
    it("cannot use while you are the leader", async () => {
      const alice = await createUser("AliceValAAAA");
      const bob = await createUser("BobValAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      await giveBonusSteps(raceId, alice.userId, 15000);
      await giveBonusSteps(raceId, bob.userId, 5000);

      const sw = await giveHeldPowerup(raceId, alice.userId, "SECOND_WIND", 99901);
      const res = await usePowerup(alice.token, raceId, sw.id);
      assert.equal(res.status, 400);
    });

    it("cannot use when tied for the lead", async () => {
      const alice = await createUser("AliceValBBBB");
      const bob = await createUser("BobValBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      await giveBonusSteps(raceId, alice.userId, 10000);
      await giveBonusSteps(raceId, bob.userId, 10000);

      const sw = await giveHeldPowerup(raceId, alice.userId, "SECOND_WIND", 99901);
      const res = await usePowerup(alice.token, raceId, sw.id);
      assert.equal(res.status, 400);
    });

    it("self-only — rejects if targetUserId provided", async () => {
      const alice = await createUser("AliceValCCCC");
      const bob = await createUser("BobValCCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      await giveBonusSteps(raceId, bob.userId, 10000);
      await giveBonusSteps(raceId, alice.userId, 3000);

      const sw = await giveHeldPowerup(raceId, alice.userId, "SECOND_WIND", 99901);
      const res = await usePowerup(alice.token, raceId, sw.id, bob.userId);
      assert.equal(res.status, 400);
    });
  });

  // === EDGE CASES ===

  describe("edge cases", () => {
    it("multiple second winds stack (no cooldown)", async () => {
      const alice = await createUser("AliceEdgeAAA");
      const bob = await createUser("BobEdgeAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      await giveBonusSteps(raceId, bob.userId, 20000);
      await giveBonusSteps(raceId, alice.userId, 2000);

      // First: gap = 18000, 25% = 4500
      const sw1 = await giveHeldPowerup(raceId, alice.userId, "SECOND_WIND", 99901);
      const res1 = await usePowerup(alice.token, raceId, sw1.id);
      assert.equal((await res1.json()).result.bonus, 4500);

      // Sync totalSteps so second wind sees updated gap
      await getProgress(alice.token, raceId);

      // After first: alice has 6500, gap = 13500, 25% = 3375
      const sw2 = await giveHeldPowerup(raceId, alice.userId, "SECOND_WIND", 99902);
      const res2 = await usePowerup(alice.token, raceId, sw2.id);
      const bonus2 = (await res2.json()).result.bonus;
      assert.equal(bonus2, 3375);

      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      assert.equal(aliceP.totalSteps, 2000 + 4500 + 3375); // 9875
    });

    it("not blocked by compression socks", async () => {
      const alice = await createUser("AliceEdgeCCC");
      const bob = await createUser("BobEdgeCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      await giveBonusSteps(raceId, bob.userId, 10000);
      await giveBonusSteps(raceId, alice.userId, 2000);

      // Alice has a shield — shouldn't matter for self-only powerup
      const shield = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(alice.token, raceId, shield.id);

      const sw = await giveHeldPowerup(raceId, alice.userId, "SECOND_WIND", 99902);
      const res = await usePowerup(alice.token, raceId, sw.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.ok(!body.result.blocked);
      assert.equal(body.result.bonus, 2000); // gap 8000, 25% = 2000
    });
  });

  // === FEED ===

  describe("feed", () => {
    it("shows bonus amount and gap", async () => {
      const alice = await createUser("AliceFeedAAA");
      const bob = await createUser("BobFeedAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      await giveBonusSteps(raceId, bob.userId, 10000);
      await giveBonusSteps(raceId, alice.userId, 2000);

      const sw = await giveHeldPowerup(raceId, alice.userId, "SECOND_WIND", 99901);
      await usePowerup(alice.token, raceId, sw.id);

      const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
      const feedBody = await feedRes.json();

      const event = feedBody.events.find(
        (e) => e.eventType === "POWERUP_USED" && e.powerupType === "SECOND_WIND"
      );
      assert.ok(event, "feed should contain second wind event");
      assert.ok(event.description.includes("Second Wind"));
      assert.ok(event.description.includes("2,000") || event.description.includes("2000"));
    });
  });
});

})();


// ---- consolidated from powerup-usage-state-atomicity.test.js ----
(function powerup_usage_state_atomicity_test_js(){
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { cleanDatabase, prisma, createTestUser } = require("../setup");
const { PowerupUsageState } = require("../../../src/modules/powerups/models/powerupUsageState");

async function fixture() {
  const { user } = await createTestUser({ displayName: "Atomicity owner" });
  const race = await prisma.race.create({ data: {
    creatorId: user.id, name: "Usage state atomicity", status: "ACTIVE", timeBased: true,
    maxDurationDays: 7, targetSteps: 100000, powerupsEnabled: true,
    startedAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 86_400_000), timezone: "UTC",
  } });
  const participant = await prisma.raceParticipant.create({ data: {
    raceId: race.id, userId: user.id, status: "ACCEPTED", totalSteps: 0,
  } });
  const powerup = await prisma.racePowerup.create({ data: {
    raceId: race.id, participantId: participant.id, userId: user.id,
    type: "LEECH", rarity: "RARE", status: "HELD", earnedAtSteps: 1,
  } });
  return { user, race, participant, powerup };
}

describe("power-up usage state transaction authority", () => {
  beforeEach(cleanDatabase);

  it("rolls back usage state and inventory transition together", async () => {
    const f = await fixture();
    await assert.rejects(prisma.$transaction(async (tx) => {
      await PowerupUsageState.upsertUsed({ db: tx, raceId: f.race.id, userId: f.user.id, powerupType: "LEECH",
        lastUsedAt: new Date(), activeUntil: new Date(Date.now() + 3600000), nextUsableAt: new Date(Date.now() + 7200000), sourcePowerupId: f.powerup.id });
      await tx.racePowerup.update({ where: { id: f.powerup.id }, data: { status: "USED", usedAt: new Date() } });
      throw new Error("forced usage-state rollback");
    }), /forced usage-state rollback/);
    assert.equal(await prisma.powerupUsageState.count({ where: { raceId: f.race.id } }), 0);
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: f.powerup.id } })).status, "HELD");
  });

  it("rolls back an effect and usage state together", async () => {
    const f = await fixture();
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.raceActiveEffect.create({ data: {
        raceId: f.race.id, targetParticipantId: f.participant.id, targetUserId: f.user.id,
        sourceUserId: f.user.id, powerupId: f.powerup.id, type: "LEECH", status: "ACTIVE",
        startsAt: new Date(), expiresAt: new Date(Date.now() + 3600000),
      } });
      await PowerupUsageState.upsertUsed({ db: tx, raceId: f.race.id, userId: f.user.id, powerupType: "LEECH",
        lastUsedAt: new Date(), nextUsableAt: new Date(Date.now() + 3600000), sourcePowerupId: f.powerup.id });
      throw new Error("forced effect rollback");
    }), /forced effect rollback/);
    assert.equal(await prisma.raceActiveEffect.count({ where: { raceId: f.race.id } }), 0);
    assert.equal(await prisma.powerupUsageState.count({ where: { raceId: f.race.id } }), 0);
  });

  it("commits usage state, effect, and USED transition together", async () => {
    const f = await fixture();
    await prisma.$transaction(async (tx) => {
      await tx.raceActiveEffect.create({ data: {
        raceId: f.race.id, targetParticipantId: f.participant.id, targetUserId: f.user.id,
        sourceUserId: f.user.id, powerupId: f.powerup.id, type: "LEECH", status: "ACTIVE",
        startsAt: new Date(), expiresAt: new Date(Date.now() + 3600000),
      } });
      await PowerupUsageState.upsertUsed({ db: tx, raceId: f.race.id, userId: f.user.id, powerupType: "LEECH",
        lastUsedAt: new Date(), nextUsableAt: new Date(Date.now() + 3600000), sourcePowerupId: f.powerup.id });
      await tx.racePowerup.update({ where: { id: f.powerup.id }, data: { status: "USED", usedAt: new Date() } });
    });
    assert.equal(await prisma.raceActiveEffect.count({ where: { raceId: f.race.id } }), 1);
    assert.equal(await prisma.powerupUsageState.count({ where: { raceId: f.race.id } }), 1);
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: f.powerup.id } })).status, "USED");
  });
});

})();

// ---- consolidated from pocketwatch-ghost-pepper-probe.test.js ----
(function pocketwatch_ghost_pepper_probe_test_js(){
// §3.3 regression (promoted from the 2026-07-24 empirical probe): legacy Pocket
// Watch only extends effects whose REMAINING tail is favorable to the caster.
// A Ghost Pepper's tail is a burnout FREEZE, so extending it would silently
// lengthen the caster's own freeze — proven by the original probe. The
// favorable-tail filter (isPocketWatchExtendable) now excludes GHOST_PEPPER (and
// losing Coin Flips) in BOTH the validation pre-check and the application loop.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

let server;
let nextAppleId = 0;
const FEATS = { "X-Client-Features": "characters,powerups3,powerups4,powerups5" };

async function createUser(displayName) {
  const appleId = `apple-pwgp-${++nextAppleId}`;
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

async function createActiveRace(alice, bob) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "PW+GP Regression",
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

async function usePowerup(token, raceId, powerupId, body = {}) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body,
    token,
    headers: FEATS,
  });
}

async function activeEffects(raceId, userId) {
  return prisma.raceActiveEffect.findMany({
    where: { raceId, targetUserId: userId, status: "ACTIVE" },
    orderBy: { startsAt: "asc" },
  });
}

describe("§3.3 Pocket Watch × Ghost Pepper favorable-tail filter", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("legacy Pocket Watch does NOT extend a Ghost Pepper but DOES extend a Runner's High in the same call", async () => {
    const alice = await createUser("PW Alice");
    const bob = await createUser("PW Bob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const rh = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 4000);
    const pepper = await giveHeldPowerup(raceId, alice.userId, "GHOST_PEPPER", 5000);
    const watch = await giveHeldPowerup(raceId, alice.userId, "POCKET_WATCH", 10000);

    assert.equal((await usePowerup(alice.token, raceId, rh.id)).status, 200);
    assert.equal((await usePowerup(alice.token, raceId, pepper.id)).status, 200);

    const before = await activeEffects(raceId, alice.userId);
    const pepperBefore = before.find((e) => e.type === "GHOST_PEPPER");
    const rhBefore = before.find((e) => e.type === "RUNNERS_HIGH");
    assert.ok(pepperBefore, "ghost pepper should be active");
    assert.ok(rhBefore, "runner's high should be active");

    const watchRes = await usePowerup(alice.token, raceId, watch.id);
    assert.equal(watchRes.status, 200);
    const watchBody = await watchRes.json();
    // Only the Runner's High was favorable — the pepper is skipped.
    assert.equal(watchBody.result.extendedEffects, 1);

    const after = await activeEffects(raceId, alice.userId);
    const pepperAfter = after.find((e) => e.type === "GHOST_PEPPER");
    const rhAfter = after.find((e) => e.type === "RUNNERS_HIGH");

    assert.equal(
      new Date(pepperAfter.expiresAt).getTime(),
      new Date(pepperBefore.expiresAt).getTime(),
      "Ghost Pepper expiry must be UNCHANGED (its tail is a freeze)"
    );
    assert.ok(
      new Date(rhAfter.expiresAt).getTime() > new Date(rhBefore.expiresAt).getTime(),
      "Runner's High expiry must be extended"
    );
  });

  it("legacy Pocket Watch is REJECTED and NOT consumed when a Ghost Pepper is the only timed effect", async () => {
    const alice = await createUser("PW Alice2");
    const bob = await createUser("PW Bob2");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const pepper = await giveHeldPowerup(raceId, alice.userId, "GHOST_PEPPER", 5000);
    const watch = await giveHeldPowerup(raceId, alice.userId, "POCKET_WATCH", 10000);

    assert.equal((await usePowerup(alice.token, raceId, pepper.id)).status, 200);

    const watchRes = await usePowerup(alice.token, raceId, watch.id);
    assert.equal(watchRes.status, 400);
    assert.match((await watchRes.json()).error, /active timed buff/i);

    // The watch must still be HELD (nothing consumed).
    const stillHeld = await prisma.racePowerup.findUnique({ where: { id: watch.id } });
    assert.equal(stillHeld.status, "HELD");
  });

  it("Campfire Rest stays extendable (its tail is a boost)", async () => {
    const alice = await createUser("PW Alice3");
    const bob = await createUser("PW Bob3");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const campfire = await giveHeldPowerup(raceId, alice.userId, "CAMPFIRE_REST", 4000);
    const watch = await giveHeldPowerup(raceId, alice.userId, "POCKET_WATCH", 10000);

    assert.equal((await usePowerup(alice.token, raceId, campfire.id)).status, 200);

    const before = await activeEffects(raceId, alice.userId);
    const cfBefore = before.find((e) => e.type === "CAMPFIRE_REST");
    assert.ok(cfBefore);

    const watchRes = await usePowerup(alice.token, raceId, watch.id);
    assert.equal(watchRes.status, 200);
    assert.equal((await watchRes.json()).result.extendedEffects, 1);

    const after = await activeEffects(raceId, alice.userId);
    const cfAfter = after.find((e) => e.type === "CAMPFIRE_REST");
    assert.ok(
      new Date(cfAfter.expiresAt).getTime() > new Date(cfBefore.expiresAt).getTime(),
      "Campfire Rest expiry must be extended"
    );
  });

  it("targeted Pocket Watch cannot be pointed at a self Ghost Pepper (rejected, not consumed)", async () => {
    const alice = await createUser("PW Alice4");
    const bob = await createUser("PW Bob4");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const pepper = await giveHeldPowerup(raceId, alice.userId, "GHOST_PEPPER", 5000);
    const watch = await giveHeldPowerup(raceId, alice.userId, "POCKET_WATCH", 10000);

    assert.equal((await usePowerup(alice.token, raceId, pepper.id)).status, 200);
    const pepperEffect = (await activeEffects(raceId, alice.userId)).find(
      (e) => e.type === "GHOST_PEPPER"
    );

    const watchRes = await usePowerup(alice.token, raceId, watch.id, {
      targetEffectId: pepperEffect.id,
    });
    assert.equal(watchRes.status, 400);
    assert.match((await watchRes.json()).error, /debuff you placed on a rival/i);

    const stillHeld = await prisma.racePowerup.findUnique({ where: { id: watch.id } });
    assert.equal(stillHeld.status, "HELD");
  });
});

})();

// ---- consolidated from powerup-cooldown-scope.test.js ----
(function powerup_cooldown_scope_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");
const { cleanDatabase, prisma, request, startServer } = require("../setup");
const { appSettings } = require("../../../src/shared/config/appSettings");
const { PowerupUsageState } = require("../../../src/modules/powerups/models/powerupUsageState");

let server;
let identity = 0;
let clockNow = null;
const HEADERS = { "X-Client-Features": "characters,powerups3" };

async function user(name) {
  const response = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: `cooldown-${++identity}` },
  });
  const body = await response.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName: name }, token: body.sessionToken, headers: HEADERS,
  });
  return { userId: body.user.id, token: body.sessionToken };
}

async function raceWith(owner, opponent) {
  const opponents = Array.isArray(opponent) ? opponent : [opponent];
  for (const participant of opponents) {
    const friendship = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: participant.userId }, token: owner.token, headers: HEADERS,
    });
    await request(server.baseUrl, "PUT", `/friends/request/${(await friendship.json()).friendship.id}`, {
      body: { accept: true }, token: participant.token, headers: HEADERS,
    });
  }
  const created = await request(server.baseUrl, "POST", "/races", {
    body: { name: "Cooldown scope", isPublic: true, targetSteps: 100000,
      maxDurationDays: 7, powerupsEnabled: true, powerupStepInterval: 5000 },
    token: owner.token, headers: HEADERS,
  });
  const raceId = (await created.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: opponents.map((participant) => participant.userId) }, token: owner.token, headers: HEADERS,
  });
  for (const participant of opponents) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true }, token: participant.token, headers: HEADERS,
    });
  }
  const started = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: owner.token, headers: HEADERS,
  });
  assert.equal(started.status, 200);
  return raceId;
}

async function held(raceId, owner, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findUnique({
    where: { raceId_userId: { raceId, userId: owner.userId } },
  });
  return prisma.racePowerup.create({
    data: { raceId, participantId: participant.id, userId: owner.userId,
      type, rarity: "RARE", status: "HELD", earnedAtSteps },
  });
}

async function use(owner, raceId, item, targetUserId) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${item.id}/use`, {
    body: { targetUserId }, token: owner.token, headers: HEADERS,
  });
}

async function redeem(owner, raceId) {
  const response = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/redeem`, {
    body: { powerupType: "LEECH" }, token: owner.token, headers: HEADERS,
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.result?.powerup || body.powerup;
}

async function seedGlobalLeech(userId, quantity) {
  await prisma.userPowerupItem.upsert({
    where: { userId_powerupType: { userId, powerupType: "LEECH" } },
    create: { userId, powerupType: "LEECH", quantity },
    update: { quantity },
  });
}

describe("power-up cooldown scope — HTTP integration", () => {
  before(async () => {
    await appSettings.setFlag("apiRaceBootstrapV1Enabled", true);
    server = await startServer({
      verifyAppleIdentityToken: async (token) => ({ sub: token, email: `${token}@example.com` }),
      now: () => clockNow || new Date(),
    });
  });
  after(async () => {
    await appSettings.setFlag("apiRaceBootstrapV1Enabled", false);
    await server.close();
  });
  beforeEach(async () => { await cleanDatabase(); identity = 0; clockNow = null; });

  it("enforces duration cooldown at the exact HTTP boundary without mutating rejected state", async () => {
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_LEECH" }, update: { active: true }, create: { sku: "POWERUP_LEECH", name: "Leech", priceCoins: 75, powerupType: "LEECH", active: true } });
    const owner = await user("HTTP boundary owner");
    const victim = await user("HTTP boundary victim");
    const raceId = await raceWith(owner, victim);
    const existing = await prisma.powerupUsageState.create({ data: {
      raceId, userId: owner.userId, powerupType: "LEECH",
      lastUsedAt: new Date("2026-09-17T13:00:00.000Z"),
      activeUntil: new Date("2026-09-17T14:00:00.000Z"),
      nextUsableAt: new Date("2026-09-17T15:00:00.000Z"),
    } });
    const heldItem = await held(raceId, owner, "LEECH", 1);
    clockNow = new Date("2026-09-17T14:59:59.999Z");
    const rejected = await use(owner, raceId, heldItem, victim.userId);
    assert.equal(rejected.status, 409);
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: heldItem.id } })).status, "HELD");
    assert.deepEqual(await prisma.powerupUsageState.findUnique({ where: { id: existing.id } }), existing);
    clockNow = new Date("2026-09-17T15:00:00.000Z");
    const accepted = await use(owner, raceId, heldItem, victim.userId);
    assert.equal(accepted.status, 200);
  });

  it("enforces instant cooldown at the exact HTTP boundary", async () => {
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_RAINSTORM" }, update: { active: true }, create: { sku: "POWERUP_RAINSTORM", name: "Rainstorm", priceCoins: 75, powerupType: "RAINSTORM", active: true } });
    const owner = await user("Instant boundary owner");
    const victim = await user("Instant boundary victim");
    const raceId = await raceWith(owner, victim);
    await prisma.powerupUsageState.create({ data: {
      raceId, userId: owner.userId, powerupType: "RAINSTORM",
      lastUsedAt: new Date("2026-09-17T13:00:00.000Z"), nextUsableAt: new Date("2026-09-17T14:00:00.000Z"),
    } });
    const storm = await held(raceId, owner, "RAINSTORM", 1);
    clockNow = new Date("2026-09-17T13:59:59.999Z");
    assert.equal((await use(owner, raceId, storm, undefined)).status, 409);
    clockNow = new Date("2026-09-17T14:00:00.000Z");
    assert.equal((await use(owner, raceId, storm, undefined)).status, 200);
  });

  it("blocks a second same-type use in the same race without consuming it", async () => {
    await prisma.powerupShopItem.upsert({
      where: { sku: "POWERUP_LEECH" },
      update: { active: true },
      create: { sku: "POWERUP_LEECH", name: "Leech", priceCoins: 75,
        powerupType: "LEECH", active: true },
    });
    const owner = await user("Cooldown owner");
    const victim = await user("Cooldown victim");
    const secondVictim = await user("Cooldown second victim");
    const raceId = await raceWith(owner, [victim, secondVictim]);
    const first = await held(raceId, owner, "LEECH", 1);
    const second = await held(raceId, owner, "LEECH", 2);
    assert.equal((await use(owner, raceId, first, victim.userId)).status, 200);
    const rejected = await use(owner, raceId, second, secondVictim.userId);
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, "POWERUP_COOLDOWN");
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: second.id } })).status, "HELD");
    assert.equal(await prisma.powerupUsageState.count({ where: { raceId, userId: owner.userId, powerupType: "LEECH" } }), 1);
  });

  it("keeps same-type cooldown state independent between races", async () => {
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_LEECH" }, update: { active: true }, create: { sku: "POWERUP_LEECH", name: "Leech",
      priceCoins: 75, powerupType: "LEECH", active: true } });
    const owner = await user("Cross race owner");
    const victimA = await user("Victim A");
    const victimB = await user("Victim B");
    const raceA = await raceWith(owner, victimA);
    const raceB = await raceWith(owner, victimB);
    const first = await held(raceA, owner, "LEECH", 1);
    const second = await held(raceB, owner, "LEECH", 1);
    assert.equal((await use(owner, raceA, first, victimA.userId)).status, 200);
    assert.equal((await use(owner, raceB, second, victimB.userId)).status, 200);
    const rows = await prisma.powerupUsageState.findMany({
      where: { userId: owner.userId, powerupType: "LEECH" },
      orderBy: { raceId: "asc" },
    });
    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map((row) => row.raceId)), new Set([raceA, raceB]));
  });

  it("does not let Leech cooldown block a different shop powerup in the same race", async () => {
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_LEECH" }, update: { active: true }, create: { sku: "POWERUP_LEECH", name: "Leech",
      priceCoins: 75, powerupType: "LEECH", active: true } });
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_RAINSTORM" }, update: { active: true }, create: { sku: "POWERUP_RAINSTORM", name: "Rainstorm",
      priceCoins: 75, powerupType: "RAINSTORM", active: true } });
    const owner = await user("Type owner");
    const victim = await user("Type victim");
    const secondVictim = await user("Type second victim");
    const raceId = await raceWith(owner, [victim, secondVictim]);
    const leech = await held(raceId, owner, "LEECH", 1);
    const storm = await held(raceId, owner, "RAINSTORM", 2);
    assert.equal((await use(owner, raceId, leech, victim.userId)).status, 200);
    const stormResponse = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${storm.id}/use`, {
      body: {}, token: owner.token, headers: HEADERS,
    });
    assert.equal(stormResponse.status, 200);
    assert.equal(await prisma.powerupUsageState.count({ where: { raceId, userId: owner.userId } }), 2);
  });

  it("projects only the current race user's cooldown rows in bootstrap", async () => {
    const owner = await user("Projection owner");
    const victimA = await user("Projection A");
    const victimB = await user("Projection B");
    const raceA = await raceWith(owner, victimA);
    const raceB = await raceWith(owner, victimB);
    await prisma.powerupUsageState.create({ data: {
      raceId: raceA, userId: owner.userId, powerupType: "LEECH",
      lastUsedAt: new Date("2026-09-17T12:00:00.000Z"),
      activeUntil: new Date("2026-09-17T14:00:00.000Z"),
      nextUsableAt: new Date("2026-09-17T15:00:00.000Z"),
    } });
    const bootstrap = async (raceId) => request(server.baseUrl, "GET", `/races/${raceId}/bootstrap`, {
      token: owner.token, headers: HEADERS,
    });
    const a = await bootstrap(raceA);
    const b = await bootstrap(raceB);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const aRows = (await a.json()).powerupCooldowns;
    const bRows = (await b.json()).powerupCooldowns;
    assert.equal(aRows.length, 1);
    assert.equal(aRows[0].powerupType, "LEECH");
    assert.deepEqual(bRows, []);
  });

  it("serializes same-race concurrent Leech uses", async () => {
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_LEECH" }, update: { active: true }, create: { sku: "POWERUP_LEECH", name: "Leech", priceCoins: 75, powerupType: "LEECH", active: true } });
    const owner = await user("Concurrent same race owner");
    const victim = await user("Concurrent same race victim");
    const secondVictim = await user("Concurrent same race second victim");
    const raceId = await raceWith(owner, [victim, secondVictim]);
    await seedGlobalLeech(owner.userId, 2);
    const [itemA, itemB] = await Promise.all([redeem(owner, raceId), redeem(owner, raceId)]);
    const responses = await Promise.all([
      use(owner, raceId, itemA, victim.userId),
      use(owner, raceId, itemB, secondVictim.userId),
    ]);
    const successes = responses.filter((response) => response.status === 200);
    assert.equal(successes.length, 1);
    // One redeemed item is consumed by the winner; the losing redeemed item is
    // returned by the existing rejection/refund path.
    assert.equal((await prisma.userPowerupItem.findUnique({ where: { userId_powerupType: { userId: owner.userId, powerupType: "LEECH" } } })).quantity, 1);
    assert.equal(await prisma.powerupUsageState.count({ where: { raceId, userId: owner.userId, powerupType: "LEECH" } }), 1);
  });

  it("allows cross-race concurrent Leech uses with quantity two", async () => {
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_LEECH" }, update: { active: true }, create: { sku: "POWERUP_LEECH", name: "Leech", priceCoins: 75, powerupType: "LEECH", active: true } });
    const owner = await user("Concurrent cross race owner");
    const victimA = await user("Concurrent cross race A");
    const victimB = await user("Concurrent cross race B");
    const raceA = await raceWith(owner, victimA);
    const raceB = await raceWith(owner, victimB);
    await seedGlobalLeech(owner.userId, 2);
    const [itemA, itemB] = await Promise.all([redeem(owner, raceA), redeem(owner, raceB)]);
    const responses = await Promise.all([use(owner, raceA, itemA, victimA.userId), use(owner, raceB, itemB, victimB.userId)]);
    assert.equal(responses.filter((response) => response.status === 200).length, 2);
    assert.equal((await prisma.userPowerupItem.findUnique({ where: { userId_powerupType: { userId: owner.userId, powerupType: "LEECH" } } })).quantity, 0);
    assert.equal(await prisma.powerupUsageState.count({ where: { userId: owner.userId, powerupType: "LEECH" } }), 2);
  });

  it("allows only one cross-race concurrent Leech use with quantity one", async () => {
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_LEECH" }, update: { active: true }, create: { sku: "POWERUP_LEECH", name: "Leech", priceCoins: 75, powerupType: "LEECH", active: true } });
    const owner = await user("Concurrent scarce owner");
    const victimA = await user("Concurrent scarce A");
    const victimB = await user("Concurrent scarce B");
    const raceA = await raceWith(owner, victimA);
    const raceB = await raceWith(owner, victimB);
    await seedGlobalLeech(owner.userId, 1);
    const responses = await Promise.all([
      request(server.baseUrl, "POST", `/races/${raceA}/powerups/redeem`, { body: { powerupType: "LEECH" }, token: owner.token, headers: HEADERS }),
      request(server.baseUrl, "POST", `/races/${raceB}/powerups/redeem`, { body: { powerupType: "LEECH" }, token: owner.token, headers: HEADERS }),
    ]);
    assert.equal(responses.filter((response) => response.status === 200).length, 1);
    assert.equal((await prisma.userPowerupItem.findUnique({ where: { userId_powerupType: { userId: owner.userId, powerupType: "LEECH" } } })).quantity, 0);
    assert.equal(await prisma.powerupUsageState.count({ where: { userId: owner.userId, powerupType: "LEECH" } }), 0);
  });

  it("uses an injected comparison time for exact duration and instant boundaries", async () => {
    const owner = await user("Clock owner");
    const victim = await user("Clock victim");
    const raceId = await raceWith(owner, victim);
    const activeUntil = new Date("2026-09-17T14:00:00.000Z");
    const durationBoundary = new Date("2026-09-17T15:00:00.000Z");
    await prisma.powerupUsageState.create({ data: {
      raceId, userId: owner.userId, powerupType: "LEECH",
      lastUsedAt: new Date("2026-09-17T13:00:00.000Z"), activeUntil,
      nextUsableAt: durationBoundary,
    } });
    assert.ok(await PowerupUsageState.findAvailable(prisma, raceId, owner.userId, "LEECH", new Date(durationBoundary.getTime() - 1)));
    assert.equal(await PowerupUsageState.findAvailable(prisma, raceId, owner.userId, "LEECH", durationBoundary), null);
    await prisma.powerupUsageState.delete({ where: { raceId_userId_powerupType: { raceId, userId: owner.userId, powerupType: "LEECH" } } });
    const instantBoundary = new Date("2026-09-17T14:00:00.000Z");
    await prisma.powerupUsageState.create({ data: {
      raceId, userId: owner.userId, powerupType: "RAINSTORM",
      lastUsedAt: new Date("2026-09-17T13:00:00.000Z"), nextUsableAt: instantBoundary,
    } });
    assert.ok(await PowerupUsageState.findAvailable(prisma, raceId, owner.userId, "RAINSTORM", new Date(instantBoundary.getTime() - 1)));
    assert.equal(await PowerupUsageState.findAvailable(prisma, raceId, owner.userId, "RAINSTORM", instantBoundary), null);
  });
});

})();

// ---- consolidated from powerups-bounty-not-cleansable.test.js ----
(function powerups_bounty_not_cleansable_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

// ---------------------------------------------------------------------------
// BOUNTY is not a debuff — Cleanse and Quick Rinse must never clear it.
//
// A Bounty is a placement WAGER the caster puts on a rival ahead of them: it
// inflicts nothing on the target and settles at race end. But the row lives on
// the TARGET's participant with sourceUserId = caster, targetUserId = target —
// exactly the shape the cleanse selector (`isOpponentInflicted`) uses to mean
// "a debuff someone else put on me". Left unfiltered, the bountied rival could
// spend one Cleanse to erase the caster's stake, and a Quick Rinse could be
// burned on it too (its expiresAt = race end, so it reads as a live timed
// effect).
//
// These run the REAL use-powerup endpoint end to end and assert on what the
// API returns plus the surviving effect row.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-bnty-${++nextAppleId}`;
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

// Bounty requires a race with a fixed end instant (time-based), so this is a
// duration race rather than the step-target races the cleanse suite uses.
async function createActiveRace(alice, bob) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Bounty Cleanse Test",
      timeBased: true,
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
  const start = hoursAgo(8);
  await prisma.race.update({
    where: { id: raceId },
    data: {
      startedAt: start,
      endsAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: start },
  });
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findFirst({
    where: { raceId, userId },
  });
  const rareTypes = ["COMPRESSION_SOCKS", "MIRROR", "CLEANSE", "BOUNTY"];
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: rareTypes.includes(type) ? "RARE" : "UNCOMMON",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function usePowerup(token, raceId, powerupId, targetUserId) {
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/use`,
    {
      body: targetUserId ? { targetUserId } : {},
      token,
      // Wave-5 types are client-feature gated; a powerups5 build is what can
      // cast a Bounty at all.
      headers: { "X-Client-Features": "powerups5" },
    }
  );
}

async function recordSamples(token, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", {
    body: { samples },
    token,
  });
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

function sample(startH, endH, steps) {
  return {
    periodStart: hoursAgo(startH).toISOString(),
    periodEnd: hoursAgo(endH).toISOString(),
    steps,
  };
}

// Alice trails Bob, so Alice can legally place a Bounty on Bob (the wager must
// target a rival AHEAD of the caster). Returns the created BOUNTY effect row.
async function placeBountyOnBob(alice, bob, raceId) {
  // This suite exercises cleanser semantics, not asynchronous score
  // projection. Establish the prerequisite standings deterministically, as
  // the canonical Bounty integration suite does.
  await prisma.raceParticipant.updateMany({
    where: { raceId, userId: bob.userId }, data: { totalSteps: 9000 },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId, userId: alice.userId }, data: { totalSteps: 1000 },
  });
  const bounty = await giveHeldPowerup(raceId, alice.userId, "BOUNTY", 99801);
  const res = await usePowerup(alice.token, raceId, bounty.id, bob.userId);
  assert.equal(res.status, 200, "Alice can place a Bounty on the rival ahead");
  const effect = await prisma.raceActiveEffect.findFirst({
    where: { raceId, type: "BOUNTY" },
  });
  assert.ok(effect, "bounty effect row exists");
  assert.equal(effect.sourceUserId, alice.userId);
  assert.equal(effect.targetUserId, bob.userId);
  return effect;
}

describe("Bounty survives Cleanse and Quick Rinse", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("Cleanse with ONLY a bounty on you is rejected and leaves it ACTIVE", async () => {
    const alice = await createUser("AliceBountyHunter");
    const bob = await createUser("BobBountied");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const bountyEffect = await placeBountyOnBob(alice, bob, raceId);

    // Bob has no real debuffs — only the bounty. Cleanse must reject as
    // "nothing to cleanse" rather than eating Alice's wager.
    const cleanse = await giveHeldPowerup(raceId, bob.userId, "CLEANSE", 99802);
    const res = await usePowerup(bob.token, raceId, cleanse.id);
    assert.equal(res.status, 400, "no cleansable debuff → rejected");

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: bountyEffect.id },
    });
    assert.equal(after.status, "ACTIVE", "bounty is untouched by Cleanse");
    assert.equal(
      after.expiresAt.getTime(),
      bountyEffect.expiresAt.getTime(),
      "bounty window is not truncated"
    );
  });

  it("Cleanse clears real debuffs but not the bounty", async () => {
    const alice = await createUser("AliceBountyHunter2");
    const bob = await createUser("BobBountied2");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const bountyEffect = await placeBountyOnBob(alice, bob, raceId);

    // Alice ALSO leg-cramps Bob — a genuine opponent-inflicted debuff.
    const cramp = await giveHeldPowerup(
      raceId,
      alice.userId,
      "LEG_CRAMP",
      99803
    );
    const crampRes = await usePowerup(
      alice.token,
      raceId,
      cramp.id,
      bob.userId
    );
    assert.equal(crampRes.status, 200);

    const cleanse = await giveHeldPowerup(raceId, bob.userId, "CLEANSE", 99804);
    const res = await usePowerup(bob.token, raceId, cleanse.id);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(
      body.result.cleared,
      1,
      "only the leg cramp is cleared — the bounty is not counted"
    );

    const crampEffect = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "LEG_CRAMP" },
    });
    assert.equal(crampEffect.status, "EXPIRED", "the real debuff is cleared");

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: bountyEffect.id },
    });
    assert.equal(after.status, "ACTIVE", "bounty survives the cleanse");
  });

  it("Quick Rinse with ONLY a bounty on you is rejected and leaves it ACTIVE", async () => {
    const alice = await createUser("AliceBountyHunter3");
    const bob = await createUser("BobBountied3");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const bountyEffect = await placeBountyOnBob(alice, bob, raceId);

    // The bounty row carries expiresAt = race end, so it reads as a LIVE TIMED
    // effect. Quick Rinse must still see nothing to rinse.
    const rinse = await giveHeldPowerup(
      raceId,
      bob.userId,
      "QUICK_RINSE",
      99805
    );
    const res = await usePowerup(bob.token, raceId, rinse.id);
    assert.equal(res.status, 409, "no timed debuffs → NO_TIMED_DEBUFFS");
    const body = await res.json();
    assert.equal(body.code, "NO_TIMED_DEBUFFS");

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: bountyEffect.id },
    });
    assert.equal(after.status, "ACTIVE", "bounty is untouched by Quick Rinse");
  });
});

})();

// ---- consolidated from powerups-campfire-runners-high.test.js ----
(function powerups_campfire_runners_high_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

let server;
let nextAppleId = 0;

const CAMPFIRE_FREEZE_MS = 30 * 60 * 1000;
const CAMPFIRE_MULTIPLIER_LEVEL_0 = 2.25;
const CAMPFIRE_BOOST_DURATION_MS_LEVEL_0 = 45 * 60 * 1000;

async function createUser(displayName) {
  const appleId = `apple-cfrh-${++nextAppleId}`;
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
      name: "Campfire+RH Test",
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
  // Backdate so step samples in past windows fall within the race window
  const defaultStart = new Date(Date.now() - 8 * 60 * 60 * 1000);
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
      status: "USED",
      earnedAtSteps,
    },
  });
}

async function createExpiredEffect(raceId, userId, sourceUserId, powerupId, type, startsAt, expiresAt, metadata) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.raceActiveEffect.create({
    data: {
      raceId,
      targetParticipantId: participant.id,
      targetUserId: userId,
      sourceUserId,
      powerupId,
      type,
      status: "EXPIRED",
      startsAt,
      expiresAt,
      metadata,
    },
  });
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

describe("campfire rest + runner's high overlap", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // Runner's High during the Campfire FREEZE phase should NOT cancel the freeze.
  // Spec (per raceStateResolution.js final-result semantics): freeze wins — steps
  // walked during the freeze are subtracted from the race total.
  it("RH overlapping campfire freeze: freeze still subtracts those steps", async () => {
    const alice = await createUser("AliceCFRH_A1");
    const bob = await createUser("BobCFRH_A111");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // Campfire freeze: 4h ago → 3.5h ago (30 min freeze)
    // Campfire boost: 3.5h ago → 2.75h ago (45 min boost at lvl 0)
    const cfStart = hoursAgo(4);
    const cfFreezeEnd = new Date(cfStart.getTime() + CAMPFIRE_FREEZE_MS);
    const cfBoostEnd = new Date(cfFreezeEnd.getTime() + CAMPFIRE_BOOST_DURATION_MS_LEVEL_0);
    const cfPowerup = await giveHeldPowerup(raceId, alice.userId, "CAMPFIRE_REST", 100001);
    await createExpiredEffect(
      raceId, alice.userId, alice.userId, cfPowerup.id, "CAMPFIRE_REST",
      cfStart, cfBoostEnd,
      {
        freezeMs: CAMPFIRE_FREEZE_MS,
        boostMs: CAMPFIRE_BOOST_DURATION_MS_LEVEL_0,
        multiplier: CAMPFIRE_MULTIPLIER_LEVEL_0,
        stepsAtRestStart: 0,
        stepsAtExpiry: 0,
      },
    );

    // Runner's High wholly inside the campfire freeze: 3h55m ago → 3h35m ago (20 min)
    const rhStart = new Date(cfStart.getTime() + 5 * 60 * 1000);
    const rhEnd = new Date(cfStart.getTime() + 25 * 60 * 1000);
    const rhPowerup = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 100002);
    await createExpiredEffect(
      raceId, alice.userId, alice.userId, rhPowerup.id, "RUNNERS_HIGH",
      rhStart, rhEnd,
      { stepsAtBuffStart: 0, stepsAtExpiry: 0 },
    );

    // 1000 steps inside the RH+freeze overlap (3h50m ago → 3h40m ago)
    await recordSamples(alice.token, [
      {
        periodStart: new Date(cfStart.getTime() + 10 * 60 * 1000).toISOString(),
        periodEnd: new Date(cfStart.getTime() + 20 * 60 * 1000).toISOString(),
        steps: 1000,
      },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    // Spec: 1000 base - 1000 frozen (RH cannot rescue frozen steps) = 0
    assert.equal(
      aliceP.totalSteps,
      0,
      "Runner's High during freeze must not cancel out the freeze",
    );
  });

  // Runner's High during the Campfire BOOST phase should NOT stack with the boost.
  // Spec: take the larger of the two multipliers (max(2x RH, 2.25x campfire) = 2.25x).
  it("RH overlapping campfire boost: takes max multiplier, does not stack", async () => {
    const alice = await createUser("AliceCFRH_B1");
    const bob = await createUser("BobCFRH_B111");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const cfStart = hoursAgo(4);
    const cfFreezeEnd = new Date(cfStart.getTime() + CAMPFIRE_FREEZE_MS);
    const cfBoostEnd = new Date(cfFreezeEnd.getTime() + CAMPFIRE_BOOST_DURATION_MS_LEVEL_0);
    const cfPowerup = await giveHeldPowerup(raceId, alice.userId, "CAMPFIRE_REST", 100001);
    await createExpiredEffect(
      raceId, alice.userId, alice.userId, cfPowerup.id, "CAMPFIRE_REST",
      cfStart, cfBoostEnd,
      {
        freezeMs: CAMPFIRE_FREEZE_MS,
        boostMs: CAMPFIRE_BOOST_DURATION_MS_LEVEL_0,
        multiplier: CAMPFIRE_MULTIPLIER_LEVEL_0,
        stepsAtRestStart: 0,
        stepsAtExpiry: 0,
      },
    );

    // Runner's High wholly inside the campfire boost phase
    const rhStart = new Date(cfFreezeEnd.getTime() + 5 * 60 * 1000);
    const rhEnd = new Date(cfFreezeEnd.getTime() + 25 * 60 * 1000);
    const rhPowerup = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 100002);
    await createExpiredEffect(
      raceId, alice.userId, alice.userId, rhPowerup.id, "RUNNERS_HIGH",
      rhStart, rhEnd,
      { stepsAtBuffStart: 0, stepsAtExpiry: 0 },
    );

    // 1000 steps inside the RH+boost overlap
    await recordSamples(alice.token, [
      {
        periodStart: new Date(cfFreezeEnd.getTime() + 10 * 60 * 1000).toISOString(),
        periodEnd: new Date(cfFreezeEnd.getTime() + 20 * 60 * 1000).toISOString(),
        steps: 1000,
      },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    // 2026-07-23 sum-stacking rule (see buff-stacking spec): campfire 2.25x + RH
    // 2x now SUM to 4.25x → 1000 base + 3250 buff = 4250 (was max(2.25,2)=2250).
    assert.equal(
      aliceP.totalSteps,
      4250,
      "RH stacks additively on campfire boost — 2.25 + 2 = 4.25x",
    );
  });

  // A sample that spans freeze + boost while RH is active for the whole effect
  // window should freeze the freeze-phase steps and apply the larger of the two
  // multipliers (campfire 2.25x) on the boost-phase steps, never both.
  it("RH spanning freeze+boost: freeze portion frozen, boost portion at max multiplier", async () => {
    const alice = await createUser("AliceCFRH_C1");
    const bob = await createUser("BobCFRH_C111");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const cfStart = hoursAgo(4);
    const cfFreezeEnd = new Date(cfStart.getTime() + CAMPFIRE_FREEZE_MS);
    const cfBoostEnd = new Date(cfFreezeEnd.getTime() + CAMPFIRE_BOOST_DURATION_MS_LEVEL_0);
    const cfPowerup = await giveHeldPowerup(raceId, alice.userId, "CAMPFIRE_REST", 100001);
    await createExpiredEffect(
      raceId, alice.userId, alice.userId, cfPowerup.id, "CAMPFIRE_REST",
      cfStart, cfBoostEnd,
      {
        freezeMs: CAMPFIRE_FREEZE_MS,
        boostMs: CAMPFIRE_BOOST_DURATION_MS_LEVEL_0,
        multiplier: CAMPFIRE_MULTIPLIER_LEVEL_0,
        stepsAtRestStart: 0,
        stepsAtExpiry: 0,
      },
    );

    // RH covers the entire campfire window
    const rhPowerup = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 100002);
    await createExpiredEffect(
      raceId, alice.userId, alice.userId, rhPowerup.id, "RUNNERS_HIGH",
      cfStart, cfBoostEnd,
      { stepsAtBuffStart: 0, stepsAtExpiry: 0 },
    );

    // 600 steps fully inside the freeze phase
    await recordSamples(alice.token, [
      {
        periodStart: new Date(cfStart.getTime() + 5 * 60 * 1000).toISOString(),
        periodEnd: new Date(cfStart.getTime() + 15 * 60 * 1000).toISOString(),
        steps: 600,
      },
    ]);
    // 800 steps fully inside the boost phase
    await recordSamples(alice.token, [
      {
        periodStart: new Date(cfFreezeEnd.getTime() + 5 * 60 * 1000).toISOString(),
        periodEnd: new Date(cfFreezeEnd.getTime() + 15 * 60 * 1000).toISOString(),
        steps: 800,
      },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    // 2026-07-23 sum-stacking rule (see buff-stacking spec):
    //   600 base (freeze) - 600 frozen (RH cannot rescue frozen steps) = 0
    // + 800 base (boost) + 800 * (2.25 + 2 - 1) buff = 800 + 2600 = 3400
    // Total = 3400 (was 1800 under max(campfire, RH)).
    assert.equal(
      aliceP.totalSteps,
      3400,
      "freeze-phase steps stay frozen; boost-phase steps get campfire+RH summed (4.25x)",
    );
  });
});

})();

// ---- consolidated from powerups-cleanse-legcramp.test.js ----
(function powerups_cleanse_legcramp_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

// ---------------------------------------------------------------------------
// LEG CRAMP -> CLEANSE -> steps must resume counting
//
// Bug report: "if someone is leg-cramped and then cleanses it, their steps
// aren't counting." A leg cramp freezes steps whose sample timestamps fall in
// the window [startsAt, expiresAt] (getRaceProgress.js). Cleanse is supposed to
// TRUNCATE that window to the cleanse moment (usePowerup.js: status -> EXPIRED
// AND expiresAt -> cleanse time), so steps walked AFTER the cleanse fall outside
// the window and count again. If Cleanse left the original (future) expiresAt in
// place, everything up to the original 2h expiry would stay frozen — that is the
// "steps aren't counting" bug.
//
// This is a regression-lock over a ~3h simulated timeline using the modern
// sample-based path. The real Cleanse command runs and is asserted at the source
// (step 2). Because the real Cleanse stamps expiresAt = now(), we then backdate
// the truncated window into the past so post-cleanse samples can live in the
// realistic past (same timeline manipulation the existing leg-cramp tests use).
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-clz-${++nextAppleId}`;
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
      name: "Cleanse Leg Cramp Test",
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
  // Backdate the race start well before any sample so all samples fall in-window.
  const start = hoursAgo(8);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  const rareTypes = ["COMPRESSION_SOCKS", "MIRROR", "CLEANSE"];
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: rareTypes.includes(type) ? "RARE" : "UNCOMMON",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function recordSamples(token, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", { body: { samples }, token });
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

function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

function sample(startH, endH, steps) {
  return { periodStart: hoursAgo(startH).toISOString(), periodEnd: hoursAgo(endH).toISOString(), steps };
}

describe("cleanse a leg cramp — steps resume counting after cleanse", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {});

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("post-cleanse steps count; during-cramp steps stay frozen", async () => {
    const alice = await createUser("AliceCramper"); // applies the leg cramp
    const bob = await createUser("BobCleanser"); // is cramped, then cleanses
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // (1) Bob walks 2000 steps BEFORE the cramp (6h–5.5h ago).
    await recordSamples(bob.token, [sample(6, 5.5, 2000)]);

    // (2) Alice leg-cramps Bob (real API), then position the cramp window: it
    //     started 3h ago and — left alone — would keep freezing until now.
    const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
    const crampRes = await usePowerup(alice.token, raceId, cramp.id, bob.userId);
    assert.equal(crampRes.status, 200);

    const crampStart = hoursAgo(3);
    const crampOriginalEnd = new Date(Date.now() + 60 * 60 * 1000); // 1h in the FUTURE
    const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEG_CRAMP" } });
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: { startsAt: crampStart, expiresAt: crampOriginalEnd, status: "ACTIVE" },
    });

    // (3) Bob walks 3000 steps DURING the cramp, before cleansing (2.5h–2h ago).
    await recordSamples(bob.token, [sample(2.5, 2, 3000)]);

    // (4) Bob uses Cleanse (real API). This must flip the cramp to EXPIRED and
    //     truncate its expiresAt to the cleanse moment (~now), well before the
    //     original future end.
    const cleanse = await giveHeldPowerup(raceId, bob.userId, "CLEANSE", 99902);
    const cleanseRes = await usePowerup(bob.token, raceId, cleanse.id);
    assert.equal(cleanseRes.status, 200);
    const cleanseBody = await cleanseRes.json();
    assert.equal(cleanseBody.result.cleared, 1, "exactly one opponent debuff cleared");

    // ROOT-CAUSE ASSERTION: cleanse truncated the cramp at the source.
    const afterCleanse = await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } });
    assert.equal(afterCleanse.status, "EXPIRED", "cleanse expires the cramp");
    assert.ok(
      afterCleanse.expiresAt.getTime() < crampOriginalEnd.getTime(),
      "cleanse must pull expiresAt back from the original (future) end to the cleanse moment"
    );

    // Relocate the truncated window into the past so post-cleanse samples can be
    // realistic past samples. The cleanse "happened" 1.5h ago; the real status
    // flip + truncation above already ran and was asserted.
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: { expiresAt: hoursAgo(1.5) },
    });

    // (5) Bob walks 4000 steps AFTER the cleanse (1h–0.5h ago).
    await recordSamples(bob.token, [sample(1, 0.5, 4000)]);

    const progress = await getProgress(alice.token, raceId);
    const bobP = findUser(progress, bob.userId);

    // (3) pre-cramp steps count, (4) during-cramp steps frozen, (5) post-cleanse
    //     steps count → total = 2000 + 4000 = 6000 (the 3000 is frozen).
    // On the un-truncated bug this would be 2000 (post-cleanse 4000 also frozen).
    assert.equal(bobP.totalSteps, 6000, "pre-cramp + post-cleanse count; during-cramp stays frozen");
  });
});

})();

// ---- consolidated from powerups-ghost-pepper-no-stack.test.js ----
(function powerups_ghost_pepper_no_stack_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

// ---------------------------------------------------------------------------
// Only ONE Ghost Pepper at a time.
//
// Ghost Pepper is a two-phase self-buff: 3x for 30 minutes, then a 30-minute
// burnout freeze. Nothing stopped a user from eating a second one, and both
// outcomes of stacking are wrong:
//
//   * Two peppers lit together SUM their multipliers (effectMultiplier.js sums
//     every active buff row — pepper 3 + pepper 3 = 6x), doubling the intended
//     ceiling for anyone holding two.
//   * A pepper eaten during the first one's burnout is simply destroyed —
//     the freeze check runs before the buff sum and returns 0 regardless.
//
// So the second pepper is either an exploit or a coin-burning trap. It must be
// rejected while one is live, and — because Ghost Pepper is a store-bought
// wave-5 item paid for with real coins — the rejected item must stay HELD in
// the race rather than being consumed (the transient "already active" pattern
// used by Rainstorm/Hitchhike/Piggy Bank).
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-ghp-${++nextAppleId}`;
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
      name: "Ghost Pepper Stack Test",
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
  const start = new Date(Date.now() - 8 * 60 * 60 * 1000);
  await prisma.race.update({
    where: { id: raceId },
    data: { startedAt: start },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: start },
  });
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findFirst({
    where: { raceId, userId },
  });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function usePowerup(token, raceId, powerupId) {
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/use`,
    {
      body: {},
      token,
      headers: { "X-Client-Features": "powerups5" },
    }
  );
}

describe("Ghost Pepper cannot be stacked", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("rejects a second pepper during the BOOST phase and keeps it HELD", async () => {
    const alice = await createUser("AlicePepper");
    const bob = await createUser("BobBystander");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const first = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99701
    );
    const firstRes = await usePowerup(alice.token, raceId, first.id);
    assert.equal(firstRes.status, 200, "the first pepper lights normally");

    // Second pepper while the first is still in its 3x boost window.
    const second = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99702
    );
    const secondRes = await usePowerup(alice.token, raceId, second.id);
    assert.equal(secondRes.status, 400, "a second pepper is rejected");

    // Exactly one pepper effect exists — no 3+3=6x window was created.
    const effects = await prisma.raceActiveEffect.findMany({
      where: { raceId, type: "GHOST_PEPPER" },
    });
    assert.equal(effects.length, 1, "only one Ghost Pepper effect exists");

    // The rejected pepper was PAID FOR — it must still be usable later.
    const stillHeld = await prisma.racePowerup.findUnique({
      where: { id: second.id },
    });
    assert.equal(
      stillHeld.status,
      "HELD",
      "the rejected pepper is not consumed"
    );
  });

  it("rejects a second pepper during the BURNOUT freeze phase too", async () => {
    const alice = await createUser("AlicePepper2");
    const bob = await createUser("BobBystander2");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const first = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99703
    );
    assert.equal((await usePowerup(alice.token, raceId, first.id)).status, 200);

    // Advance past the boost into the burnout: backdate startsAt by 40 minutes
    // so the boost (30m) is over but the row is still ACTIVE until 60m.
    const effect = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "GHOST_PEPPER" },
    });
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: {
        startsAt: new Date(Date.now() - 40 * 60 * 1000),
        expiresAt: new Date(Date.now() + 20 * 60 * 1000),
      },
    });

    const second = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99704
    );
    const secondRes = await usePowerup(alice.token, raceId, second.id);
    assert.equal(
      secondRes.status,
      400,
      "a pepper eaten during burnout is rejected, not silently wasted"
    );

    const stillHeld = await prisma.racePowerup.findUnique({
      where: { id: second.id },
    });
    assert.equal(stillHeld.status, "HELD");
  });

  it("allows a new pepper once the previous one has fully expired", async () => {
    const alice = await createUser("AlicePepper3");
    const bob = await createUser("BobBystander3");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const first = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99705
    );
    assert.equal((await usePowerup(alice.token, raceId, first.id)).status, 200);

    // Retire the first pepper the way the expiry job would.
    const effect = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "GHOST_PEPPER" },
    });
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: {
        startsAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        status: "EXPIRED",
      },
    });

    const second = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99706
    );
    const secondRes = await usePowerup(alice.token, raceId, second.id);
    assert.equal(
      secondRes.status,
      200,
      "the guard is transient — a fresh pepper works once the last one ended"
    );

    const effects = await prisma.raceActiveEffect.findMany({
      where: { raceId, type: "GHOST_PEPPER" },
    });
    assert.equal(effects.length, 2, "a second, separate pepper window exists");
  });

  it("a stale ACTIVE row past its window does not block a new pepper", async () => {
    const alice = await createUser("AlicePepper5");
    const bob = await createUser("BobBystander5");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const first = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99709
    );
    assert.equal((await usePowerup(alice.token, raceId, first.id)).status, 200);

    // The expireEffects cron flips status ACTIVE -> EXPIRED, but it runs on a
    // timer. Between the real end of the burnout and that tick, the row is
    // still ACTIVE — the guard must go by the WINDOW, not the status, or a lagging
    // cron would keep the user locked out after their pepper actually wore off.
    const effect = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "GHOST_PEPPER" },
    });
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: {
        startsAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        status: "ACTIVE",
      },
    });

    const second = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99710
    );
    assert.equal(
      (await usePowerup(alice.token, raceId, second.id)).status,
      200,
      "an un-retired but time-expired pepper must not block"
    );
  });

  it("one user's pepper does not block another user's", async () => {
    const alice = await createUser("AlicePepper4");
    const bob = await createUser("BobPepper4");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const alicePepper = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99707
    );
    const bobPepper = await giveHeldPowerup(
      raceId,
      bob.userId,
      "GHOST_PEPPER",
      99708
    );

    assert.equal(
      (await usePowerup(alice.token, raceId, alicePepper.id)).status,
      200
    );
    assert.equal(
      (await usePowerup(bob.token, raceId, bobPepper.id)).status,
      200,
      "the guard is per-participant, not per-race"
    );
  });
});

})();

// ---- consolidated from powerups-rally-flag-not-cleansable.test.js ----
(function powerups_rally_flag_not_cleansable_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");
const { appSettings } = require("../../../src/shared/config/appSettings");

// ---------------------------------------------------------------------------
// Batch 2026-08-09 item 7 — Rally Flag and Uprising are BUFFS, not debuffs.
// Cleanse and Quick Rinse must never clear them.
//
// Root cause this pins: both powerups write ONE EFFECT ROW PER BENEFICIARY via
// upsertBuffWindow, sourced from the caster. So on every teammate EXCEPT the
// caster the row has sourceUserId = caster, targetUserId = teammate — exactly
// the shape `isOpponentInflicted()` reads as "a debuff someone else put on me".
// The caster's own copy is self-sourced and was always safe, which is why the
// bug read as "intermittent": whether your rally buff survived a Cleanse
// depended on whether YOU were the one who raised the flag.
//
// The fix is one entry each in NON_CLEANSABLE_TYPES, which is the shared
// predicate behind BOTH cleanse paths and behind the "nothing to cleanse"
// guards — so this file asserts all three consequences (survival, the 400, and
// the 409) rather than just the removal.
//
// Follows the powerups-bounty-not-cleansable.test.js precedent: real HTTP, real
// DB, real handler chain, real casts. The buff rows under test are produced by
// genuinely casting Uprising / Rally Flag, not hand-inserted, because the
// per-beneficiary fan-out IS the thing that creates the bug.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;
let earnCounter = 0;
const HOUR_MS = 60 * 60 * 1000;

// Rally Flag needs a team-race-capable AND powerups5-capable client.
const HEADERS = { "X-Client-Features": "characters,team_races,powerups5" };

async function createUser(displayName) {
  const appleId = `apple-rally-cleanse-${++nextAppleId}`;
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
    headers: HEADERS,
  });
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
    body: { accept: true },
    token: b.token,
    headers: HEADERS,
  });
}

async function backdate(raceId) {
  const start = new Date(Date.now() - 8 * HOUR_MS);
  await prisma.race.update({
    where: { id: raceId },
    data: { startedAt: start, endsAt: new Date(Date.now() + 24 * HOUR_MS) },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: start },
  });
}

// Ordinary (non-team) race — Uprising's solo bottom-half branch.
async function createSoloRace(creator, opponents) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Rally Cleanse Solo",
      targetSteps: 200000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: creator.token,
    headers: HEADERS,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: opponents.map((o) => o.userId) },
    token: creator.token,
    headers: HEADERS,
  });
  for (const o of opponents) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
      headers: HEADERS,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: creator.token,
    headers: HEADERS,
  });
  await backdate(raceId);
  return raceId;
}

// Started 2v2: alice+bob = TEAM_A, carol+dave = TEAM_B.
async function createTeamRace(alice, bob, carol, dave) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Rally Cleanse Team",
      targetSteps: 200000,
      maxDurationDays: 7,
      isTeamRace: true,
      teamSize: 2,
      isPublic: true,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: alice.token,
    headers: HEADERS,
  });
  const raceId = (await createRes.json()).race.id;
  for (const other of [bob, carol, dave]) await makeFriends(alice, other);
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: [bob.userId, carol.userId, dave.userId] },
    token: alice.token,
    headers: HEADERS,
  });
  for (const [user, team] of [
    [bob, "TEAM_A"],
    [carol, "TEAM_B"],
    [dave, "TEAM_B"],
  ]) {
    const res = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true, team },
      token: user.token,
      headers: HEADERS,
    });
    assert.equal(res.status, 200, `accept for ${team} should succeed`);
  }
  const startRes = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: alice.token,
    headers: HEADERS,
  });
  assert.equal(startRes.status, 200);
  await backdate(raceId);
  return raceId;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function setSteps(raceId, userId, totalSteps) {
  const p = await participant(raceId, userId);
  await prisma.raceParticipant.update({
    where: { id: p.id },
    data: { totalSteps },
  });
}

async function giveHeld(raceId, userId, type, rarity = "RARE") {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity,
      status: "HELD",
      earnedAtSteps: ++earnCounter,
    },
  });
}

async function usePU(token, raceId, powerupId, body = {}) {
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/use`,
    { body, token, headers: HEADERS }
  );
}

async function buffRowFor(raceId, type, userId) {
  const p = await participant(raceId, userId);
  return prisma.raceActiveEffect.findFirst({
    where: { raceId, type, targetParticipantId: p.id },
  });
}

describe("Rally Flag and Uprising survive Cleanse and Quick Rinse", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    await appSettings.setFlag("teamRacesEnabled", true);
  });

  // ── Rally Flag (team race) ────────────────────────────────────────────────

  // Alice raises the flag; Bob is her teammate, so BOB's copy is the
  // caster-sourced row that used to look cleansable.
  async function raisedFlag() {
    const alice = await createUser("AliceFlag");
    const bob = await createUser("BobFlag");
    const carol = await createUser("CarolFlag");
    const dave = await createUser("DaveFlag");
    const raceId = await createTeamRace(alice, bob, carol, dave);

    const flag = await giveHeld(raceId, alice.userId, "RALLY_FLAG", "UNCOMMON");
    const res = await usePU(alice.token, raceId, flag.id);
    assert.equal(res.status, 200, "Alice can raise a Rally Flag in a team race");

    const bobFlag = await buffRowFor(raceId, "RALLY_FLAG", bob.userId);
    assert.ok(bobFlag, "Bob got a Rally Flag row");
    // The exact shape that makes this bug possible: teammate-targeted,
    // caster-sourced. If this ever stops being true the bug is gone for a
    // different reason and these tests would silently stop testing anything.
    assert.equal(bobFlag.sourceUserId, alice.userId);
    assert.equal(bobFlag.targetUserId, bob.userId);
    assert.notEqual(bobFlag.sourceUserId, bobFlag.targetUserId);

    return { alice, bob, carol, dave, raceId, bobFlag };
  }

  it("Cleanse with ONLY a teammate's Rally Flag on you is rejected 400 and leaves it ACTIVE", async () => {
    const { bob, raceId, bobFlag } = await raisedFlag();

    const cleanse = await giveHeld(raceId, bob.userId, "CLEANSE");
    const res = await usePU(bob.token, raceId, cleanse.id);
    assert.equal(res.status, 400, "a rally buff is not a cleansable debuff");
    assert.match((await res.json()).error, /no debuffs to cleanse/i);

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: bobFlag.id },
    });
    assert.equal(after.status, "ACTIVE", "Rally Flag untouched by Cleanse");
    assert.equal(
      after.expiresAt.getTime(),
      bobFlag.expiresAt.getTime(),
      "Rally Flag window is not truncated"
    );
  });

  it("Quick Rinse with ONLY a teammate's Rally Flag on you is rejected 409 NO_TIMED_DEBUFFS", async () => {
    const { bob, raceId, bobFlag } = await raisedFlag();

    const rinse = await giveHeld(raceId, bob.userId, "QUICK_RINSE");
    const res = await usePU(bob.token, raceId, rinse.id);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "NO_TIMED_DEBUFFS");

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: bobFlag.id },
    });
    assert.equal(after.status, "ACTIVE", "Rally Flag untouched by Quick Rinse");
  });

  it("Cleanse clears a real debuff alongside a surviving Rally Flag", async () => {
    const { bob, carol, raceId, bobFlag } = await raisedFlag();

    // Carol (an actual opponent) leg-cramps Bob — a genuine debuff.
    const cramp = await giveHeld(raceId, carol.userId, "LEG_CRAMP", "UNCOMMON");
    const crampRes = await usePU(carol.token, raceId, cramp.id, {
      targetUserId: bob.userId,
    });
    assert.equal(crampRes.status, 200);

    const cleanse = await giveHeld(raceId, bob.userId, "CLEANSE");
    const res = await usePU(bob.token, raceId, cleanse.id);
    assert.equal(res.status, 200);
    assert.equal(
      (await res.json()).result.cleared,
      1,
      "only the leg cramp is cleared — the Rally Flag is not counted"
    );

    const crampEffect = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "LEG_CRAMP" },
    });
    assert.equal(crampEffect.status, "EXPIRED", "the real debuff is cleared");

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: bobFlag.id },
    });
    assert.equal(after.status, "ACTIVE", "Rally Flag survives the cleanse");
  });

  it("the caster's own Rally Flag copy is unaffected too", async () => {
    const { alice, carol, raceId } = await raisedFlag();

    const aliceFlag = await buffRowFor(raceId, "RALLY_FLAG", alice.userId);
    assert.ok(aliceFlag);
    // Self-sourced — this copy was always safe; pinned so a future refactor of
    // the exclusion can't regress it while "fixing" the teammate case.
    assert.equal(aliceFlag.sourceUserId, aliceFlag.targetUserId);

    const cramp = await giveHeld(raceId, carol.userId, "LEG_CRAMP", "UNCOMMON");
    await usePU(carol.token, raceId, cramp.id, { targetUserId: alice.userId });
    const cleanse = await giveHeld(raceId, alice.userId, "CLEANSE");
    const res = await usePU(alice.token, raceId, cleanse.id);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result.cleared, 1);

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: aliceFlag.id },
    });
    assert.equal(after.status, "ACTIVE");
  });

  // ── Uprising (solo race, bottom-half branch) ──────────────────────────────

  // Four runners; Carol (3rd) sparks the Uprising, so beneficiaries are Carol
  // and Dave. DAVE's copy is the caster-sourced one under test.
  async function sparkedUprising() {
    const alice = await createUser("AliceUp");
    const bob = await createUser("BobUp");
    const carol = await createUser("CarolUp");
    const dave = await createUser("DaveUp");
    for (const other of [bob, carol, dave]) await makeFriends(alice, other);
    const raceId = await createSoloRace(alice, [bob, carol, dave]);

    // Standings: alice 8000 > bob 6000 > carol 2000 > dave 1000. Bottom half of
    // four is index 2..3 = carol, dave.
    await setSteps(raceId, alice.userId, 8000);
    await setSteps(raceId, bob.userId, 6000);
    await setSteps(raceId, carol.userId, 2000);
    await setSteps(raceId, dave.userId, 1000);

    const up = await giveHeld(raceId, carol.userId, "UPRISING");
    const res = await usePU(carol.token, raceId, up.id);
    assert.equal(res.status, 200, "Carol is in the bottom half");
    assert.equal((await res.json()).result.affected, 2);

    const daveUp = await buffRowFor(raceId, "UPRISING", dave.userId);
    assert.ok(daveUp, "Dave got an Uprising row");
    assert.equal(daveUp.sourceUserId, carol.userId);
    assert.equal(daveUp.targetUserId, dave.userId);

    return { alice, bob, carol, dave, raceId, daveUp };
  }

  });

})();

// ---- consolidated from powerups-trail-mix.test.js ----
(function powerups_trail_mix_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-tm-${++nextAppleId}`;
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
      name: "Trail Mix Test",
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

function findUser(progress, userId) {
  return progress.participants.find((p) => p.userId === userId);
}

async function usePowerup(token, raceId, powerupId, targetUserId) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body: targetUserId ? { targetUserId } : {},
    token,
  });
}

describe("trail mix", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // === CORE MECHANIC ===

  describe("core mechanic", () => {
    it("first powerup used is trail mix → 1 unique type × 100 = 100 bonus", async () => {
      const alice = await createUser("AliceMixAAAA");
      const bob = await createUser("BobMixAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99901);
      const res = await usePowerup(alice.token, raceId, tm.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.bonus, 100);

      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      assert.equal(aliceP.totalSteps, 100);
    });

    it("used 2 other types before trail mix → 3 × 100 = 300 bonus", async () => {
      const alice = await createUser("AliceMixBBBB");
      const bob = await createUser("BobMixBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Use 2 different powerup types first
      const shake = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
      await usePowerup(alice.token, raceId, shake.id);

      const shortcut = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99902);
      // Bob needs steps for shortcut to work
      const bobP = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
      await prisma.raceParticipant.update({ where: { id: bobP.id }, data: { bonusSteps: 5000, totalSteps: 5000 } });
      await usePowerup(alice.token, raceId, shortcut.id, bob.userId);

      // Now use trail mix
      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99903);
      const res = await usePowerup(alice.token, raceId, tm.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      // PROTEIN_SHAKE + SHORTCUT + TRAIL_MIX = 3 unique × 100 = 300
      assert.equal(body.result.bonus, 300);
    });

    it("using same type twice doesn't double count", async () => {
      const alice = await createUser("AliceMixCCCC");
      const bob = await createUser("BobMixCCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Use two protein shakes
      const s1 = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
      const s2 = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99902);
      await usePowerup(alice.token, raceId, s1.id);
      await usePowerup(alice.token, raceId, s2.id);

      // Trail mix should count only 1 unique type (PROTEIN_SHAKE) + itself
      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99903);
      const res = await usePowerup(alice.token, raceId, tm.id);
      const body = await res.json();
      // PROTEIN_SHAKE (1 unique, not 2) + TRAIL_MIX = 2 × 100 = 200
      assert.equal(body.result.bonus, 200);
    });

    it("multiple trail mixes recalculate with updated unique count", async () => {
      const alice = await createUser("AliceMixDDDD");
      const bob = await createUser("BobMixDDDDDD");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // First trail mix: only itself = 100
      const tm1 = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99901);
      const res1 = await usePowerup(alice.token, raceId, tm1.id);
      assert.equal((await res1.json()).result.bonus, 100);

      // Use a protein shake
      const shake = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99902);
      await usePowerup(alice.token, raceId, shake.id);

      // Second trail mix: TRAIL_MIX + PROTEIN_SHAKE + this TRAIL_MIX = still 2 unique types
      // (TRAIL_MIX is already counted from first use)
      const tm2 = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99903);
      const res2 = await usePowerup(alice.token, raceId, tm2.id);
      // TRAIL_MIX + PROTEIN_SHAKE = 2 unique × 100 = 200
      assert.equal((await res2.json()).result.bonus, 200);
    });
  });

  // === VALIDATION ===

  describe("validation", () => {
    it("self-only — rejects if targetUserId provided", async () => {
      const alice = await createUser("AliceValAAAA");
      const bob = await createUser("BobValAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99901);
      const res = await usePowerup(alice.token, raceId, tm.id, bob.userId);
      assert.equal(res.status, 400);
    });

    it("not blocked by compression socks", async () => {
      const alice = await createUser("AliceValBBBB");
      const bob = await createUser("BobValBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Alice has shield
      const shield = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(alice.token, raceId, shield.id);

      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99902);
      const res = await usePowerup(alice.token, raceId, tm.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.ok(!body.result.blocked);
    });
  });

  // === EDGE CASES ===

  describe("edge cases", () => {
    it("only counts USED powerups, not HELD or DISCARDED", async () => {
      const alice = await createUser("AliceEdgeAAA");
      const bob = await createUser("BobEdgeAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Give alice a held protein shake (not used)
      await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);

      // Give alice a discarded shortcut
      const sc = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99902);
      await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${sc.id}/discard`, { token: alice.token });

      // Trail mix should only count itself (no USED types yet)
      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99903);
      const res = await usePowerup(alice.token, raceId, tm.id);
      assert.equal((await res.json()).result.bonus, 100);
    });

    it("only counts powerups from this race, not other races", async () => {
      const alice = await createUser("AliceEdgeBBB");
      const bob = await createUser("BobEdgeBBBBB");
      const charlie = await createUser("CharlieEdgeB");
      await makeFriends(alice, bob);
      await makeFriends(alice, charlie);

      // Race A: use a protein shake
      const raceA = await createActiveRace(alice, bob);
      const shakeA = await giveHeldPowerup(raceA, alice.userId, "PROTEIN_SHAKE", 99901);
      await usePowerup(alice.token, raceA, shakeA.id);

      // Race B: trail mix should not count Race A's protein shake
      const raceB = await createActiveRace(alice, charlie);
      const tm = await giveHeldPowerup(raceB, alice.userId, "TRAIL_MIX", 99902);
      const res = await usePowerup(alice.token, raceB, tm.id);
      // Only trail mix itself = 100
      assert.equal((await res.json()).result.bonus, 100);
    });

    it("bonus persists in progress", async () => {
      const alice = await createUser("AliceEdgeCCC");
      const bob = await createUser("BobEdgeCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99901);
      await usePowerup(alice.token, raceId, tm.id);

      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      assert.equal(aliceP.totalSteps, 100);

      // Fetch again
      const progress2 = await getProgress(alice.token, raceId);
      const aliceP2 = findUser(progress2, alice.userId);
      assert.equal(aliceP2.totalSteps, 100);
    });
  });

  // === FEED ===

  describe("feed", () => {
    it("shows bonus amount and unique count in event", async () => {
      const alice = await createUser("AliceFeedAAA");
      const bob = await createUser("BobFeedAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Use a protein shake first
      const shake = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
      await usePowerup(alice.token, raceId, shake.id);

      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99902);
      await usePowerup(alice.token, raceId, tm.id);

      const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
      const feedBody = await feedRes.json();

      const event = feedBody.events.find(
        (e) => e.eventType === "POWERUP_USED" && e.powerupType === "TRAIL_MIX"
      );
      assert.ok(event, "feed should contain trail mix event");
      assert.ok(event.description.includes("Trail Mix"));
    });
  });
});

})();

// ---- consolidated from powerups-upgrades.test.js ----
(function powerups_upgrades_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-up-${++nextAppleId}`;
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
      name: "Upgrade Test",
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

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps, rarity = "COMMON") {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity,
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function setUserCoins(userId, coins) {
  await prisma.user.update({ where: { id: userId }, data: { coins } });
}

async function getUserCoins(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return user.coins;
}

async function usePowerup(token, raceId, powerupId, { targetUserId, upgradeLevel } = {}) {
  const body = {};
  if (targetUserId) body.targetUserId = targetUserId;
  if (upgradeLevel != null) body.upgradeLevel = upgradeLevel;
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body,
    token,
  });
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token });
  return (await res.json()).progress;
}

describe("powerup upgrades — integration", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // ---------------------------------------------------------------------
  // Back-compat: existing call shape without upgradeLevel still works
  // ---------------------------------------------------------------------

  it("base use (no upgradeLevel): existing behavior preserved, no coins deducted", async () => {
    const alice = await createUser("AliceUpAA");
    const bob = await createUser("BobUpAAAA");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 1000);

    const powerup = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
    const res = await usePowerup(alice.token, raceId, powerup.id);
    assert.equal(res.status, 200);

    const aliceCoins = await getUserCoins(alice.userId);
    assert.equal(aliceCoins, 1000, "no coins deducted on base use");

    const progress = await getProgress(alice.token, raceId);
    const aliceP = progress.participants.find((p) => p.userId === alice.userId);
    assert.equal(aliceP.totalSteps, 1500, "base 1500 bonus applied");

    // Progress advertises the authoritative upgrade price ladders so clients
    // can display exactly what the server will charge (no stale bundled table).
    // byType is no longer empty as of batch 2026-08-09: the WT/LC duration nerf
    // came with a matching reprice, and the Horseshoe ladder was zeroed when its
    // upgrades became inert. Serving these to the client is the whole point of
    // the block — an old build shows its bundled price, a new one shows this.
    //
    // 2026-08-15: RUNNERS_HIGH, DETOUR_SIGN, and STEALTH_MODE joined the
    // 15-min duration ladder with matching byType overrides.
    assert.deepEqual(progress.powerupData.upgradeCosts, {
      byRarity: {
        COMMON: [0, 5, 15, 45],
        UNCOMMON: [0, 10, 30, 90],
        RARE: [0, 15, 45, 135],
      },
      byType: {
        LEG_CRAMP: [0, 10, 20, 30],
        WRONG_TURN: [0, 15, 30, 45],
        RUNNERS_HIGH: [0, 5, 10, 15],
        DETOUR_SIGN: [0, 5, 10, 15],
        STEALTH_MODE: [0, 10, 20, 30],
        LUCKY_HORSESHOE: [0, 0, 0, 0],
      },
    });
  });

  // ---------------------------------------------------------------------
  // Lvl 2 Protein Shake
  // ---------------------------------------------------------------------

  it("Lvl 2 Protein Shake: 15 coins deducted, +3000 steps, feed shows 'Lvl 2'", async () => {
    const alice = await createUser("AliceUpBB");
    const bob = await createUser("BobUpBBBB");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 500);

    const powerup = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
    const res = await usePowerup(alice.token, raceId, powerup.id, { upgradeLevel: 2 });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.result.upgradeLevel, 2);
    assert.equal(body.result.coinsSpent, 15);

    assert.equal(await getUserCoins(alice.userId), 485);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = progress.participants.find((p) => p.userId === alice.userId);
    assert.equal(aliceP.totalSteps, 3000);

    // CoinTransaction row exists
    const txs = await prisma.coinTransaction.findMany({
      where: { userId: alice.userId, reason: "powerup_upgrade" },
    });
    assert.equal(txs.length, 1);
    assert.equal(txs[0].amount, -15);
    assert.equal(txs[0].refId, powerup.id);

    // PowerupUpgradeEvent row exists
    const ues = await prisma.powerupUpgradeEvent.findMany({
      where: { powerupId: powerup.id },
    });
    assert.equal(ues.length, 1);
    assert.equal(ues[0].tier, 2);
    assert.equal(ues[0].costCoins, 15);
    assert.equal(ues[0].status, "APPLIED");
    assert.equal(ues[0].powerupType, "PROTEIN_SHAKE");

    // RacePowerup column updated
    const updated = await prisma.racePowerup.findUnique({ where: { id: powerup.id } });
    assert.equal(updated.upgradeLevel, 2);
    assert.equal(updated.status, "USED");

    // Feed event includes "Lvl 2" prefix
    const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
    const feed = (await feedRes.json()).events;
    const ev = feed.find((e) => e.eventType === "POWERUP_USED" && e.powerupType === "PROTEIN_SHAKE");
    assert.match(ev.description, /Lvl 2/);
  });

  // ---------------------------------------------------------------------
  // Lvl 3 Leg Cramp on bob — duration becomes 4 hours
  // ---------------------------------------------------------------------

  // Batch 2026-08-09 item 1: L3 Leg Cramp is 30 coins for 1h45m (was 90 for 4h).
  it("Lvl 3 Leg Cramp: 30 coins, freezes target for 1h45m, feed shows 'Lvl 3'", async () => {
    const alice = await createUser("AliceUpCC");
    const bob = await createUser("BobUpCCCC");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 500);

    const powerup = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901, "UNCOMMON");
    const before = Date.now();
    const res = await usePowerup(alice.token, raceId, powerup.id, {
      targetUserId: bob.userId,
      upgradeLevel: 3,
    });
    assert.equal(res.status, 200);

    assert.equal(await getUserCoins(alice.userId), 470);

    const effect = await prisma.raceActiveEffect.findFirst({
      where: { powerupId: powerup.id },
    });
    assert.ok(effect);
    const durationMs = new Date(effect.expiresAt).getTime() - new Date(effect.startsAt).getTime();
    assert.equal(
      durationMs,
      105 * 60 * 1000,
      "expires 1h45m after start"
    );

    const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
    const feed = (await feedRes.json()).events;
    const ev = feed.find((e) => e.eventType === "POWERUP_USED" && e.powerupType === "LEG_CRAMP");
    assert.match(ev.description, /Lvl 3/);
    assert.match(ev.description, /1h 45m/);
  });

  // ---------------------------------------------------------------------
  // Insufficient coins
  // ---------------------------------------------------------------------

  it("Insufficient coins: Lvl 3 attempt → 400, no coin change, powerup stays HELD", async () => {
    const alice = await createUser("AliceUpDD");
    const bob = await createUser("BobUpDDDD");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 10);

    const powerup = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
    const res = await usePowerup(alice.token, raceId, powerup.id, { upgradeLevel: 3 });
    assert.equal(res.status, 400);

    assert.equal(await getUserCoins(alice.userId), 10);

    const updated = await prisma.racePowerup.findUnique({ where: { id: powerup.id } });
    assert.equal(updated.status, "HELD");
    assert.equal(updated.upgradeLevel, 0);

    const ues = await prisma.powerupUpgradeEvent.findMany({ where: { powerupId: powerup.id } });
    assert.equal(ues.length, 0);
  });

  // ---------------------------------------------------------------------
  // Non-upgradeable powerup type
  // ---------------------------------------------------------------------

  it("Reject upgradeLevel>0 on RED_CARD (non-upgradeable): 400, no coin change", async () => {
    const alice = await createUser("AliceUpEE");
    const bob = await createUser("BobUpEEEE");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 1000);

    // Give bob enough steps so red card has a clear leader
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: bob.userId },
      data: { totalSteps: 50000 },
    });

    const powerup = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99901, "RARE");
    const res = await usePowerup(alice.token, raceId, powerup.id, { upgradeLevel: 1 });
    assert.equal(res.status, 400);
    assert.equal(await getUserCoins(alice.userId), 1000);
  });

  // ---------------------------------------------------------------------
  // Out-of-range level
  // ---------------------------------------------------------------------

  it("Reject upgradeLevel=4: 400", async () => {
    const alice = await createUser("AliceUpFF");
    const bob = await createUser("BobUpFFFF");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 1000);

    const powerup = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
    const res = await usePowerup(alice.token, raceId, powerup.id, { upgradeLevel: 4 });
    assert.equal(res.status, 400);
  });

  // ---------------------------------------------------------------------
  // Block by Compression Socks: coins ARE deducted (Wave 2 rule)
  // ---------------------------------------------------------------------

  // Shortcut is RARE now (was pricing off the COMMON ladder): tier 2 = 45, not 15.
  it("Lvl 2 Shortcut blocked by shield: coins deducted (45), no steps stolen, upgrade event = BLOCKED", async () => {
    const alice = await createUser("AliceUpGG");
    const bob = await createUser("BobUpGGGG");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 500);

    // Bob needs non-zero steps for Shortcut to clear validation (zero-step
    // targets are rejected with "nothing to steal" before reaching shield logic).
    // bonusSteps survives resolveRaceState recomputation; totalSteps would be overwritten.
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: bob.userId },
      data: { bonusSteps: 5000, totalSteps: 5000 },
    });

    // Give bob compression socks and activate
    const shield = await giveHeldPowerup(raceId, bob.userId, "COMPRESSION_SOCKS", 99901, "RARE");
    await usePowerup(bob.token, raceId, shield.id);

    // Alice attempts upgraded shortcut against bob
    const sc = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99902);
    const res = await usePowerup(alice.token, raceId, sc.id, {
      targetUserId: bob.userId,
      upgradeLevel: 2,
    });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.result.blocked, true);

    // Coins ARE deducted on block
    assert.equal(await getUserCoins(alice.userId), 455);

    // PowerupUpgradeEvent recorded with status BLOCKED
    const ues = await prisma.powerupUpgradeEvent.findMany({ where: { powerupId: sc.id } });
    assert.equal(ues.length, 1);
    assert.equal(ues[0].status, "BLOCKED");
    assert.equal(ues[0].tier, 2);
    assert.equal(ues[0].costCoins, 45);
  });

  // ---------------------------------------------------------------------
  // Stack rejection — coins not deducted
  // ---------------------------------------------------------------------

  it("Lvl 3 Runner's High rejected when one already active: 400, no coin change", async () => {
    const alice = await createUser("AliceUpHH");
    const bob = await createUser("BobUpHHHH");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 1000);

    // First Runner's High (base)
    const rh1 = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901, "UNCOMMON");
    const r1 = await usePowerup(alice.token, raceId, rh1.id);
    assert.equal(r1.status, 200);

    // Second Runner's High at Lvl 3 should reject without coin change
    const rh2 = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99902, "UNCOMMON");
    const r2 = await usePowerup(alice.token, raceId, rh2.id, { upgradeLevel: 3 });
    assert.equal(r2.status, 400);
    assert.equal(await getUserCoins(alice.userId), 1000);

    // Second powerup must still be HELD
    const after = await prisma.racePowerup.findUnique({ where: { id: rh2.id } });
    assert.equal(after.status, "HELD");
  });

  // ---------------------------------------------------------------------
  // Concurrent purchase race condition (atomic deduct guarantees one wins)
  // ---------------------------------------------------------------------

  it("Two simultaneous Lvl 3 Protein Shakes with only enough coins for one — exactly one succeeds", async () => {
    const alice = await createUser("AliceUpII");
    const bob = await createUser("BobUpIIII");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 45); // exactly enough for ONE Lvl 3

    const p1 = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
    const p2 = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99902);

    const [r1, r2] = await Promise.all([
      usePowerup(alice.token, raceId, p1.id, { upgradeLevel: 3 }),
      usePowerup(alice.token, raceId, p2.id, { upgradeLevel: 3 }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 400], "exactly one succeeds, one fails");

    assert.equal(await getUserCoins(alice.userId), 0);
    const txs = await prisma.coinTransaction.findMany({
      where: { userId: alice.userId, reason: "powerup_upgrade" },
    });
    assert.equal(txs.length, 1, "exactly one CoinTransaction recorded");
  });

  // 2026-08-15: RUNNERS_HIGH, STEALTH_MODE, and DETOUR_SIGN joined the 15-min
  // upgrade ladder. The seed (powerupCopySeed.js) is the served catalog's
  // source of truth, not the DURATIONS_MS table this suite otherwise tests —
  // a duration-table-only edit ships a nerf while every client still
  // advertises the old 2h/3h/4h tier labels. Guards against that drift.
  it("GET /powerups/catalog never advertises a retired 2h+ tier label for the 15-min-ladder types", async () => {
    const {
      POWERUP_COPY_SEED,
    } = require("../../../src/modules/powerups/constants/powerupCopySeed");
    for (const row of POWERUP_COPY_SEED) {
      await prisma.powerupCopy.upsert({
        where: { powerupType: row.powerupType },
        update: {
          description: row.description,
          shortDescription: row.shortDescription,
          upgradeTierLabels: row.upgradeTierLabels,
        },
        create: row,
      });
    }

    const alice = await createUser("AliceCopyGuard");
    const res = await request(server.baseUrl, "GET", "/powerups/catalog", {
      token: alice.token,
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    for (const type of ["RUNNERS_HIGH", "STEALTH_MODE", "DETOUR_SIGN", "LEG_CRAMP", "WRONG_TURN"]) {
      const entry = body.powerups.find((p) => p.type === type);
      assert.ok(entry, `${type} is in the catalog`);
      for (const label of entry.upgradeTierLabels) {
        assert.doesNotMatch(
          label,
          /\b[234]h\b/,
          `${type} tier "${label}" still names a pre-nerf duration`
        );
      }
    }
  });
});

})();

// ---- consolidated from powerups5-wave.test.js ----
(function powerups5_wave_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");
const { resolveExpiredRaces } = require("../../../src/modules/races/jobs/raceExpiry");
const {
  buildRaceResolutionWorkerV2,
} = require("../../../src/modules/races/jobs/raceResolutionQueueV2");
const { appSettings } = require("../../../src/shared/config/appSettings");
const {
  buildExpireEffects,
} = require("../../../src/modules/powerups/commands/expireEffects");

let server;
let nextAppleId = 0;
let earnCounter = 0;
const HOUR_MS = 60 * 60 * 1000;

// Wave-5 store catalog rows (cleanDatabase wipes them). Prices MUST match seed.js.
const WAVE5 = [
  { sku: "POWERUP_GHOST_PEPPER", powerupType: "GHOST_PEPPER", priceCoins: 75 },
  { sku: "POWERUP_COIN_FLIP", powerupType: "COIN_FLIP", priceCoins: 40 },
  { sku: "POWERUP_MYSTERY_POTION", powerupType: "MYSTERY_POTION", priceCoins: 40 },
  { sku: "POWERUP_DECOY", powerupType: "DECOY", priceCoins: 150 },
  { sku: "POWERUP_POWER_OUTAGE", powerupType: "POWER_OUTAGE", priceCoins: 150 },
  { sku: "POWERUP_UMBRELLA", powerupType: "UMBRELLA", priceCoins: 75 },
  { sku: "POWERUP_RALLY_FLAG", powerupType: "RALLY_FLAG", priceCoins: 150 },
  { sku: "POWERUP_PIGGY_BANK", powerupType: "PIGGY_BANK", priceCoins: 40 },
  { sku: "POWERUP_BOUNTY", powerupType: "BOUNTY", priceCoins: 75 },
];
const IMPOSTER_ROW = { sku: "POWERUP_IMPOSTER", powerupType: "IMPOSTER", priceCoins: 75 };

const P5 = { "X-Client-Features": "characters,powerups3,powerups4,powerups5" };
const OLD = { "X-Client-Features": "characters" };

async function seedCatalog() {
  for (const p of [...WAVE5, IMPOSTER_ROW]) {
    await prisma.powerupShopItem.upsert({
      where: { sku: p.sku },
      // testOnly:false in BOTH paths: another integration file may run the real
      // seed (which ships wave-5 rows testOnly:true), and this table is not
      // truncated between files — so force it visible on the prod channel here.
      update: { priceCoins: p.priceCoins, active: true, testOnly: false },
      create: { ...p, name: p.sku, description: `${p.sku} row`, active: true, testOnly: false },
    });
  }
}

async function createUser(displayName, coins = 0) {
  const appleId = `apple-p5-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", { body: { identityToken: appleId } });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", { body: { displayName }, token: body.sessionToken });
  if (coins > 0) await prisma.user.update({ where: { id: body.user.id }, data: { coins } });
  return { userId: body.user.id, token: body.sessionToken };
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", { body: { addresseeId: b.userId }, token: a.token });
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, { body: { accept: true }, token: b.token });
}

async function createActiveRace(alice, opponents, opts = {}) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: { name: opts.name || "P5 Race", targetSteps: 200000, maxDurationDays: 7, powerupsEnabled: true, powerupStepInterval: 5000 },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, { body: { inviteeIds: opponents.map((o) => o.userId) }, token: alice.token });
  for (const o of opponents) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, { body: { accept: true }, token: o.token });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });
  const start = new Date(Date.now() - 8 * HOUR_MS);
  const ends = opts.endsAt !== undefined ? opts.endsAt : new Date(Date.now() + 24 * HOUR_MS);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start, endsAt: ends } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function setSteps(raceId, userId, totalSteps) {
  const p = await participant(raceId, userId);
  await prisma.raceParticipant.update({ where: { id: p.id }, data: { totalSteps } });
}

async function giveHeld(raceId, userId, type, rarity = "UNCOMMON") {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({ data: { raceId, participantId: p.id, userId, type, rarity, status: "HELD", earnedAtSteps: ++earnCounter } });
}

async function giveEffect(raceId, targetUserId, sourceUserId, type, { expiresAt, startsAt, metadata } = {}) {
  const p = await participant(raceId, targetUserId);
  const src = await participant(raceId, sourceUserId);
  const pw = await prisma.racePowerup.create({
    data: { raceId, participantId: src.id, userId: sourceUserId, type, rarity: "UNCOMMON", status: "USED", earnedAtSteps: ++earnCounter },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId, targetParticipantId: p.id, targetUserId, sourceUserId, powerupId: pw.id, type, status: "ACTIVE",
      startsAt: startsAt || new Date(Date.now() - 2 * HOUR_MS),
      expiresAt: expiresAt === undefined ? new Date(Date.now() + HOUR_MS) : expiresAt,
      metadata: metadata || {},
    },
  });
}

async function giveHourlySamples(userId, hoursAgoStart, hourCount, stepsPerHour) {
  const now = Date.now();
  for (let i = 0; i < hourCount; i++) {
    const periodStart = new Date(Math.floor((now - (hoursAgoStart - i) * HOUR_MS) / HOUR_MS) * HOUR_MS);
    const periodEnd = new Date(periodStart.getTime() + HOUR_MS);
    await prisma.stepSample.upsert({
      where: { userId_periodStart: { userId, periodStart } },
      update: { steps: stepsPerHour, periodEnd },
      create: { userId, periodStart, periodEnd, steps: stepsPerHour, sourceName: "healthkit" },
    });
  }
}

async function usePU(token, raceId, powerupId, body = {}, headers = P5) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, { body, token, headers });
}
async function getProgress(token, raceId, headers = P5) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token, headers });
  return (await res.json()).progress;
}
async function drainRaceResolutionJobs(maxJobs = 20) {
  const worker = buildRaceResolutionWorkerV2({ bootAt: 0 });
  for (let index = 0; index < maxJobs; index += 1) {
    if (!(await worker.processOne())) return;
  }
  assert.fail(`race resolution queue did not drain within ${maxJobs} jobs`);
}
async function purchase(token, body, key, headers = P5) {
  return request(server.baseUrl, "POST", "/shop/powerups/purchase", { body, token, headers: { "Idempotency-Key": key, ...headers } });
}
function findEffect(progress, type, userId) {
  return (progress.powerupData?.activeEffects || []).find((e) => e.type === type && (!userId || e.targetUserId === userId));
}
function boardSteps(progress, userId) {
  return (progress.participants || []).find((p) => p.userId === userId)?.totalSteps;
}

describe("powerups5 wave — integration", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    // app_settings persists across test files; pin this suite's payout math
    // to the pre-funded-prize-pools baseline it was written against, rather
    // than relying on whatever an earlier file happened to leave it as.
    await appSettings.setFlag("fundedPrizePoolsEnabled", false);
  });

  // ── 1. Gating matrix ────────────────────────────────────────────────────
  describe("gating", () => {
    it("catalog exposes wave 5 only to capable clients and omits retired Imposter", async () => {
      await seedCatalog();
      const u = await createUser("Cat", 1000);
      const withP5 = await (await request(server.baseUrl, "GET", "/shop/powerups", { token: u.token, headers: P5 })).json();
      const types = withP5.items.map((i) => i.powerupType);
      assert.equal(types.includes("IMPOSTER"), false);
      for (const w of WAVE5) assert.ok(types.includes(w.powerupType), `${w.powerupType} visible with powerups5`);
      const byType = Object.fromEntries(withP5.items.map((i) => [i.powerupType, i]));
      assert.equal(byType.PIGGY_BANK.priceCoins, 40);
      assert.equal(byType.BOUNTY.priceCoins, 75);

      const withoutP5 = await (await request(server.baseUrl, "GET", "/shop/powerups", { token: u.token, headers: OLD })).json();
      const oldTypes = withoutP5.items.map((i) => i.powerupType);
      for (const w of WAVE5) assert.ok(!oldTypes.includes(w.powerupType), `${w.powerupType} hidden from old client`);
      assert.equal(oldTypes.includes("IMPOSTER"), false);
    });

    it("purchase guard: wave-5 purchase from old client → 404", async () => {
      await seedCatalog();
      const u = await createUser("Buyer", 1000);
      const res = await purchase(u.token, { sku: "POWERUP_PIGGY_BANK" }, "p5-old-1", OLD);
      assert.equal(res.status, 404);
      const ok = await purchase(u.token, { sku: "POWERUP_PIGGY_BANK" }, "p5-new-1", P5);
      assert.equal(ok.status, 200);
    });

    it("use of a wave-5 held item from an old client → UPDATE_REQUIRED, stays HELD", async () => {
      await seedCatalog();
      const alice = await createUser("A"); const bob = await createUser("B");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob]);
      const pw = await giveHeld(raceId, alice.userId, "UMBRELLA");
      const res = await usePU(alice.token, raceId, pw.id, {}, OLD);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "UPDATE_REQUIRED");
      assert.equal((await prisma.racePowerup.findUnique({ where: { id: pw.id } })).status, "HELD");
    });

    });

  // ── 2. Uprising ─────────────────────────────────────────────────────────
  // ── 3/4. Coin Flip + settlement parity ──────────────────────────────────
  describe("coin flip", () => {
    it("use returns flip WIN|LOSE and multiplier; effect created", async () => {
      await seedCatalog();
      const a = await createUser("Flipper");
      const b = await createUser("Other");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      const pw = await giveHeld(raceId, a.userId, "COIN_FLIP");
      const res = await usePU(a.token, raceId, pw.id, {});
      assert.equal(res.status, 200);
      const r = (await res.json()).result;
      assert.ok(["WIN", "LOSE"].includes(r.flip));
      assert.equal(r.multiplier, r.flip === "WIN" ? 2 : 0.5);
      assert.ok(r.effect);
    });

    it("seeded COIN_FLIP lose halves in-window steps (settlement matches live)", async () => {
      const a = await createUser("LoserFlip");
      const b = await createUser("Ctrl");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      // 4 closed hourly samples (hours 6..3 ago), 1000 steps each = 4000.
      await giveHourlySamples(a.userId, 6, 4, 1000);
      await giveHourlySamples(b.userId, 6, 4, 1000);
      // Coin-flip lose covering hours 6..2 ago (already expired window, closed).
      await giveEffect(raceId, a.userId, a.userId, "COIN_FLIP", {
        startsAt: new Date(Math.floor((Date.now() - 6 * HOUR_MS) / HOUR_MS) * HOUR_MS),
        expiresAt: new Date(Math.floor((Date.now() - 2 * HOUR_MS) / HOUR_MS) * HOUR_MS),
        metadata: { multiplier: 0.5, stepsAtStart: 0 },
      });
      const live = await getProgress(a.token, raceId);
      const aLive = boardSteps(live, a.userId);
      const bLive = boardSteps(live, b.userId);
      assert.ok(aLive < bLive, `coin-flip lose should reduce steps: ${aLive} < ${bLive}`);

      // Settlement parity: move endsAt to just-now and settle.
      await prisma.race.update({ where: { id: raceId }, data: { endsAt: new Date(Date.now() - 60 * 1000) } });
      await resolveExpiredRaces();
      const settled = await participant(raceId, a.userId);
      assert.equal(settled.totalSteps, aLive, "settled total equals live total (parity)");
    });
  });

  // ── 6. Decoy ────────────────────────────────────────────────────────────
  describe("decoy", () => {
    it("redirects a single-target attack to a third party; REDIRECTED response", async () => {
      const a = await createUser("Attacker"); const b = await createUser("DecoyHolder"); const c = await createUser("Bystander");
      await makeFriends(a, b); await makeFriends(a, c);
      const raceId = await createActiveRace(a, [b, c]);
      await giveEffect(raceId, b.userId, b.userId, "DECOY", { expiresAt: new Date(Date.now() + 24 * HOUR_MS) });
      const legCramp = await giveHeld(raceId, a.userId, "LEG_CRAMP");
      const res = await usePU(a.token, raceId, legCramp.id, { targetUserId: b.userId });
      assert.equal(res.status, 200);
      const r = (await res.json()).result;
      assert.equal(r.outcome, "REDIRECTED");
      assert.equal(r.redirectedBy, "DECOY");
      assert.equal(r.redirectedToUserId, c.userId);
      // The cramp landed on c, not b; decoy consumed.
      const cP = await participant(raceId, c.userId);
      const cramp = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEG_CRAMP", targetParticipantId: cP.id, status: "ACTIVE" } });
      assert.ok(cramp, "redirected cramp on bystander");
      const decoyRow = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "DECOY" } });
      assert.equal(decoyRow.status, "EXPIRED", "decoy consumed");
    });

    it("2-player race: Decoy fizzles as a block (no third party)", async () => {
      const a = await createUser("Attacker2"); const b = await createUser("Solo");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await giveEffect(raceId, b.userId, b.userId, "DECOY", { expiresAt: new Date(Date.now() + 24 * HOUR_MS) });
      const pw = await giveHeld(raceId, a.userId, "LEG_CRAMP");
      const res = await usePU(a.token, raceId, pw.id, { targetUserId: b.userId });
      const r = (await res.json()).result;
      assert.equal(r.blocked, true);
      assert.equal(r.blockedBy, "DECOY");
      const bP = await participant(raceId, b.userId);
      const cramp = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEG_CRAMP", targetParticipantId: bP.id } });
      assert.equal(cramp, null, "no cramp landed");
    });

    it("shop-type attack (does not reflect) is still redirected by Decoy", async () => {
      await seedCatalog();
      const a = await createUser("ShopAtt"); const b = await createUser("DHolder"); const c = await createUser("Third");
      await makeFriends(a, b); await makeFriends(a, c);
      const raceId = await createActiveRace(a, [b, c]);
      await giveEffect(raceId, b.userId, b.userId, "DECOY", { expiresAt: new Date(Date.now() + 24 * HOUR_MS) });
      const jam = await giveHeld(raceId, a.userId, "SIGNAL_JAMMER");
      const res = await usePU(a.token, raceId, jam.id, { targetUserId: b.userId });
      const r = (await res.json()).result;
      assert.equal(r.outcome, "REDIRECTED");
      assert.equal(r.redirectedToUserId, c.userId);
    });
  });

  // ── 7. Power Outage ─────────────────────────────────────────────────────
  describe("power outage", () => {
    async function outageOnVictim() {
      await seedCatalog();
      const attacker = await createUser("OutageCaster");
      const victim = await createUser("OutageVictim");
      await makeFriends(attacker, victim);
      const raceId = await createActiveRace(attacker, [victim]);
      const outage = await giveHeld(raceId, attacker.userId, "POWER_OUTAGE");
      const outageRes = await usePU(attacker.token, raceId, outage.id);
      assert.equal(outageRes.status, 200);
      const victimParticipant = await participant(raceId, victim.userId);
      const outageEffect = await prisma.raceActiveEffect.findFirst({
        where: {
          raceId,
          type: "POWER_OUTAGE",
          targetParticipantId: victimParticipant.id,
          status: "ACTIVE",
        },
      });
      assert.ok(outageEffect, "victim has a live Power Outage");
      return { victim, raceId, outageEffect };
    }

    it("jams all enemies; a jammed enemy can't use powerups; Socks exempt; Umbrella skipped", async () => {
      await seedCatalog();
      const a = await createUser("Outage"); const b = await createUser("Jammed"); const c = await createUser("Socked"); const d = await createUser("Umbrellaed");
      for (const x of [b, c, d]) await makeFriends(a, x);
      const raceId = await createActiveRace(a, [b, c, d]);
      await giveEffect(raceId, c.userId, c.userId, "COMPRESSION_SOCKS", { expiresAt: new Date(Date.now() + HOUR_MS) });
      await giveEffect(raceId, d.userId, d.userId, "UMBRELLA", { expiresAt: new Date(Date.now() + 12 * HOUR_MS) });

      const pw = await giveHeld(raceId, a.userId, "POWER_OUTAGE");
      const res = await usePU(a.token, raceId, pw.id, {});
      assert.equal(res.status, 200);
      const r = (await res.json()).result;
      assert.equal(r.affected, 1, "only b is jammed (c socks, d umbrella)");
      assert.equal(r.blockedCount, 1, "c's socks blocked");

      const bJam = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "POWER_OUTAGE", targetParticipantId: (await participant(raceId, b.userId)).id, status: "ACTIVE" } });
      assert.ok(bJam);
      const dJam = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "POWER_OUTAGE", targetParticipantId: (await participant(raceId, d.userId)).id } });
      assert.equal(dJam, null, "umbrella holder not jammed");
      const umbrella = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "UMBRELLA" } });
      assert.equal(umbrella.status, "ACTIVE", "umbrella not consumed");

      // b (jammed by power outage) cannot use a powerup.
      const shake = await giveHeld(raceId, b.userId, "PROTEIN_SHAKE");
      const blocked = await usePU(b.token, raceId, shake.id, {});
      assert.equal(blocked.status, 409);
    });

    it("Cleanse bypasses a live Power Outage jam and clears the outage", async () => {
      const { victim, raceId, outageEffect } = await outageOnVictim();
      const cleanse = await giveHeld(raceId, victim.userId, "CLEANSE");

      const res = await usePU(victim.token, raceId, cleanse.id);

      assert.equal(res.status, 200);
      assert.equal((await res.json()).result.cleared, 1);
      const after = await prisma.raceActiveEffect.findUnique({
        where: { id: outageEffect.id },
      });
      assert.equal(after.status, "EXPIRED");
      assert.ok(after.expiresAt.getTime() < outageEffect.expiresAt.getTime());
      const usedCleanse = await prisma.racePowerup.findUnique({
        where: { id: cleanse.id },
      });
      assert.equal(usedCleanse.status, "USED");
    });

    it("Quick Rinse bypasses a live Power Outage jam and halves the outage", async () => {
      const { victim, raceId, outageEffect } = await outageOnVictim();
      const rinse = await giveHeld(raceId, victim.userId, "QUICK_RINSE");

      const beforeUse = Date.now();
      const res = await usePU(victim.token, raceId, rinse.id);
      const afterUse = Date.now();

      assert.equal(res.status, 200);
      assert.equal((await res.json()).result.shortened, 1);
      const after = await prisma.raceActiveEffect.findUnique({
        where: { id: outageEffect.id },
      });
      assert.equal(after.status, "ACTIVE");
      const originalExpiry = outageEffect.expiresAt.getTime();
      const earliestExpected = Math.floor((originalExpiry + beforeUse) / 2) - 1;
      const latestExpected = Math.ceil((originalExpiry + afterUse) / 2) + 1;
      assert.ok(
        after.expiresAt.getTime() >= earliestExpected &&
          after.expiresAt.getTime() <= latestExpected,
        "new expiry is the midpoint between the use time and original expiry"
      );
      const usedRinse = await prisma.racePowerup.findUnique({
        where: { id: rinse.id },
      });
      assert.equal(usedRinse.status, "USED");
    });

    it("Signal Jammer still blocks Cleanse when both jam types are live", async () => {
      const { victim, raceId, outageEffect } = await outageOnVictim();
      const staleSignalJammer = await giveEffect(
        raceId,
        victim.userId,
        outageEffect.sourceUserId,
        "SIGNAL_JAMMER",
        { expiresAt: new Date(Date.now() - HOUR_MS) }
      );
      const signalJammer = await giveEffect(
        raceId,
        victim.userId,
        outageEffect.sourceUserId,
        "SIGNAL_JAMMER",
        { expiresAt: new Date(Date.now() + HOUR_MS) }
      );
      const cleanse = await giveHeld(raceId, victim.userId, "CLEANSE");

      const res = await usePU(victim.token, raceId, cleanse.id);

      assert.equal(res.status, 409);
      assert.match((await res.json()).error, /jammed/i);
      const effectsAfter = await prisma.raceActiveEffect.findMany({
        where: {
          id: {
            in: [outageEffect.id, staleSignalJammer.id, signalJammer.id],
          },
        },
      });
      assert.ok(effectsAfter.every((effect) => effect.status === "ACTIVE"));
      const heldCleanse = await prisma.racePowerup.findUnique({
        where: { id: cleanse.id },
      });
      assert.equal(heldCleanse.status, "HELD");
    });
  });

  // ── 8. Rally Flag ───────────────────────────────────────────────────────
  describe("restart-atomic effect expiry", () => {
    it("serializes Fanny expiry before a real Pocket Watch command without an ABBA deadlock", async () => {
      const a = await createUser("Lock Order Packer");
      const b = await createUser("Lock Order Observer");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      const target = await participant(raceId, a.userId);
      await prisma.raceParticipant.update({
        where: { id: target.id },
        data: { powerupSlots: 4 },
      });
      const originalExpiry = new Date(Date.now() + HOUR_MS);
      const effect = await giveEffect(raceId, a.userId, a.userId, "FANNY_PACK", {
        expiresAt: originalExpiry,
      });
      const watch = await giveHeld(raceId, a.userId, "POCKET_WATCH");

      let announceParticipantLock;
      const participantLocked = new Promise((resolve) => {
        announceParticipantLock = resolve;
      });
      let releaseParticipantLock;
      const holdParticipantLock = new Promise((resolve) => {
        releaseParticipantLock = resolve;
      });
      const expireAtBoundary = buildExpireEffects({
        prisma,
        now: () => new Date(originalExpiry.getTime() + 1),
        eventBus: { emit() {} },
        afterFannyParticipantLock: async () => {
          announceParticipantLock();
          await holdParticipantLock;
        },
      });

      const expiryPromise = expireAtBoundary({ raceId });
      await Promise.race([
        participantLocked,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error("Fanny expiry never acquired the participant-first lock")),
          2_000,
        )),
      ]);
      const watchPromise = usePU(a.token, raceId, watch.id);
      releaseParticipantLock();

      await expiryPromise;
      const watchResponse = await watchPromise;
      assert.equal(watchResponse.status, 400);
      assert.match((await watchResponse.json()).error, /active timed buff/i);
      assert.equal((await participant(raceId, a.userId)).powerupSlots, 3);
      assert.equal(
        (await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } })).status,
        "EXPIRED",
      );
      assert.equal(
        (await prisma.racePowerup.findUnique({ where: { id: watch.id } })).status,
        "HELD",
      );
    });

    it("rolls back a killed Fanny Pack expiry and decrements/feed-writes once on retry", async () => {
      const a = await createUser("Atomic Packer");
      const b = await createUser("Atomic Observer");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      const target = await participant(raceId, a.userId);
      await prisma.raceParticipant.update({
        where: { id: target.id },
        data: { powerupSlots: 4 },
      });
      const effect = await giveEffect(raceId, a.userId, a.userId, "FANNY_PACK", {
        expiresAt: new Date(Date.now() - 60_000),
      });
      const task = await prisma.raceResolutionPostTask.create({
        data: {
          raceId,
          sourceGeneration: 999,
          dedupeKey: `atomic-expiry:${raceId}`,
          state: "running",
          requestedAt: new Date(),
          notBeforeAt: new Date(),
          snapshotCommand: { raceId, timeZone: "UTC" },
          payloadBytes: 32,
          intentCount: 0,
          leaseToken: "stale-expiry-lease",
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const killed = buildExpireEffects({
        prisma,
        eventBus: { emit() {} },
        afterEffectConsequenceWrite: async () => {
          throw Object.assign(new Error("simulated process death"), { code: "KILL_POINT" });
        },
      });

      await assert.rejects(() => killed({
        raceId,
        taskFence: { taskId: task.id, leaseToken: "stale-expiry-lease" },
      }), { code: "KILL_POINT" });
      assert.equal((await participant(raceId, a.userId)).powerupSlots, 4);
      assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } })).status, "ACTIVE");
      assert.equal(await prisma.racePowerupEvent.count({
        where: { raceId, eventType: "EFFECT_EXPIRED", powerupType: "FANNY_PACK" },
      }), 0);

      await prisma.raceResolutionPostTask.update({
        where: { id: task.id },
        data: { leaseToken: "fresh-expiry-lease", leaseExpiresAt: new Date(Date.now() + 60_000) },
      });
      const retry = buildExpireEffects({ prisma, eventBus: { emit() {} } });
      await assert.rejects(() => retry({
        raceId,
        taskFence: { taskId: task.id, leaseToken: "stale-expiry-lease" },
      }), { code: "POST_TASK_FENCE_LOST" });
      await retry({
        raceId,
        taskFence: { taskId: task.id, leaseToken: "fresh-expiry-lease" },
      });
      await retry({
        raceId,
        taskFence: { taskId: task.id, leaseToken: "fresh-expiry-lease" },
      });
      assert.equal((await participant(raceId, a.userId)).powerupSlots, 3);
      assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } })).status, "EXPIRED");
      assert.equal(await prisma.racePowerupEvent.count({
        where: { raceId, eventType: "EFFECT_EXPIRED", powerupType: "FANNY_PACK" },
      }), 1);
    });
  });

  describe("rally flag", () => {
    it("rejected 400 outside a team race", async () => {
      await seedCatalog();
      const a = await createUser("Flagger"); const b = await createUser("X");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      const pw = await giveHeld(raceId, a.userId, "RALLY_FLAG");
      const res = await usePU(a.token, raceId, pw.id, {});
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /team race/i);
    });
  });

  // ── 10. Drill Sergeant ──────────────────────────────────────────────────
  // ── 11. Piggy Bank ──────────────────────────────────────────────────────
  describe("piggy bank", () => {
    it("defers the real auth cache invalidation until the atomic expiry commits", async () => {
      const a = await createUser("Deferred Cache Saver");
      const b = await createUser("Deferred Cache Witness");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      const startsAt = new Date(Math.floor((Date.now() - 6 * HOUR_MS) / HOUR_MS) * HOUR_MS);
      const expiresAt = new Date(Math.floor((Date.now() - 2 * HOUR_MS) / HOUR_MS) * HOUR_MS);
      await giveHourlySamples(a.userId, 6, 4, 1500);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt,
        expiresAt,
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });

      const authMeCache = require("../../../src/modules/users/services/authMeCache");
      const originalInvalidate = authMeCache.invalidateSafe;
      const invalidated = [];
      authMeCache.invalidateSafe = async (userId) => { invalidated.push(userId); };
      let consequenceReached = false;
      try {
        const expire = buildExpireEffects({
          prisma,
          eventBus: { emit() {} },
          afterEffectConsequenceWrite: async () => {
            consequenceReached = true;
            assert.deepEqual(
              invalidated,
              [],
              "external cache I/O must not begin while expiry locks are held",
            );
          },
        });
        await expire({ raceId });
      } finally {
        authMeCache.invalidateSafe = originalInvalidate;
      }

      assert.equal(consequenceReached, true);
      assert.deepEqual(invalidated, [a.userId]);
    });

    it("rolls back a killed expiry and retries coin/feed consequences exactly once", async () => {
      const a = await createUser("Atomic Saver");
      const b = await createUser("Atomic Witness");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      const startsAt = new Date(Math.floor((Date.now() - 6 * HOUR_MS) / HOUR_MS) * HOUR_MS);
      const expiresAt = new Date(Math.floor((Date.now() - 2 * HOUR_MS) / HOUR_MS) * HOUR_MS);
      await giveHourlySamples(a.userId, 6, 4, 1500);
      const effect = await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt,
        expiresAt,
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const coinsBefore = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      const killed = buildExpireEffects({
        prisma,
        eventBus: { emit() {} },
        afterEffectConsequenceWrite: async () => {
          throw Object.assign(new Error("simulated process death"), { code: "KILL_POINT" });
        },
      });

      await assert.rejects(() => killed({ raceId }), { code: "KILL_POINT" });
      assert.equal((await prisma.user.findUnique({ where: { id: a.userId } })).coins, coinsBefore);
      assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } })).status, "ACTIVE");
      assert.equal(await prisma.coinTransaction.count({
        where: { userId: a.userId, reason: "piggy_bank", refId: effect.id },
      }), 0);
      assert.equal(await prisma.racePowerupEvent.count({
        where: { raceId, eventType: "EFFECT_EXPIRED", powerupType: "PIGGY_BANK" },
      }), 0);

      const retry = buildExpireEffects({ prisma, eventBus: { emit() {} } });
      await retry({ raceId });
      await retry({ raceId });
      assert.equal((await prisma.user.findUnique({ where: { id: a.userId } })).coins, coinsBefore + 20);
      assert.equal(await prisma.coinTransaction.count({
        where: { userId: a.userId, reason: "piggy_bank", refId: effect.id },
      }), 1);
      assert.equal(await prisma.racePowerupEvent.count({
        where: { raceId, eventType: "EFFECT_EXPIRED", powerupType: "PIGGY_BANK" },
      }), 1);
    });

    it("mints coins at expiry (rate/cap), exactly once", async () => {
      const a = await createUser("Saver");
      const b = await createUser("Z");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      // 4 closed hourly samples of 1500 = 6000 steps in window → floor(6000/300)=20 coins.
      await giveHourlySamples(a.userId, 6, 4, 1500);
      const coinsBefore = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      const eff = await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: new Date(Math.floor((Date.now() - 6 * HOUR_MS) / HOUR_MS) * HOUR_MS),
        expiresAt: new Date(Math.floor((Date.now() - 2 * HOUR_MS) / HOUR_MS) * HOUR_MS),
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const { expireEffects } = require("../../../src/modules/powerups/commands/expireEffects");
      await expireEffects({ raceId });
      const afterOne = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      assert.equal(afterOne - coinsBefore, 20, "20 coins minted");
      // Second run (settlement) is idempotent via refId.
      await prisma.race.update({ where: { id: raceId }, data: { endsAt: new Date(Date.now() - 60 * 1000) } });
      await resolveExpiredRaces();
      const afterTwo = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      assert.equal(afterTwo, afterOne, "no double mint");
      const txns = await prisma.coinTransaction.findMany({ where: { userId: a.userId, reason: "piggy_bank" } });
      assert.equal(txns.length, 1);
    });

    it("only one ACTIVE piggy per user globally (cross-race 409)", async () => {
      await seedCatalog();
      const a = await createUser("MultiSaver"); const b = await createUser("Y"); const c = await createUser("W");
      await makeFriends(a, b); await makeFriends(a, c);
      const race1 = await createActiveRace(a, [b], { name: "Race One" });
      const race2 = await createActiveRace(a, [c], { name: "Race Two" });
      const pw1 = await giveHeld(race1, a.userId, "PIGGY_BANK");
      assert.equal((await usePU(a.token, race1, pw1.id, {})).status, 200);
      const pw2 = await giveHeld(race2, a.userId, "PIGGY_BANK");
      const res = await usePU(a.token, race2, pw2.id, {});
      assert.equal(res.status, 409, "second piggy in another race blocked");
      assert.equal((await prisma.racePowerup.findUnique({ where: { id: pw2.id } })).status, "HELD");
    });
  });

  // ── 11b. Piggy Bank live "banked so far" counter (display-only) ──────────
  // The viewer's OWN active PIGGY_BANK entry in progress carries an additive
  // piggyBank:{bankedCoins,coinCap,windowSteps} computed with the SAME
  // sumStepsInWindow the mint uses over [startsAt, min(expiresAt, now)]. No coin
  // writes, no mint-timing change. See piggy-bank-live-counter-requirements.md.
  describe("piggy bank live counter", () => {
    // hour-aligned start N hours ago (matches giveHourlySamples bucketing).
    const alignedHoursAgo = (h) =>
      new Date(Math.floor((Date.now() - h * HOUR_MS) / HOUR_MS) * HOUR_MS);

    it("owner sees bankedCoins = floor(windowSteps/rate), coinCap, windowSteps", async () => {
      const a = await createUser("LiveSaver");
      const b = await createUser("LZ");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      // 4 closed hourly samples of 1500 = 6000 steps inside the window.
      await giveHourlySamples(a.userId, 6, 4, 1500);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: alignedHoursAgo(6),
        expiresAt: new Date(Date.now() + HOUR_MS), // future → endCap = now
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const prog = await getProgress(a.token, raceId);
      const eff = findEffect(prog, "PIGGY_BANK", a.userId);
      assert.ok(eff, "owner sees their piggy entry");
      assert.ok(eff.piggyBank, "piggyBank field present");
      assert.equal(eff.piggyBank.bankedCoins, 20, "floor(6000/300)=20");
      assert.equal(eff.piggyBank.coinCap, 80, "cap from snapshot");
      assert.ok(
        Math.abs(eff.piggyBank.windowSteps - 6000) <= 100,
        `windowSteps ≈ 6000 (got ${eff.piggyBank.windowSteps})`
      );
      assert.equal(Number.isInteger(eff.piggyBank.windowSteps), true, "windowSteps is int");
    });

    it("clamps bankedCoins to coinCap when steps exceed cap*rate", async () => {
      const a = await createUser("CapSaver");
      const b = await createUser("CZ");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      // 5 × 6000 = 30000 steps → floor(30000/300)=100, clamped to cap 80.
      await giveHourlySamples(a.userId, 6, 5, 6000);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: alignedHoursAgo(6),
        expiresAt: new Date(Date.now() + HOUR_MS),
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const prog = await getProgress(a.token, raceId);
      const eff = findEffect(prog, "PIGGY_BANK", a.userId);
      assert.equal(eff.piggyBank.bankedCoins, 80, "clamped to coinCap");
      assert.equal(eff.piggyBank.coinCap, 80);
    });

    it("excludes steps taken before startsAt", async () => {
      const a = await createUser("EarlySaver");
      const b = await createUser("EZ");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      // Pre-activation sample (now-6h, 9000 steps) must NOT count.
      await giveHourlySamples(a.userId, 6, 1, 9000);
      // In-window samples: now-3h and now-2h, 1500 each = 3000.
      await giveHourlySamples(a.userId, 3, 2, 1500);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: alignedHoursAgo(3),
        expiresAt: new Date(Date.now() + HOUR_MS),
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const prog = await getProgress(a.token, raceId);
      const eff = findEffect(prog, "PIGGY_BANK", a.userId);
      assert.equal(eff.piggyBank.bankedCoins, 10, "floor(3000/300)=10, pre-start excluded");
      assert.ok(
        Math.abs(eff.piggyBank.windowSteps - 3000) <= 100,
        `windowSteps ≈ 3000 (got ${eff.piggyBank.windowSteps})`
      );
    });

    it("kill-switch snapshot (coinCap:0) → entry present, piggyBank absent", async () => {
      const a = await createUser("DeadSaver");
      const b = await createUser("DZ");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await giveHourlySamples(a.userId, 6, 4, 1500);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: alignedHoursAgo(6),
        expiresAt: new Date(Date.now() + HOUR_MS),
        metadata: { stepsPerCoin: 300, coinCap: 0, stepsAtStart: 0 },
      });
      const prog = await getProgress(a.token, raceId);
      const eff = findEffect(prog, "PIGGY_BANK", a.userId);
      assert.ok(eff, "entry still present");
      assert.equal(eff.piggyBank, undefined, "no piggyBank field when nothing will mint");
    });

    it("opponent never sees the owner's piggy entry (HIDDEN_FROM_OPPONENTS holds)", async () => {
      const a = await createUser("HiddenSaver");
      const b = await createUser("HZ");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await giveHourlySamples(a.userId, 6, 4, 1500);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: alignedHoursAgo(6),
        expiresAt: new Date(Date.now() + HOUR_MS),
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const bProg = await getProgress(b.token, raceId);
      assert.equal(findEffect(bProg, "PIGGY_BANK"), undefined, "no piggy entry for opponent");
    });

    it("non-powerups5 client sees no PIGGY_BANK entry at all", async () => {
      const a = await createUser("OldSaver");
      const b = await createUser("OZ");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await giveHourlySamples(a.userId, 6, 4, 1500);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: alignedHoursAgo(6),
        expiresAt: new Date(Date.now() + HOUR_MS),
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const prog = await getProgress(a.token, raceId, OLD);
      assert.equal(findEffect(prog, "PIGGY_BANK"), undefined, "withheld without powerups5");
    });
  });

  // ── 12. Bounty ──────────────────────────────────────────────────────────
  describe("bounty", () => {
    it("must target a rival ahead; pays out when the caster out-places the target; publicly visible", async () => {
      await seedCatalog();
      const a = await createUser("Hunter"); const b = await createUser("Prey");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await setSteps(raceId, a.userId, 3000);
      await setSteps(raceId, b.userId, 9000); // b ahead of a

      // a can't target someone behind: try targeting nobody-ahead is enforced by ahead check.
      const behindPw = await giveHeld(raceId, b.userId, "BOUNTY");
      const behindRes = await usePU(b.token, raceId, behindPw.id, { targetUserId: a.userId });
      assert.equal(behindRes.status, 400, "cannot bounty a rival behind you");

      const pw = await giveHeld(raceId, a.userId, "BOUNTY");
      const ok = await usePU(a.token, raceId, pw.id, { targetUserId: b.userId });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).result.payoutCoins, 150);

      // Bounty is publicly visible to the target.
      const bProg = await getProgress(b.token, raceId);
      assert.ok(findEffect(bProg, "BOUNTY"), "bounty visible to opponent");

      // Now a out-places b. Settlement recomputes totals from step samples, so
      // seed a >> b to make the final placement deterministic.
      await giveHourlySamples(a.userId, 6, 5, 4000); // 20000
      await giveHourlySamples(b.userId, 6, 1, 500);  // 500
      const coinsBefore = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      await prisma.race.update({ where: { id: raceId }, data: { endsAt: new Date(Date.now() - 60 * 1000) } });
      await resolveExpiredRaces();
      const coinsAfter = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      assert.equal(coinsAfter - coinsBefore, 150, "bounty paid on out-place");
      // Idempotent second settle.
      await resolveExpiredRaces();
      const coinsAfter2 = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      assert.equal(coinsAfter2, coinsAfter, "no double bounty payout");
    });

    it("no payout when the caster does NOT out-place the target", async () => {
      await seedCatalog();
      const a = await createUser("Hunter2"); const b = await createUser("Prey2");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await setSteps(raceId, a.userId, 3000);
      await setSteps(raceId, b.userId, 9000);
      const pw = await giveHeld(raceId, a.userId, "BOUNTY");
      await usePU(a.token, raceId, pw.id, { targetUserId: b.userId });
      // b stays ahead at settlement (seed b >> a) → no payout.
      await giveHourlySamples(a.userId, 6, 1, 500);
      await giveHourlySamples(b.userId, 6, 5, 4000);
      const coinsBefore = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      await prisma.race.update({ where: { id: raceId }, data: { endsAt: new Date(Date.now() - 60 * 1000) } });
      await resolveExpiredRaces();
      const coinsAfter = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      assert.equal(coinsAfter, coinsBefore, "no payout when not out-placed");
    });

    it("rejected 400 on a target-step race (no fixed end)", async () => {
      await seedCatalog();
      const a = await createUser("Hunter3"); const b = await createUser("Prey3");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b], { endsAt: null });
      await setSteps(raceId, a.userId, 1000);
      await setSteps(raceId, b.userId, 9000);
      const pw = await giveHeld(raceId, a.userId, "BOUNTY");
      const res = await usePU(a.token, raceId, pw.id, { targetUserId: b.userId });
      assert.equal(res.status, 400);
    });
  });

  // ── 3. Ghost Pepper (not cleansable) ────────────────────────────────────
  describe("ghost pepper", () => {
    it("self-inflicted freeze is not removable by Cleanse", async () => {
      const a = await createUser("Spicy");
      const b = await createUser("Q");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", {
        startsAt: new Date(Date.now() - 10 * 60 * 1000),
        expiresAt: new Date(Date.now() + 50 * 60 * 1000),
        metadata: { boostMs: 30 * 60 * 1000, multiplier: 3, freezeMs: 30 * 60 * 1000, stepsAtBoostStart: 0 },
      });
      const cleanse = await giveHeld(raceId, a.userId, "CLEANSE");
      const res = await usePU(a.token, raceId, cleanse.id, {});
      // Cleanse rejects (no opponent debuffs) — ghost pepper is self-sourced.
      assert.equal(res.status, 400);
      const gp = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "GHOST_PEPPER" } });
      assert.equal(gp.status, "ACTIVE", "ghost pepper survives cleanse");
    });
  });

  // ── 5. Mystery Potion ───────────────────────────────────────────────────
  describe("mystery potion", () => {
    it("resolves to a valid rolled outcome and never fails after consumption", async () => {
      await seedCatalog();
      const a = await createUser("Alchemist", 100); const b = await createUser("Rival");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await setSteps(raceId, b.userId, 5000);
      const pw = await giveHeld(raceId, a.userId, "MYSTERY_POTION");
      const res = await usePU(a.token, raceId, pw.id, {});
      assert.equal(res.status, 200);
      const r = (await res.json()).result;
      assert.ok(r.rolled, "a rolled outcome is reported");
      assert.equal((await prisma.racePowerup.findUnique({ where: { id: pw.id } })).status, "USED");
    });
  });
});

})();

// ---- consolidated from powerups-cleanse-legcramp.test.js ----
(function powerups_cleanse_legcramp_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

// ---------------------------------------------------------------------------
// LEG CRAMP -> CLEANSE -> steps must resume counting
//
// Bug report: "if someone is leg-cramped and then cleanses it, their steps
// aren't counting." A leg cramp freezes steps whose sample timestamps fall in
// the window [startsAt, expiresAt] (getRaceProgress.js). Cleanse is supposed to
// TRUNCATE that window to the cleanse moment (usePowerup.js: status -> EXPIRED
// AND expiresAt -> cleanse time), so steps walked AFTER the cleanse fall outside
// the window and count again. If Cleanse left the original (future) expiresAt in
// place, everything up to the original 2h expiry would stay frozen — that is the
// "steps aren't counting" bug.
//
// This is a regression-lock over a ~3h simulated timeline using the modern
// sample-based path. The real Cleanse command runs and is asserted at the source
// (step 2). Because the real Cleanse stamps expiresAt = now(), we then backdate
// the truncated window into the past so post-cleanse samples can live in the
// realistic past (same timeline manipulation the existing leg-cramp tests use).
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-clz-${++nextAppleId}`;
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
      name: "Cleanse Leg Cramp Test",
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
  // Backdate the race start well before any sample so all samples fall in-window.
  const start = hoursAgo(8);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  const rareTypes = ["COMPRESSION_SOCKS", "MIRROR", "CLEANSE"];
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: rareTypes.includes(type) ? "RARE" : "UNCOMMON",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function recordSamples(token, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", { body: { samples }, token });
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

function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

function sample(startH, endH, steps) {
  return { periodStart: hoursAgo(startH).toISOString(), periodEnd: hoursAgo(endH).toISOString(), steps };
}

describe("cleanse a leg cramp — steps resume counting after cleanse", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {});

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("post-cleanse steps count; during-cramp steps stay frozen", async () => {
    const alice = await createUser("AliceCramper"); // applies the leg cramp
    const bob = await createUser("BobCleanser"); // is cramped, then cleanses
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // (1) Bob walks 2000 steps BEFORE the cramp (6h–5.5h ago).
    await recordSamples(bob.token, [sample(6, 5.5, 2000)]);

    // (2) Alice leg-cramps Bob (real API), then position the cramp window: it
    //     started 3h ago and — left alone — would keep freezing until now.
    const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
    const crampRes = await usePowerup(alice.token, raceId, cramp.id, bob.userId);
    assert.equal(crampRes.status, 200);

    const crampStart = hoursAgo(3);
    const crampOriginalEnd = new Date(Date.now() + 60 * 60 * 1000); // 1h in the FUTURE
    const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEG_CRAMP" } });
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: { startsAt: crampStart, expiresAt: crampOriginalEnd, status: "ACTIVE" },
    });

    // (3) Bob walks 3000 steps DURING the cramp, before cleansing (2.5h–2h ago).
    await recordSamples(bob.token, [sample(2.5, 2, 3000)]);

    // (4) Bob uses Cleanse (real API). This must flip the cramp to EXPIRED and
    //     truncate its expiresAt to the cleanse moment (~now), well before the
    //     original future end.
    const cleanse = await giveHeldPowerup(raceId, bob.userId, "CLEANSE", 99902);
    const cleanseRes = await usePowerup(bob.token, raceId, cleanse.id);
    assert.equal(cleanseRes.status, 200);
    const cleanseBody = await cleanseRes.json();
    assert.equal(cleanseBody.result.cleared, 1, "exactly one opponent debuff cleared");

    // ROOT-CAUSE ASSERTION: cleanse truncated the cramp at the source.
    const afterCleanse = await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } });
    assert.equal(afterCleanse.status, "EXPIRED", "cleanse expires the cramp");
    assert.ok(
      afterCleanse.expiresAt.getTime() < crampOriginalEnd.getTime(),
      "cleanse must pull expiresAt back from the original (future) end to the cleanse moment"
    );

    // Relocate the truncated window into the past so post-cleanse samples can be
    // realistic past samples. The cleanse "happened" 1.5h ago; the real status
    // flip + truncation above already ran and was asserted.
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: { expiresAt: hoursAgo(1.5) },
    });

    // (5) Bob walks 4000 steps AFTER the cleanse (1h–0.5h ago).
    await recordSamples(bob.token, [sample(1, 0.5, 4000)]);

    const progress = await getProgress(alice.token, raceId);
    const bobP = findUser(progress, bob.userId);

    // (3) pre-cramp steps count, (4) during-cramp steps frozen, (5) post-cleanse
    //     steps count → total = 2000 + 4000 = 6000 (the 3000 is frozen).
    // On the un-truncated bug this would be 2000 (post-cleanse 4000 also frozen).
    assert.equal(bobP.totalSteps, 6000, "pre-cramp + post-cleanse count; during-cramp stays frozen");
  });
});

})();

// ---- consolidated from powerups-ghost-pepper-no-stack.test.js ----
(function powerups_ghost_pepper_no_stack_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

// ---------------------------------------------------------------------------
// Only ONE Ghost Pepper at a time.
//
// Ghost Pepper is a two-phase self-buff: 3x for 30 minutes, then a 30-minute
// burnout freeze. Nothing stopped a user from eating a second one, and both
// outcomes of stacking are wrong:
//
//   * Two peppers lit together SUM their multipliers (effectMultiplier.js sums
//     every active buff row — pepper 3 + pepper 3 = 6x), doubling the intended
//     ceiling for anyone holding two.
//   * A pepper eaten during the first one's burnout is simply destroyed —
//     the freeze check runs before the buff sum and returns 0 regardless.
//
// So the second pepper is either an exploit or a coin-burning trap. It must be
// rejected while one is live, and — because Ghost Pepper is a store-bought
// wave-5 item paid for with real coins — the rejected item must stay HELD in
// the race rather than being consumed (the transient "already active" pattern
// used by Rainstorm/Hitchhike/Piggy Bank).
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-ghp-${++nextAppleId}`;
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
      name: "Ghost Pepper Stack Test",
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
  const start = new Date(Date.now() - 8 * 60 * 60 * 1000);
  await prisma.race.update({
    where: { id: raceId },
    data: { startedAt: start },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: start },
  });
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findFirst({
    where: { raceId, userId },
  });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function usePowerup(token, raceId, powerupId) {
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/use`,
    {
      body: {},
      token,
      headers: { "X-Client-Features": "powerups5" },
    }
  );
}

describe("Ghost Pepper cannot be stacked", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("rejects a second pepper during the BOOST phase and keeps it HELD", async () => {
    const alice = await createUser("AlicePepper");
    const bob = await createUser("BobBystander");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const first = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99701
    );
    const firstRes = await usePowerup(alice.token, raceId, first.id);
    assert.equal(firstRes.status, 200, "the first pepper lights normally");

    // Second pepper while the first is still in its 3x boost window.
    const second = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99702
    );
    const secondRes = await usePowerup(alice.token, raceId, second.id);
    assert.equal(secondRes.status, 400, "a second pepper is rejected");

    // Exactly one pepper effect exists — no 3+3=6x window was created.
    const effects = await prisma.raceActiveEffect.findMany({
      where: { raceId, type: "GHOST_PEPPER" },
    });
    assert.equal(effects.length, 1, "only one Ghost Pepper effect exists");

    // The rejected pepper was PAID FOR — it must still be usable later.
    const stillHeld = await prisma.racePowerup.findUnique({
      where: { id: second.id },
    });
    assert.equal(
      stillHeld.status,
      "HELD",
      "the rejected pepper is not consumed"
    );
  });

  it("rejects a second pepper during the BURNOUT freeze phase too", async () => {
    const alice = await createUser("AlicePepper2");
    const bob = await createUser("BobBystander2");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const first = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99703
    );
    assert.equal((await usePowerup(alice.token, raceId, first.id)).status, 200);

    // Advance past the boost into the burnout: backdate startsAt by 40 minutes
    // so the boost (30m) is over but the row is still ACTIVE until 60m.
    const effect = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "GHOST_PEPPER" },
    });
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: {
        startsAt: new Date(Date.now() - 40 * 60 * 1000),
        expiresAt: new Date(Date.now() + 20 * 60 * 1000),
      },
    });

    const second = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99704
    );
    const secondRes = await usePowerup(alice.token, raceId, second.id);
    assert.equal(
      secondRes.status,
      400,
      "a pepper eaten during burnout is rejected, not silently wasted"
    );

    const stillHeld = await prisma.racePowerup.findUnique({
      where: { id: second.id },
    });
    assert.equal(stillHeld.status, "HELD");
  });

  it("allows a new pepper once the previous one has fully expired", async () => {
    const alice = await createUser("AlicePepper3");
    const bob = await createUser("BobBystander3");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const first = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99705
    );
    assert.equal((await usePowerup(alice.token, raceId, first.id)).status, 200);

    // Retire the first pepper the way the expiry job would.
    const effect = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "GHOST_PEPPER" },
    });
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: {
        startsAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        status: "EXPIRED",
      },
    });

    const second = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99706
    );
    const secondRes = await usePowerup(alice.token, raceId, second.id);
    assert.equal(
      secondRes.status,
      200,
      "the guard is transient — a fresh pepper works once the last one ended"
    );

    const effects = await prisma.raceActiveEffect.findMany({
      where: { raceId, type: "GHOST_PEPPER" },
    });
    assert.equal(effects.length, 2, "a second, separate pepper window exists");
  });

  it("a stale ACTIVE row past its window does not block a new pepper", async () => {
    const alice = await createUser("AlicePepper5");
    const bob = await createUser("BobBystander5");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const first = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99709
    );
    assert.equal((await usePowerup(alice.token, raceId, first.id)).status, 200);

    // The expireEffects cron flips status ACTIVE -> EXPIRED, but it runs on a
    // timer. Between the real end of the burnout and that tick, the row is
    // still ACTIVE — the guard must go by the WINDOW, not the status, or a lagging
    // cron would keep the user locked out after their pepper actually wore off.
    const effect = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "GHOST_PEPPER" },
    });
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: {
        startsAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        status: "ACTIVE",
      },
    });

    const second = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99710
    );
    assert.equal(
      (await usePowerup(alice.token, raceId, second.id)).status,
      200,
      "an un-retired but time-expired pepper must not block"
    );
  });

  it("one user's pepper does not block another user's", async () => {
    const alice = await createUser("AlicePepper4");
    const bob = await createUser("BobPepper4");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const alicePepper = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99707
    );
    const bobPepper = await giveHeldPowerup(
      raceId,
      bob.userId,
      "GHOST_PEPPER",
      99708
    );

    assert.equal(
      (await usePowerup(alice.token, raceId, alicePepper.id)).status,
      200
    );
    assert.equal(
      (await usePowerup(bob.token, raceId, bobPepper.id)).status,
      200,
      "the guard is per-participant, not per-race"
    );
  });
});

})();

// ---- consolidated from powerups-rally-flag-not-cleansable.test.js ----
(function powerups_rally_flag_not_cleansable_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");
const { appSettings } = require("../../../src/shared/config/appSettings");

// ---------------------------------------------------------------------------
// Batch 2026-08-09 item 7 — Rally Flag and Uprising are BUFFS, not debuffs.
// Cleanse and Quick Rinse must never clear them.
//
// Root cause this pins: both powerups write ONE EFFECT ROW PER BENEFICIARY via
// upsertBuffWindow, sourced from the caster. So on every teammate EXCEPT the
// caster the row has sourceUserId = caster, targetUserId = teammate — exactly
// the shape `isOpponentInflicted()` reads as "a debuff someone else put on me".
// The caster's own copy is self-sourced and was always safe, which is why the
// bug read as "intermittent": whether your rally buff survived a Cleanse
// depended on whether YOU were the one who raised the flag.
//
// The fix is one entry each in NON_CLEANSABLE_TYPES, which is the shared
// predicate behind BOTH cleanse paths and behind the "nothing to cleanse"
// guards — so this file asserts all three consequences (survival, the 400, and
// the 409) rather than just the removal.
//
// Follows the powerups-bounty-not-cleansable.test.js precedent: real HTTP, real
// DB, real handler chain, real casts. The buff rows under test are produced by
// genuinely casting Uprising / Rally Flag, not hand-inserted, because the
// per-beneficiary fan-out IS the thing that creates the bug.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;
let earnCounter = 0;
const HOUR_MS = 60 * 60 * 1000;

// Rally Flag needs a team-race-capable AND powerups5-capable client.
const HEADERS = { "X-Client-Features": "characters,team_races,powerups5" };

async function createUser(displayName) {
  const appleId = `apple-rally-cleanse-${++nextAppleId}`;
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
    headers: HEADERS,
  });
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
    body: { accept: true },
    token: b.token,
    headers: HEADERS,
  });
}

async function backdate(raceId) {
  const start = new Date(Date.now() - 8 * HOUR_MS);
  await prisma.race.update({
    where: { id: raceId },
    data: { startedAt: start, endsAt: new Date(Date.now() + 24 * HOUR_MS) },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: start },
  });
}

// Ordinary (non-team) race — Uprising's solo bottom-half branch.
async function createSoloRace(creator, opponents) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Rally Cleanse Solo",
      targetSteps: 200000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: creator.token,
    headers: HEADERS,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: opponents.map((o) => o.userId) },
    token: creator.token,
    headers: HEADERS,
  });
  for (const o of opponents) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
      headers: HEADERS,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: creator.token,
    headers: HEADERS,
  });
  await backdate(raceId);
  return raceId;
}

// Started 2v2: alice+bob = TEAM_A, carol+dave = TEAM_B.
async function createTeamRace(alice, bob, carol, dave) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Rally Cleanse Team",
      targetSteps: 200000,
      maxDurationDays: 7,
      isTeamRace: true,
      teamSize: 2,
      isPublic: true,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: alice.token,
    headers: HEADERS,
  });
  const raceId = (await createRes.json()).race.id;
  for (const other of [bob, carol, dave]) await makeFriends(alice, other);
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: [bob.userId, carol.userId, dave.userId] },
    token: alice.token,
    headers: HEADERS,
  });
  for (const [user, team] of [
    [bob, "TEAM_A"],
    [carol, "TEAM_B"],
    [dave, "TEAM_B"],
  ]) {
    const res = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true, team },
      token: user.token,
      headers: HEADERS,
    });
    assert.equal(res.status, 200, `accept for ${team} should succeed`);
  }
  const startRes = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: alice.token,
    headers: HEADERS,
  });
  assert.equal(startRes.status, 200);
  await backdate(raceId);
  return raceId;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function setSteps(raceId, userId, totalSteps) {
  const p = await participant(raceId, userId);
  await prisma.raceParticipant.update({
    where: { id: p.id },
    data: { totalSteps },
  });
}

async function giveHeld(raceId, userId, type, rarity = "RARE") {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity,
      status: "HELD",
      earnedAtSteps: ++earnCounter,
    },
  });
}

async function usePU(token, raceId, powerupId, body = {}) {
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/use`,
    { body, token, headers: HEADERS }
  );
}

async function buffRowFor(raceId, type, userId) {
  const p = await participant(raceId, userId);
  return prisma.raceActiveEffect.findFirst({
    where: { raceId, type, targetParticipantId: p.id },
  });
}

describe("Rally Flag and Uprising survive Cleanse and Quick Rinse", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    await appSettings.setFlag("teamRacesEnabled", true);
  });

  // ── Rally Flag (team race) ────────────────────────────────────────────────

  // Alice raises the flag; Bob is her teammate, so BOB's copy is the
  // caster-sourced row that used to look cleansable.
  async function raisedFlag() {
    const alice = await createUser("AliceFlag");
    const bob = await createUser("BobFlag");
    const carol = await createUser("CarolFlag");
    const dave = await createUser("DaveFlag");
    const raceId = await createTeamRace(alice, bob, carol, dave);

    const flag = await giveHeld(raceId, alice.userId, "RALLY_FLAG", "UNCOMMON");
    const res = await usePU(alice.token, raceId, flag.id);
    assert.equal(res.status, 200, "Alice can raise a Rally Flag in a team race");

    const bobFlag = await buffRowFor(raceId, "RALLY_FLAG", bob.userId);
    assert.ok(bobFlag, "Bob got a Rally Flag row");
    // The exact shape that makes this bug possible: teammate-targeted,
    // caster-sourced. If this ever stops being true the bug is gone for a
    // different reason and these tests would silently stop testing anything.
    assert.equal(bobFlag.sourceUserId, alice.userId);
    assert.equal(bobFlag.targetUserId, bob.userId);
    assert.notEqual(bobFlag.sourceUserId, bobFlag.targetUserId);

    return { alice, bob, carol, dave, raceId, bobFlag };
  }

  it("Cleanse with ONLY a teammate's Rally Flag on you is rejected 400 and leaves it ACTIVE", async () => {
    const { bob, raceId, bobFlag } = await raisedFlag();

    const cleanse = await giveHeld(raceId, bob.userId, "CLEANSE");
    const res = await usePU(bob.token, raceId, cleanse.id);
    assert.equal(res.status, 400, "a rally buff is not a cleansable debuff");
    assert.match((await res.json()).error, /no debuffs to cleanse/i);

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: bobFlag.id },
    });
    assert.equal(after.status, "ACTIVE", "Rally Flag untouched by Cleanse");
    assert.equal(
      after.expiresAt.getTime(),
      bobFlag.expiresAt.getTime(),
      "Rally Flag window is not truncated"
    );
  });

  it("Quick Rinse with ONLY a teammate's Rally Flag on you is rejected 409 NO_TIMED_DEBUFFS", async () => {
    const { bob, raceId, bobFlag } = await raisedFlag();

    const rinse = await giveHeld(raceId, bob.userId, "QUICK_RINSE");
    const res = await usePU(bob.token, raceId, rinse.id);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "NO_TIMED_DEBUFFS");

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: bobFlag.id },
    });
    assert.equal(after.status, "ACTIVE", "Rally Flag untouched by Quick Rinse");
  });

  it("Cleanse clears a real debuff alongside a surviving Rally Flag", async () => {
    const { bob, carol, raceId, bobFlag } = await raisedFlag();

    // Carol (an actual opponent) leg-cramps Bob — a genuine debuff.
    const cramp = await giveHeld(raceId, carol.userId, "LEG_CRAMP", "UNCOMMON");
    const crampRes = await usePU(carol.token, raceId, cramp.id, {
      targetUserId: bob.userId,
    });
    assert.equal(crampRes.status, 200);

    const cleanse = await giveHeld(raceId, bob.userId, "CLEANSE");
    const res = await usePU(bob.token, raceId, cleanse.id);
    assert.equal(res.status, 200);
    assert.equal(
      (await res.json()).result.cleared,
      1,
      "only the leg cramp is cleared — the Rally Flag is not counted"
    );

    const crampEffect = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "LEG_CRAMP" },
    });
    assert.equal(crampEffect.status, "EXPIRED", "the real debuff is cleared");

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: bobFlag.id },
    });
    assert.equal(after.status, "ACTIVE", "Rally Flag survives the cleanse");
  });

  it("the caster's own Rally Flag copy is unaffected too", async () => {
    const { alice, carol, raceId } = await raisedFlag();

    const aliceFlag = await buffRowFor(raceId, "RALLY_FLAG", alice.userId);
    assert.ok(aliceFlag);
    // Self-sourced — this copy was always safe; pinned so a future refactor of
    // the exclusion can't regress it while "fixing" the teammate case.
    assert.equal(aliceFlag.sourceUserId, aliceFlag.targetUserId);

    const cramp = await giveHeld(raceId, carol.userId, "LEG_CRAMP", "UNCOMMON");
    await usePU(carol.token, raceId, cramp.id, { targetUserId: alice.userId });
    const cleanse = await giveHeld(raceId, alice.userId, "CLEANSE");
    const res = await usePU(alice.token, raceId, cleanse.id);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result.cleared, 1);

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: aliceFlag.id },
    });
    assert.equal(after.status, "ACTIVE");
  });

  // ── Uprising (solo race, bottom-half branch) ──────────────────────────────

  // Four runners; Carol (3rd) sparks the Uprising, so beneficiaries are Carol
  // and Dave. DAVE's copy is the caster-sourced one under test.
  async function sparkedUprising() {
    const alice = await createUser("AliceUp");
    const bob = await createUser("BobUp");
    const carol = await createUser("CarolUp");
    const dave = await createUser("DaveUp");
    for (const other of [bob, carol, dave]) await makeFriends(alice, other);
    const raceId = await createSoloRace(alice, [bob, carol, dave]);

    // Standings: alice 8000 > bob 6000 > carol 2000 > dave 1000. Bottom half of
    // four is index 2..3 = carol, dave.
    await setSteps(raceId, alice.userId, 8000);
    await setSteps(raceId, bob.userId, 6000);
    await setSteps(raceId, carol.userId, 2000);
    await setSteps(raceId, dave.userId, 1000);

    const up = await giveHeld(raceId, carol.userId, "UPRISING");
    const res = await usePU(carol.token, raceId, up.id);
    assert.equal(res.status, 200, "Carol is in the bottom half");
    assert.equal((await res.json()).result.affected, 2);

    const daveUp = await buffRowFor(raceId, "UPRISING", dave.userId);
    assert.ok(daveUp, "Dave got an Uprising row");
    assert.equal(daveUp.sourceUserId, carol.userId);
    assert.equal(daveUp.targetUserId, dave.userId);

    return { alice, bob, carol, dave, raceId, daveUp };
  }

  });

})();

// ---- consolidated from powerups-trail-mix.test.js ----
(function powerups_trail_mix_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-tm-${++nextAppleId}`;
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
      name: "Trail Mix Test",
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

function findUser(progress, userId) {
  return progress.participants.find((p) => p.userId === userId);
}

async function usePowerup(token, raceId, powerupId, targetUserId) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body: targetUserId ? { targetUserId } : {},
    token,
  });
}

describe("trail mix", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // === CORE MECHANIC ===

  describe("core mechanic", () => {
    it("first powerup used is trail mix → 1 unique type × 100 = 100 bonus", async () => {
      const alice = await createUser("AliceMixAAAA");
      const bob = await createUser("BobMixAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99901);
      const res = await usePowerup(alice.token, raceId, tm.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.bonus, 100);

      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      assert.equal(aliceP.totalSteps, 100);
    });

    it("used 2 other types before trail mix → 3 × 100 = 300 bonus", async () => {
      const alice = await createUser("AliceMixBBBB");
      const bob = await createUser("BobMixBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Use 2 different powerup types first
      const shake = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
      await usePowerup(alice.token, raceId, shake.id);

      const shortcut = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99902);
      // Bob needs steps for shortcut to work
      const bobP = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
      await prisma.raceParticipant.update({ where: { id: bobP.id }, data: { bonusSteps: 5000, totalSteps: 5000 } });
      await usePowerup(alice.token, raceId, shortcut.id, bob.userId);

      // Now use trail mix
      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99903);
      const res = await usePowerup(alice.token, raceId, tm.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      // PROTEIN_SHAKE + SHORTCUT + TRAIL_MIX = 3 unique × 100 = 300
      assert.equal(body.result.bonus, 300);
    });

    it("using same type twice doesn't double count", async () => {
      const alice = await createUser("AliceMixCCCC");
      const bob = await createUser("BobMixCCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Use two protein shakes
      const s1 = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
      const s2 = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99902);
      await usePowerup(alice.token, raceId, s1.id);
      await usePowerup(alice.token, raceId, s2.id);

      // Trail mix should count only 1 unique type (PROTEIN_SHAKE) + itself
      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99903);
      const res = await usePowerup(alice.token, raceId, tm.id);
      const body = await res.json();
      // PROTEIN_SHAKE (1 unique, not 2) + TRAIL_MIX = 2 × 100 = 200
      assert.equal(body.result.bonus, 200);
    });

    it("multiple trail mixes recalculate with updated unique count", async () => {
      const alice = await createUser("AliceMixDDDD");
      const bob = await createUser("BobMixDDDDDD");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // First trail mix: only itself = 100
      const tm1 = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99901);
      const res1 = await usePowerup(alice.token, raceId, tm1.id);
      assert.equal((await res1.json()).result.bonus, 100);

      // Use a protein shake
      const shake = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99902);
      await usePowerup(alice.token, raceId, shake.id);

      // Second trail mix: TRAIL_MIX + PROTEIN_SHAKE + this TRAIL_MIX = still 2 unique types
      // (TRAIL_MIX is already counted from first use)
      const tm2 = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99903);
      const res2 = await usePowerup(alice.token, raceId, tm2.id);
      // TRAIL_MIX + PROTEIN_SHAKE = 2 unique × 100 = 200
      assert.equal((await res2.json()).result.bonus, 200);
    });
  });

  // === VALIDATION ===

  describe("validation", () => {
    it("self-only — rejects if targetUserId provided", async () => {
      const alice = await createUser("AliceValAAAA");
      const bob = await createUser("BobValAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99901);
      const res = await usePowerup(alice.token, raceId, tm.id, bob.userId);
      assert.equal(res.status, 400);
    });

    it("not blocked by compression socks", async () => {
      const alice = await createUser("AliceValBBBB");
      const bob = await createUser("BobValBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Alice has shield
      const shield = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(alice.token, raceId, shield.id);

      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99902);
      const res = await usePowerup(alice.token, raceId, tm.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.ok(!body.result.blocked);
    });
  });

  // === EDGE CASES ===

  describe("edge cases", () => {
    it("only counts USED powerups, not HELD or DISCARDED", async () => {
      const alice = await createUser("AliceEdgeAAA");
      const bob = await createUser("BobEdgeAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Give alice a held protein shake (not used)
      await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);

      // Give alice a discarded shortcut
      const sc = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99902);
      await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${sc.id}/discard`, { token: alice.token });

      // Trail mix should only count itself (no USED types yet)
      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99903);
      const res = await usePowerup(alice.token, raceId, tm.id);
      assert.equal((await res.json()).result.bonus, 100);
    });

    it("only counts powerups from this race, not other races", async () => {
      const alice = await createUser("AliceEdgeBBB");
      const bob = await createUser("BobEdgeBBBBB");
      const charlie = await createUser("CharlieEdgeB");
      await makeFriends(alice, bob);
      await makeFriends(alice, charlie);

      // Race A: use a protein shake
      const raceA = await createActiveRace(alice, bob);
      const shakeA = await giveHeldPowerup(raceA, alice.userId, "PROTEIN_SHAKE", 99901);
      await usePowerup(alice.token, raceA, shakeA.id);

      // Race B: trail mix should not count Race A's protein shake
      const raceB = await createActiveRace(alice, charlie);
      const tm = await giveHeldPowerup(raceB, alice.userId, "TRAIL_MIX", 99902);
      const res = await usePowerup(alice.token, raceB, tm.id);
      // Only trail mix itself = 100
      assert.equal((await res.json()).result.bonus, 100);
    });

    it("bonus persists in progress", async () => {
      const alice = await createUser("AliceEdgeCCC");
      const bob = await createUser("BobEdgeCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99901);
      await usePowerup(alice.token, raceId, tm.id);

      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      assert.equal(aliceP.totalSteps, 100);

      // Fetch again
      const progress2 = await getProgress(alice.token, raceId);
      const aliceP2 = findUser(progress2, alice.userId);
      assert.equal(aliceP2.totalSteps, 100);
    });
  });

  // === FEED ===

  describe("feed", () => {
    it("shows bonus amount and unique count in event", async () => {
      const alice = await createUser("AliceFeedAAA");
      const bob = await createUser("BobFeedAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Use a protein shake first
      const shake = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
      await usePowerup(alice.token, raceId, shake.id);

      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99902);
      await usePowerup(alice.token, raceId, tm.id);

      const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
      const feedBody = await feedRes.json();

      const event = feedBody.events.find(
        (e) => e.eventType === "POWERUP_USED" && e.powerupType === "TRAIL_MIX"
      );
      assert.ok(event, "feed should contain trail mix event");
      assert.ok(event.description.includes("Trail Mix"));
    });
  });
});

})();

// ---- consolidated from powerups-upgrades.test.js ----
(function powerups_upgrades_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-up-${++nextAppleId}`;
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
      name: "Upgrade Test",
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

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps, rarity = "COMMON") {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity,
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function setUserCoins(userId, coins) {
  await prisma.user.update({ where: { id: userId }, data: { coins } });
}

async function getUserCoins(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return user.coins;
}

async function usePowerup(token, raceId, powerupId, { targetUserId, upgradeLevel } = {}) {
  const body = {};
  if (targetUserId) body.targetUserId = targetUserId;
  if (upgradeLevel != null) body.upgradeLevel = upgradeLevel;
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body,
    token,
  });
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token });
  return (await res.json()).progress;
}

describe("powerup upgrades — integration", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // ---------------------------------------------------------------------
  // Back-compat: existing call shape without upgradeLevel still works
  // ---------------------------------------------------------------------

  it("base use (no upgradeLevel): existing behavior preserved, no coins deducted", async () => {
    const alice = await createUser("AliceUpAA");
    const bob = await createUser("BobUpAAAA");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 1000);

    const powerup = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
    const res = await usePowerup(alice.token, raceId, powerup.id);
    assert.equal(res.status, 200);

    const aliceCoins = await getUserCoins(alice.userId);
    assert.equal(aliceCoins, 1000, "no coins deducted on base use");

    const progress = await getProgress(alice.token, raceId);
    const aliceP = progress.participants.find((p) => p.userId === alice.userId);
    assert.equal(aliceP.totalSteps, 1500, "base 1500 bonus applied");

    // Progress advertises the authoritative upgrade price ladders so clients
    // can display exactly what the server will charge (no stale bundled table).
    // byType is no longer empty as of batch 2026-08-09: the WT/LC duration nerf
    // came with a matching reprice, and the Horseshoe ladder was zeroed when its
    // upgrades became inert. Serving these to the client is the whole point of
    // the block — an old build shows its bundled price, a new one shows this.
    //
    // 2026-08-15: RUNNERS_HIGH, DETOUR_SIGN, and STEALTH_MODE joined the
    // 15-min duration ladder with matching byType overrides.
    assert.deepEqual(progress.powerupData.upgradeCosts, {
      byRarity: {
        COMMON: [0, 5, 15, 45],
        UNCOMMON: [0, 10, 30, 90],
        RARE: [0, 15, 45, 135],
      },
      byType: {
        LEG_CRAMP: [0, 10, 20, 30],
        WRONG_TURN: [0, 15, 30, 45],
        RUNNERS_HIGH: [0, 5, 10, 15],
        DETOUR_SIGN: [0, 5, 10, 15],
        STEALTH_MODE: [0, 10, 20, 30],
        LUCKY_HORSESHOE: [0, 0, 0, 0],
      },
    });
  });

  // ---------------------------------------------------------------------
  // Lvl 2 Protein Shake
  // ---------------------------------------------------------------------

  it("Lvl 2 Protein Shake: 15 coins deducted, +3000 steps, feed shows 'Lvl 2'", async () => {
    const alice = await createUser("AliceUpBB");
    const bob = await createUser("BobUpBBBB");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 500);

    const powerup = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
    const res = await usePowerup(alice.token, raceId, powerup.id, { upgradeLevel: 2 });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.result.upgradeLevel, 2);
    assert.equal(body.result.coinsSpent, 15);

    assert.equal(await getUserCoins(alice.userId), 485);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = progress.participants.find((p) => p.userId === alice.userId);
    assert.equal(aliceP.totalSteps, 3000);

    // CoinTransaction row exists
    const txs = await prisma.coinTransaction.findMany({
      where: { userId: alice.userId, reason: "powerup_upgrade" },
    });
    assert.equal(txs.length, 1);
    assert.equal(txs[0].amount, -15);
    assert.equal(txs[0].refId, powerup.id);

    // PowerupUpgradeEvent row exists
    const ues = await prisma.powerupUpgradeEvent.findMany({
      where: { powerupId: powerup.id },
    });
    assert.equal(ues.length, 1);
    assert.equal(ues[0].tier, 2);
    assert.equal(ues[0].costCoins, 15);
    assert.equal(ues[0].status, "APPLIED");
    assert.equal(ues[0].powerupType, "PROTEIN_SHAKE");

    // RacePowerup column updated
    const updated = await prisma.racePowerup.findUnique({ where: { id: powerup.id } });
    assert.equal(updated.upgradeLevel, 2);
    assert.equal(updated.status, "USED");

    // Feed event includes "Lvl 2" prefix
    const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
    const feed = (await feedRes.json()).events;
    const ev = feed.find((e) => e.eventType === "POWERUP_USED" && e.powerupType === "PROTEIN_SHAKE");
    assert.match(ev.description, /Lvl 2/);
  });

  // ---------------------------------------------------------------------
  // Lvl 3 Leg Cramp on bob — duration becomes 4 hours
  // ---------------------------------------------------------------------

  // Batch 2026-08-09 item 1: L3 Leg Cramp is 30 coins for 1h45m (was 90 for 4h).
  it("Lvl 3 Leg Cramp: 30 coins, freezes target for 1h45m, feed shows 'Lvl 3'", async () => {
    const alice = await createUser("AliceUpCC");
    const bob = await createUser("BobUpCCCC");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 500);

    const powerup = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901, "UNCOMMON");
    const before = Date.now();
    const res = await usePowerup(alice.token, raceId, powerup.id, {
      targetUserId: bob.userId,
      upgradeLevel: 3,
    });
    assert.equal(res.status, 200);

    assert.equal(await getUserCoins(alice.userId), 470);

    const effect = await prisma.raceActiveEffect.findFirst({
      where: { powerupId: powerup.id },
    });
    assert.ok(effect);
    const durationMs = new Date(effect.expiresAt).getTime() - new Date(effect.startsAt).getTime();
    assert.equal(
      durationMs,
      105 * 60 * 1000,
      "expires 1h45m after start"
    );

    const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
    const feed = (await feedRes.json()).events;
    const ev = feed.find((e) => e.eventType === "POWERUP_USED" && e.powerupType === "LEG_CRAMP");
    assert.match(ev.description, /Lvl 3/);
    assert.match(ev.description, /1h 45m/);
  });

  // ---------------------------------------------------------------------
  // Insufficient coins
  // ---------------------------------------------------------------------

  it("Insufficient coins: Lvl 3 attempt → 400, no coin change, powerup stays HELD", async () => {
    const alice = await createUser("AliceUpDD");
    const bob = await createUser("BobUpDDDD");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 10);

    const powerup = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
    const res = await usePowerup(alice.token, raceId, powerup.id, { upgradeLevel: 3 });
    assert.equal(res.status, 400);

    assert.equal(await getUserCoins(alice.userId), 10);

    const updated = await prisma.racePowerup.findUnique({ where: { id: powerup.id } });
    assert.equal(updated.status, "HELD");
    assert.equal(updated.upgradeLevel, 0);

    const ues = await prisma.powerupUpgradeEvent.findMany({ where: { powerupId: powerup.id } });
    assert.equal(ues.length, 0);
  });

  // ---------------------------------------------------------------------
  // Non-upgradeable powerup type
  // ---------------------------------------------------------------------

  it("Reject upgradeLevel>0 on RED_CARD (non-upgradeable): 400, no coin change", async () => {
    const alice = await createUser("AliceUpEE");
    const bob = await createUser("BobUpEEEE");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 1000);

    // Give bob enough steps so red card has a clear leader
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: bob.userId },
      data: { totalSteps: 50000 },
    });

    const powerup = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99901, "RARE");
    const res = await usePowerup(alice.token, raceId, powerup.id, { upgradeLevel: 1 });
    assert.equal(res.status, 400);
    assert.equal(await getUserCoins(alice.userId), 1000);
  });

  // ---------------------------------------------------------------------
  // Out-of-range level
  // ---------------------------------------------------------------------

  it("Reject upgradeLevel=4: 400", async () => {
    const alice = await createUser("AliceUpFF");
    const bob = await createUser("BobUpFFFF");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 1000);

    const powerup = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
    const res = await usePowerup(alice.token, raceId, powerup.id, { upgradeLevel: 4 });
    assert.equal(res.status, 400);
  });

  // ---------------------------------------------------------------------
  // Block by Compression Socks: coins ARE deducted (Wave 2 rule)
  // ---------------------------------------------------------------------

  // Shortcut is RARE now (was pricing off the COMMON ladder): tier 2 = 45, not 15.
  it("Lvl 2 Shortcut blocked by shield: coins deducted (45), no steps stolen, upgrade event = BLOCKED", async () => {
    const alice = await createUser("AliceUpGG");
    const bob = await createUser("BobUpGGGG");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 500);

    // Bob needs non-zero steps for Shortcut to clear validation (zero-step
    // targets are rejected with "nothing to steal" before reaching shield logic).
    // bonusSteps survives resolveRaceState recomputation; totalSteps would be overwritten.
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: bob.userId },
      data: { bonusSteps: 5000, totalSteps: 5000 },
    });

    // Give bob compression socks and activate
    const shield = await giveHeldPowerup(raceId, bob.userId, "COMPRESSION_SOCKS", 99901, "RARE");
    await usePowerup(bob.token, raceId, shield.id);

    // Alice attempts upgraded shortcut against bob
    const sc = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99902);
    const res = await usePowerup(alice.token, raceId, sc.id, {
      targetUserId: bob.userId,
      upgradeLevel: 2,
    });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.result.blocked, true);

    // Coins ARE deducted on block
    assert.equal(await getUserCoins(alice.userId), 455);

    // PowerupUpgradeEvent recorded with status BLOCKED
    const ues = await prisma.powerupUpgradeEvent.findMany({ where: { powerupId: sc.id } });
    assert.equal(ues.length, 1);
    assert.equal(ues[0].status, "BLOCKED");
    assert.equal(ues[0].tier, 2);
    assert.equal(ues[0].costCoins, 45);
  });

  // ---------------------------------------------------------------------
  // Stack rejection — coins not deducted
  // ---------------------------------------------------------------------

  it("Lvl 3 Runner's High rejected when one already active: 400, no coin change", async () => {
    const alice = await createUser("AliceUpHH");
    const bob = await createUser("BobUpHHHH");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 1000);

    // First Runner's High (base)
    const rh1 = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901, "UNCOMMON");
    const r1 = await usePowerup(alice.token, raceId, rh1.id);
    assert.equal(r1.status, 200);

    // Second Runner's High at Lvl 3 should reject without coin change
    const rh2 = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99902, "UNCOMMON");
    const r2 = await usePowerup(alice.token, raceId, rh2.id, { upgradeLevel: 3 });
    assert.equal(r2.status, 400);
    assert.equal(await getUserCoins(alice.userId), 1000);

    // Second powerup must still be HELD
    const after = await prisma.racePowerup.findUnique({ where: { id: rh2.id } });
    assert.equal(after.status, "HELD");
  });

  // ---------------------------------------------------------------------
  // Concurrent purchase race condition (atomic deduct guarantees one wins)
  // ---------------------------------------------------------------------

  it("Two simultaneous Lvl 3 Protein Shakes with only enough coins for one — exactly one succeeds", async () => {
    const alice = await createUser("AliceUpII");
    const bob = await createUser("BobUpIIII");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 45); // exactly enough for ONE Lvl 3

    const p1 = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
    const p2 = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99902);

    const [r1, r2] = await Promise.all([
      usePowerup(alice.token, raceId, p1.id, { upgradeLevel: 3 }),
      usePowerup(alice.token, raceId, p2.id, { upgradeLevel: 3 }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 400], "exactly one succeeds, one fails");

    assert.equal(await getUserCoins(alice.userId), 0);
    const txs = await prisma.coinTransaction.findMany({
      where: { userId: alice.userId, reason: "powerup_upgrade" },
    });
    assert.equal(txs.length, 1, "exactly one CoinTransaction recorded");
  });

  // 2026-08-15: RUNNERS_HIGH, STEALTH_MODE, and DETOUR_SIGN joined the 15-min
  // upgrade ladder. The seed (powerupCopySeed.js) is the served catalog's
  // source of truth, not the DURATIONS_MS table this suite otherwise tests —
  // a duration-table-only edit ships a nerf while every client still
  // advertises the old 2h/3h/4h tier labels. Guards against that drift.
  it("GET /powerups/catalog never advertises a retired 2h+ tier label for the 15-min-ladder types", async () => {
    const {
      POWERUP_COPY_SEED,
    } = require("../../../src/modules/powerups/constants/powerupCopySeed");
    for (const row of POWERUP_COPY_SEED) {
      await prisma.powerupCopy.upsert({
        where: { powerupType: row.powerupType },
        update: {
          description: row.description,
          shortDescription: row.shortDescription,
          upgradeTierLabels: row.upgradeTierLabels,
        },
        create: row,
      });
    }

    const alice = await createUser("AliceCopyGuard");
    const res = await request(server.baseUrl, "GET", "/powerups/catalog", {
      token: alice.token,
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    for (const type of ["RUNNERS_HIGH", "STEALTH_MODE", "DETOUR_SIGN", "LEG_CRAMP", "WRONG_TURN"]) {
      const entry = body.powerups.find((p) => p.type === type);
      assert.ok(entry, `${type} is in the catalog`);
      for (const label of entry.upgradeTierLabels) {
        assert.doesNotMatch(
          label,
          /\b[234]h\b/,
          `${type} tier "${label}" still names a pre-nerf duration`
        );
      }
    }
  });
});

})();

// ---- consolidated from powerups5-wave.test.js ----
(function powerups5_wave_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");
const { resolveExpiredRaces } = require("../../../src/modules/races/jobs/raceExpiry");
const {
  buildRaceResolutionWorkerV2,
} = require("../../../src/modules/races/jobs/raceResolutionQueueV2");
const { appSettings } = require("../../../src/shared/config/appSettings");
const {
  buildExpireEffects,
} = require("../../../src/modules/powerups/commands/expireEffects");

let server;
let nextAppleId = 0;
let earnCounter = 0;
const HOUR_MS = 60 * 60 * 1000;

// Wave-5 store catalog rows (cleanDatabase wipes them). Prices MUST match seed.js.
const WAVE5 = [
  { sku: "POWERUP_GHOST_PEPPER", powerupType: "GHOST_PEPPER", priceCoins: 75 },
  { sku: "POWERUP_COIN_FLIP", powerupType: "COIN_FLIP", priceCoins: 40 },
  { sku: "POWERUP_MYSTERY_POTION", powerupType: "MYSTERY_POTION", priceCoins: 40 },
  { sku: "POWERUP_DECOY", powerupType: "DECOY", priceCoins: 150 },
  { sku: "POWERUP_POWER_OUTAGE", powerupType: "POWER_OUTAGE", priceCoins: 150 },
  { sku: "POWERUP_UMBRELLA", powerupType: "UMBRELLA", priceCoins: 75 },
  { sku: "POWERUP_RALLY_FLAG", powerupType: "RALLY_FLAG", priceCoins: 150 },
  { sku: "POWERUP_PIGGY_BANK", powerupType: "PIGGY_BANK", priceCoins: 40 },
  { sku: "POWERUP_BOUNTY", powerupType: "BOUNTY", priceCoins: 75 },
];
const IMPOSTER_ROW = { sku: "POWERUP_IMPOSTER", powerupType: "IMPOSTER", priceCoins: 75 };

const P5 = { "X-Client-Features": "characters,powerups3,powerups4,powerups5" };
const OLD = { "X-Client-Features": "characters" };

async function seedCatalog() {
  for (const p of [...WAVE5, IMPOSTER_ROW]) {
    await prisma.powerupShopItem.upsert({
      where: { sku: p.sku },
      // testOnly:false in BOTH paths: another integration file may run the real
      // seed (which ships wave-5 rows testOnly:true), and this table is not
      // truncated between files — so force it visible on the prod channel here.
      update: { priceCoins: p.priceCoins, active: true, testOnly: false },
      create: { ...p, name: p.sku, description: `${p.sku} row`, active: true, testOnly: false },
    });
  }
}

async function createUser(displayName, coins = 0) {
  const appleId = `apple-p5-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", { body: { identityToken: appleId } });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", { body: { displayName }, token: body.sessionToken });
  if (coins > 0) await prisma.user.update({ where: { id: body.user.id }, data: { coins } });
  return { userId: body.user.id, token: body.sessionToken };
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", { body: { addresseeId: b.userId }, token: a.token });
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, { body: { accept: true }, token: b.token });
}

async function createActiveRace(alice, opponents, opts = {}) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: { name: opts.name || "P5 Race", targetSteps: 200000, maxDurationDays: 7, powerupsEnabled: true, powerupStepInterval: 5000 },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, { body: { inviteeIds: opponents.map((o) => o.userId) }, token: alice.token });
  for (const o of opponents) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, { body: { accept: true }, token: o.token });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });
  const start = new Date(Date.now() - 8 * HOUR_MS);
  const ends = opts.endsAt !== undefined ? opts.endsAt : new Date(Date.now() + 24 * HOUR_MS);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start, endsAt: ends } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function setSteps(raceId, userId, totalSteps) {
  const p = await participant(raceId, userId);
  await prisma.raceParticipant.update({ where: { id: p.id }, data: { totalSteps } });
}

async function giveHeld(raceId, userId, type, rarity = "UNCOMMON") {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({ data: { raceId, participantId: p.id, userId, type, rarity, status: "HELD", earnedAtSteps: ++earnCounter } });
}

async function giveEffect(raceId, targetUserId, sourceUserId, type, { expiresAt, startsAt, metadata } = {}) {
  const p = await participant(raceId, targetUserId);
  const src = await participant(raceId, sourceUserId);
  const pw = await prisma.racePowerup.create({
    data: { raceId, participantId: src.id, userId: sourceUserId, type, rarity: "UNCOMMON", status: "USED", earnedAtSteps: ++earnCounter },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId, targetParticipantId: p.id, targetUserId, sourceUserId, powerupId: pw.id, type, status: "ACTIVE",
      startsAt: startsAt || new Date(Date.now() - 2 * HOUR_MS),
      expiresAt: expiresAt === undefined ? new Date(Date.now() + HOUR_MS) : expiresAt,
      metadata: metadata || {},
    },
  });
}

async function giveHourlySamples(userId, hoursAgoStart, hourCount, stepsPerHour) {
  const now = Date.now();
  for (let i = 0; i < hourCount; i++) {
    const periodStart = new Date(Math.floor((now - (hoursAgoStart - i) * HOUR_MS) / HOUR_MS) * HOUR_MS);
    const periodEnd = new Date(periodStart.getTime() + HOUR_MS);
    await prisma.stepSample.upsert({
      where: { userId_periodStart: { userId, periodStart } },
      update: { steps: stepsPerHour, periodEnd },
      create: { userId, periodStart, periodEnd, steps: stepsPerHour, sourceName: "healthkit" },
    });
  }
}

async function usePU(token, raceId, powerupId, body = {}, headers = P5) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, { body, token, headers });
}
async function getProgress(token, raceId, headers = P5) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token, headers });
  return (await res.json()).progress;
}
async function drainRaceResolutionJobs(maxJobs = 20) {
  const worker = buildRaceResolutionWorkerV2({ bootAt: 0 });
  for (let index = 0; index < maxJobs; index += 1) {
    if (!(await worker.processOne())) return;
  }
  assert.fail(`race resolution queue did not drain within ${maxJobs} jobs`);
}
async function purchase(token, body, key, headers = P5) {
  return request(server.baseUrl, "POST", "/shop/powerups/purchase", { body, token, headers: { "Idempotency-Key": key, ...headers } });
}
function findEffect(progress, type, userId) {
  return (progress.powerupData?.activeEffects || []).find((e) => e.type === type && (!userId || e.targetUserId === userId));
}
function boardSteps(progress, userId) {
  return (progress.participants || []).find((p) => p.userId === userId)?.totalSteps;
}

describe("powerups5 wave — integration", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    // app_settings persists across test files; pin this suite's payout math
    // to the pre-funded-prize-pools baseline it was written against, rather
    // than relying on whatever an earlier file happened to leave it as.
    await appSettings.setFlag("fundedPrizePoolsEnabled", false);
  });

  // ── 1. Gating matrix ────────────────────────────────────────────────────
  describe("gating", () => {
    it("catalog exposes wave 5 only to capable clients and omits retired Imposter", async () => {
      await seedCatalog();
      const u = await createUser("Cat", 1000);
      const withP5 = await (await request(server.baseUrl, "GET", "/shop/powerups", { token: u.token, headers: P5 })).json();
      const types = withP5.items.map((i) => i.powerupType);
      assert.equal(types.includes("IMPOSTER"), false);
      for (const w of WAVE5) assert.ok(types.includes(w.powerupType), `${w.powerupType} visible with powerups5`);
      const byType = Object.fromEntries(withP5.items.map((i) => [i.powerupType, i]));
      assert.equal(byType.PIGGY_BANK.priceCoins, 40);
      assert.equal(byType.BOUNTY.priceCoins, 75);

      const withoutP5 = await (await request(server.baseUrl, "GET", "/shop/powerups", { token: u.token, headers: OLD })).json();
      const oldTypes = withoutP5.items.map((i) => i.powerupType);
      for (const w of WAVE5) assert.ok(!oldTypes.includes(w.powerupType), `${w.powerupType} hidden from old client`);
      assert.equal(oldTypes.includes("IMPOSTER"), false);
    });

    it("purchase guard: wave-5 purchase from old client → 404", async () => {
      await seedCatalog();
      const u = await createUser("Buyer", 1000);
      const res = await purchase(u.token, { sku: "POWERUP_PIGGY_BANK" }, "p5-old-1", OLD);
      assert.equal(res.status, 404);
      const ok = await purchase(u.token, { sku: "POWERUP_PIGGY_BANK" }, "p5-new-1", P5);
      assert.equal(ok.status, 200);
    });

    it("use of a wave-5 held item from an old client → UPDATE_REQUIRED, stays HELD", async () => {
      await seedCatalog();
      const alice = await createUser("A"); const bob = await createUser("B");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob]);
      const pw = await giveHeld(raceId, alice.userId, "UMBRELLA");
      const res = await usePU(alice.token, raceId, pw.id, {}, OLD);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "UPDATE_REQUIRED");
      assert.equal((await prisma.racePowerup.findUnique({ where: { id: pw.id } })).status, "HELD");
    });

    });

  // ── 2. Uprising ─────────────────────────────────────────────────────────
  // ── 3/4. Coin Flip + settlement parity ──────────────────────────────────
  describe("coin flip", () => {
    it("use returns flip WIN|LOSE and multiplier; effect created", async () => {
      await seedCatalog();
      const a = await createUser("Flipper");
      const b = await createUser("Other");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      const pw = await giveHeld(raceId, a.userId, "COIN_FLIP");
      const res = await usePU(a.token, raceId, pw.id, {});
      assert.equal(res.status, 200);
      const r = (await res.json()).result;
      assert.ok(["WIN", "LOSE"].includes(r.flip));
      assert.equal(r.multiplier, r.flip === "WIN" ? 2 : 0.5);
      assert.ok(r.effect);
    });

    it("seeded COIN_FLIP lose halves in-window steps (settlement matches live)", async () => {
      const a = await createUser("LoserFlip");
      const b = await createUser("Ctrl");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      // 4 closed hourly samples (hours 6..3 ago), 1000 steps each = 4000.
      await giveHourlySamples(a.userId, 6, 4, 1000);
      await giveHourlySamples(b.userId, 6, 4, 1000);
      // Coin-flip lose covering hours 6..2 ago (already expired window, closed).
      await giveEffect(raceId, a.userId, a.userId, "COIN_FLIP", {
        startsAt: new Date(Math.floor((Date.now() - 6 * HOUR_MS) / HOUR_MS) * HOUR_MS),
        expiresAt: new Date(Math.floor((Date.now() - 2 * HOUR_MS) / HOUR_MS) * HOUR_MS),
        metadata: { multiplier: 0.5, stepsAtStart: 0 },
      });
      const live = await getProgress(a.token, raceId);
      const aLive = boardSteps(live, a.userId);
      const bLive = boardSteps(live, b.userId);
      assert.ok(aLive < bLive, `coin-flip lose should reduce steps: ${aLive} < ${bLive}`);

      // Settlement parity: move endsAt to just-now and settle.
      await prisma.race.update({ where: { id: raceId }, data: { endsAt: new Date(Date.now() - 60 * 1000) } });
      await resolveExpiredRaces();
      const settled = await participant(raceId, a.userId);
      assert.equal(settled.totalSteps, aLive, "settled total equals live total (parity)");
    });
  });

  // ── 6. Decoy ────────────────────────────────────────────────────────────
  describe("decoy", () => {
    it("redirects a single-target attack to a third party; REDIRECTED response", async () => {
      const a = await createUser("Attacker"); const b = await createUser("DecoyHolder"); const c = await createUser("Bystander");
      await makeFriends(a, b); await makeFriends(a, c);
      const raceId = await createActiveRace(a, [b, c]);
      await giveEffect(raceId, b.userId, b.userId, "DECOY", { expiresAt: new Date(Date.now() + 24 * HOUR_MS) });
      const legCramp = await giveHeld(raceId, a.userId, "LEG_CRAMP");
      const res = await usePU(a.token, raceId, legCramp.id, { targetUserId: b.userId });
      assert.equal(res.status, 200);
      const r = (await res.json()).result;
      assert.equal(r.outcome, "REDIRECTED");
      assert.equal(r.redirectedBy, "DECOY");
      assert.equal(r.redirectedToUserId, c.userId);
      // The cramp landed on c, not b; decoy consumed.
      const cP = await participant(raceId, c.userId);
      const cramp = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEG_CRAMP", targetParticipantId: cP.id, status: "ACTIVE" } });
      assert.ok(cramp, "redirected cramp on bystander");
      const decoyRow = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "DECOY" } });
      assert.equal(decoyRow.status, "EXPIRED", "decoy consumed");
    });

    it("2-player race: Decoy fizzles as a block (no third party)", async () => {
      const a = await createUser("Attacker2"); const b = await createUser("Solo");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await giveEffect(raceId, b.userId, b.userId, "DECOY", { expiresAt: new Date(Date.now() + 24 * HOUR_MS) });
      const pw = await giveHeld(raceId, a.userId, "LEG_CRAMP");
      const res = await usePU(a.token, raceId, pw.id, { targetUserId: b.userId });
      const r = (await res.json()).result;
      assert.equal(r.blocked, true);
      assert.equal(r.blockedBy, "DECOY");
      const bP = await participant(raceId, b.userId);
      const cramp = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEG_CRAMP", targetParticipantId: bP.id } });
      assert.equal(cramp, null, "no cramp landed");
    });

    it("shop-type attack (does not reflect) is still redirected by Decoy", async () => {
      await seedCatalog();
      const a = await createUser("ShopAtt"); const b = await createUser("DHolder"); const c = await createUser("Third");
      await makeFriends(a, b); await makeFriends(a, c);
      const raceId = await createActiveRace(a, [b, c]);
      await giveEffect(raceId, b.userId, b.userId, "DECOY", { expiresAt: new Date(Date.now() + 24 * HOUR_MS) });
      const jam = await giveHeld(raceId, a.userId, "SIGNAL_JAMMER");
      const res = await usePU(a.token, raceId, jam.id, { targetUserId: b.userId });
      const r = (await res.json()).result;
      assert.equal(r.outcome, "REDIRECTED");
      assert.equal(r.redirectedToUserId, c.userId);
    });
  });

  // ── 7. Power Outage ─────────────────────────────────────────────────────
  describe("power outage", () => {
    async function outageOnVictim() {
      await seedCatalog();
      const attacker = await createUser("OutageCaster");
      const victim = await createUser("OutageVictim");
      await makeFriends(attacker, victim);
      const raceId = await createActiveRace(attacker, [victim]);
      const outage = await giveHeld(raceId, attacker.userId, "POWER_OUTAGE");
      const outageRes = await usePU(attacker.token, raceId, outage.id);
      assert.equal(outageRes.status, 200);
      const victimParticipant = await participant(raceId, victim.userId);
      const outageEffect = await prisma.raceActiveEffect.findFirst({
        where: {
          raceId,
          type: "POWER_OUTAGE",
          targetParticipantId: victimParticipant.id,
          status: "ACTIVE",
        },
      });
      assert.ok(outageEffect, "victim has a live Power Outage");
      return { victim, raceId, outageEffect };
    }

    it("jams all enemies; a jammed enemy can't use powerups; Socks exempt; Umbrella skipped", async () => {
      await seedCatalog();
      const a = await createUser("Outage"); const b = await createUser("Jammed"); const c = await createUser("Socked"); const d = await createUser("Umbrellaed");
      for (const x of [b, c, d]) await makeFriends(a, x);
      const raceId = await createActiveRace(a, [b, c, d]);
      await giveEffect(raceId, c.userId, c.userId, "COMPRESSION_SOCKS", { expiresAt: new Date(Date.now() + HOUR_MS) });
      await giveEffect(raceId, d.userId, d.userId, "UMBRELLA", { expiresAt: new Date(Date.now() + 12 * HOUR_MS) });

      const pw = await giveHeld(raceId, a.userId, "POWER_OUTAGE");
      const res = await usePU(a.token, raceId, pw.id, {});
      assert.equal(res.status, 200);
      const r = (await res.json()).result;
      assert.equal(r.affected, 1, "only b is jammed (c socks, d umbrella)");
      assert.equal(r.blockedCount, 1, "c's socks blocked");

      const bJam = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "POWER_OUTAGE", targetParticipantId: (await participant(raceId, b.userId)).id, status: "ACTIVE" } });
      assert.ok(bJam);
      const dJam = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "POWER_OUTAGE", targetParticipantId: (await participant(raceId, d.userId)).id } });
      assert.equal(dJam, null, "umbrella holder not jammed");
      const umbrella = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "UMBRELLA" } });
      assert.equal(umbrella.status, "ACTIVE", "umbrella not consumed");

      // b (jammed by power outage) cannot use a powerup.
      const shake = await giveHeld(raceId, b.userId, "PROTEIN_SHAKE");
      const blocked = await usePU(b.token, raceId, shake.id, {});
      assert.equal(blocked.status, 409);
    });

    it("Cleanse bypasses a live Power Outage jam and clears the outage", async () => {
      const { victim, raceId, outageEffect } = await outageOnVictim();
      const cleanse = await giveHeld(raceId, victim.userId, "CLEANSE");

      const res = await usePU(victim.token, raceId, cleanse.id);

      assert.equal(res.status, 200);
      assert.equal((await res.json()).result.cleared, 1);
      const after = await prisma.raceActiveEffect.findUnique({
        where: { id: outageEffect.id },
      });
      assert.equal(after.status, "EXPIRED");
      assert.ok(after.expiresAt.getTime() < outageEffect.expiresAt.getTime());
      const usedCleanse = await prisma.racePowerup.findUnique({
        where: { id: cleanse.id },
      });
      assert.equal(usedCleanse.status, "USED");
    });

    it("Quick Rinse bypasses a live Power Outage jam and halves the outage", async () => {
      const { victim, raceId, outageEffect } = await outageOnVictim();
      const rinse = await giveHeld(raceId, victim.userId, "QUICK_RINSE");

      const beforeUse = Date.now();
      const res = await usePU(victim.token, raceId, rinse.id);
      const afterUse = Date.now();

      assert.equal(res.status, 200);
      assert.equal((await res.json()).result.shortened, 1);
      const after = await prisma.raceActiveEffect.findUnique({
        where: { id: outageEffect.id },
      });
      assert.equal(after.status, "ACTIVE");
      const originalExpiry = outageEffect.expiresAt.getTime();
      const earliestExpected = Math.floor((originalExpiry + beforeUse) / 2) - 1;
      const latestExpected = Math.ceil((originalExpiry + afterUse) / 2) + 1;
      assert.ok(
        after.expiresAt.getTime() >= earliestExpected &&
          after.expiresAt.getTime() <= latestExpected,
        "new expiry is the midpoint between the use time and original expiry"
      );
      const usedRinse = await prisma.racePowerup.findUnique({
        where: { id: rinse.id },
      });
      assert.equal(usedRinse.status, "USED");
    });

    it("Signal Jammer still blocks Cleanse when both jam types are live", async () => {
      const { victim, raceId, outageEffect } = await outageOnVictim();
      const staleSignalJammer = await giveEffect(
        raceId,
        victim.userId,
        outageEffect.sourceUserId,
        "SIGNAL_JAMMER",
        { expiresAt: new Date(Date.now() - HOUR_MS) }
      );
      const signalJammer = await giveEffect(
        raceId,
        victim.userId,
        outageEffect.sourceUserId,
        "SIGNAL_JAMMER",
        { expiresAt: new Date(Date.now() + HOUR_MS) }
      );
      const cleanse = await giveHeld(raceId, victim.userId, "CLEANSE");

      const res = await usePU(victim.token, raceId, cleanse.id);

      assert.equal(res.status, 409);
      assert.match((await res.json()).error, /jammed/i);
      const effectsAfter = await prisma.raceActiveEffect.findMany({
        where: {
          id: {
            in: [outageEffect.id, staleSignalJammer.id, signalJammer.id],
          },
        },
      });
      assert.ok(effectsAfter.every((effect) => effect.status === "ACTIVE"));
      const heldCleanse = await prisma.racePowerup.findUnique({
        where: { id: cleanse.id },
      });
      assert.equal(heldCleanse.status, "HELD");
    });
  });

  // ── 8. Rally Flag ───────────────────────────────────────────────────────
  describe("restart-atomic effect expiry", () => {
    it("serializes Fanny expiry before a real Pocket Watch command without an ABBA deadlock", async () => {
      const a = await createUser("Lock Order Packer");
      const b = await createUser("Lock Order Observer");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      const target = await participant(raceId, a.userId);
      await prisma.raceParticipant.update({
        where: { id: target.id },
        data: { powerupSlots: 4 },
      });
      const originalExpiry = new Date(Date.now() + HOUR_MS);
      const effect = await giveEffect(raceId, a.userId, a.userId, "FANNY_PACK", {
        expiresAt: originalExpiry,
      });
      const watch = await giveHeld(raceId, a.userId, "POCKET_WATCH");

      let announceParticipantLock;
      const participantLocked = new Promise((resolve) => {
        announceParticipantLock = resolve;
      });
      let releaseParticipantLock;
      const holdParticipantLock = new Promise((resolve) => {
        releaseParticipantLock = resolve;
      });
      const expireAtBoundary = buildExpireEffects({
        prisma,
        now: () => new Date(originalExpiry.getTime() + 1),
        eventBus: { emit() {} },
        afterFannyParticipantLock: async () => {
          announceParticipantLock();
          await holdParticipantLock;
        },
      });

      const expiryPromise = expireAtBoundary({ raceId });
      await Promise.race([
        participantLocked,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error("Fanny expiry never acquired the participant-first lock")),
          2_000,
        )),
      ]);
      const watchPromise = usePU(a.token, raceId, watch.id);
      releaseParticipantLock();

      await expiryPromise;
      const watchResponse = await watchPromise;
      assert.equal(watchResponse.status, 400);
      assert.match((await watchResponse.json()).error, /active timed buff/i);
      assert.equal((await participant(raceId, a.userId)).powerupSlots, 3);
      assert.equal(
        (await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } })).status,
        "EXPIRED",
      );
      assert.equal(
        (await prisma.racePowerup.findUnique({ where: { id: watch.id } })).status,
        "HELD",
      );
    });

    it("rolls back a killed Fanny Pack expiry and decrements/feed-writes once on retry", async () => {
      const a = await createUser("Atomic Packer");
      const b = await createUser("Atomic Observer");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      const target = await participant(raceId, a.userId);
      await prisma.raceParticipant.update({
        where: { id: target.id },
        data: { powerupSlots: 4 },
      });
      const effect = await giveEffect(raceId, a.userId, a.userId, "FANNY_PACK", {
        expiresAt: new Date(Date.now() - 60_000),
      });
      const task = await prisma.raceResolutionPostTask.create({
        data: {
          raceId,
          sourceGeneration: 999,
          dedupeKey: `atomic-expiry:${raceId}`,
          state: "running",
          requestedAt: new Date(),
          notBeforeAt: new Date(),
          snapshotCommand: { raceId, timeZone: "UTC" },
          payloadBytes: 32,
          intentCount: 0,
          leaseToken: "stale-expiry-lease",
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const killed = buildExpireEffects({
        prisma,
        eventBus: { emit() {} },
        afterEffectConsequenceWrite: async () => {
          throw Object.assign(new Error("simulated process death"), { code: "KILL_POINT" });
        },
      });

      await assert.rejects(() => killed({
        raceId,
        taskFence: { taskId: task.id, leaseToken: "stale-expiry-lease" },
      }), { code: "KILL_POINT" });
      assert.equal((await participant(raceId, a.userId)).powerupSlots, 4);
      assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } })).status, "ACTIVE");
      assert.equal(await prisma.racePowerupEvent.count({
        where: { raceId, eventType: "EFFECT_EXPIRED", powerupType: "FANNY_PACK" },
      }), 0);

      await prisma.raceResolutionPostTask.update({
        where: { id: task.id },
        data: { leaseToken: "fresh-expiry-lease", leaseExpiresAt: new Date(Date.now() + 60_000) },
      });
      const retry = buildExpireEffects({ prisma, eventBus: { emit() {} } });
      await assert.rejects(() => retry({
        raceId,
        taskFence: { taskId: task.id, leaseToken: "stale-expiry-lease" },
      }), { code: "POST_TASK_FENCE_LOST" });
      await retry({
        raceId,
        taskFence: { taskId: task.id, leaseToken: "fresh-expiry-lease" },
      });
      await retry({
        raceId,
        taskFence: { taskId: task.id, leaseToken: "fresh-expiry-lease" },
      });
      assert.equal((await participant(raceId, a.userId)).powerupSlots, 3);
      assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } })).status, "EXPIRED");
      assert.equal(await prisma.racePowerupEvent.count({
        where: { raceId, eventType: "EFFECT_EXPIRED", powerupType: "FANNY_PACK" },
      }), 1);
    });
  });

  describe("rally flag", () => {
    it("rejected 400 outside a team race", async () => {
      await seedCatalog();
      const a = await createUser("Flagger"); const b = await createUser("X");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      const pw = await giveHeld(raceId, a.userId, "RALLY_FLAG");
      const res = await usePU(a.token, raceId, pw.id, {});
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /team race/i);
    });
  });

  // ── 10. Drill Sergeant ──────────────────────────────────────────────────
  // ── 11. Piggy Bank ──────────────────────────────────────────────────────
  describe("piggy bank", () => {
    it("defers the real auth cache invalidation until the atomic expiry commits", async () => {
      const a = await createUser("Deferred Cache Saver");
      const b = await createUser("Deferred Cache Witness");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      const startsAt = new Date(Math.floor((Date.now() - 6 * HOUR_MS) / HOUR_MS) * HOUR_MS);
      const expiresAt = new Date(Math.floor((Date.now() - 2 * HOUR_MS) / HOUR_MS) * HOUR_MS);
      await giveHourlySamples(a.userId, 6, 4, 1500);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt,
        expiresAt,
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });

      const authMeCache = require("../../../src/modules/users/services/authMeCache");
      const originalInvalidate = authMeCache.invalidateSafe;
      const invalidated = [];
      authMeCache.invalidateSafe = async (userId) => { invalidated.push(userId); };
      let consequenceReached = false;
      try {
        const expire = buildExpireEffects({
          prisma,
          eventBus: { emit() {} },
          afterEffectConsequenceWrite: async () => {
            consequenceReached = true;
            assert.deepEqual(
              invalidated,
              [],
              "external cache I/O must not begin while expiry locks are held",
            );
          },
        });
        await expire({ raceId });
      } finally {
        authMeCache.invalidateSafe = originalInvalidate;
      }

      assert.equal(consequenceReached, true);
      assert.deepEqual(invalidated, [a.userId]);
    });

    it("rolls back a killed expiry and retries coin/feed consequences exactly once", async () => {
      const a = await createUser("Atomic Saver");
      const b = await createUser("Atomic Witness");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      const startsAt = new Date(Math.floor((Date.now() - 6 * HOUR_MS) / HOUR_MS) * HOUR_MS);
      const expiresAt = new Date(Math.floor((Date.now() - 2 * HOUR_MS) / HOUR_MS) * HOUR_MS);
      await giveHourlySamples(a.userId, 6, 4, 1500);
      const effect = await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt,
        expiresAt,
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const coinsBefore = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      const killed = buildExpireEffects({
        prisma,
        eventBus: { emit() {} },
        afterEffectConsequenceWrite: async () => {
          throw Object.assign(new Error("simulated process death"), { code: "KILL_POINT" });
        },
      });

      await assert.rejects(() => killed({ raceId }), { code: "KILL_POINT" });
      assert.equal((await prisma.user.findUnique({ where: { id: a.userId } })).coins, coinsBefore);
      assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } })).status, "ACTIVE");
      assert.equal(await prisma.coinTransaction.count({
        where: { userId: a.userId, reason: "piggy_bank", refId: effect.id },
      }), 0);
      assert.equal(await prisma.racePowerupEvent.count({
        where: { raceId, eventType: "EFFECT_EXPIRED", powerupType: "PIGGY_BANK" },
      }), 0);

      const retry = buildExpireEffects({ prisma, eventBus: { emit() {} } });
      await retry({ raceId });
      await retry({ raceId });
      assert.equal((await prisma.user.findUnique({ where: { id: a.userId } })).coins, coinsBefore + 20);
      assert.equal(await prisma.coinTransaction.count({
        where: { userId: a.userId, reason: "piggy_bank", refId: effect.id },
      }), 1);
      assert.equal(await prisma.racePowerupEvent.count({
        where: { raceId, eventType: "EFFECT_EXPIRED", powerupType: "PIGGY_BANK" },
      }), 1);
    });

    it("mints coins at expiry (rate/cap), exactly once", async () => {
      const a = await createUser("Saver");
      const b = await createUser("Z");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      // 4 closed hourly samples of 1500 = 6000 steps in window → floor(6000/300)=20 coins.
      await giveHourlySamples(a.userId, 6, 4, 1500);
      const coinsBefore = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      const eff = await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: new Date(Math.floor((Date.now() - 6 * HOUR_MS) / HOUR_MS) * HOUR_MS),
        expiresAt: new Date(Math.floor((Date.now() - 2 * HOUR_MS) / HOUR_MS) * HOUR_MS),
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const { expireEffects } = require("../../../src/modules/powerups/commands/expireEffects");
      await expireEffects({ raceId });
      const afterOne = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      assert.equal(afterOne - coinsBefore, 20, "20 coins minted");
      // Second run (settlement) is idempotent via refId.
      await prisma.race.update({ where: { id: raceId }, data: { endsAt: new Date(Date.now() - 60 * 1000) } });
      await resolveExpiredRaces();
      const afterTwo = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      assert.equal(afterTwo, afterOne, "no double mint");
      const txns = await prisma.coinTransaction.findMany({ where: { userId: a.userId, reason: "piggy_bank" } });
      assert.equal(txns.length, 1);
    });

    it("only one ACTIVE piggy per user globally (cross-race 409)", async () => {
      await seedCatalog();
      const a = await createUser("MultiSaver"); const b = await createUser("Y"); const c = await createUser("W");
      await makeFriends(a, b); await makeFriends(a, c);
      const race1 = await createActiveRace(a, [b], { name: "Race One" });
      const race2 = await createActiveRace(a, [c], { name: "Race Two" });
      const pw1 = await giveHeld(race1, a.userId, "PIGGY_BANK");
      assert.equal((await usePU(a.token, race1, pw1.id, {})).status, 200);
      const pw2 = await giveHeld(race2, a.userId, "PIGGY_BANK");
      const res = await usePU(a.token, race2, pw2.id, {});
      assert.equal(res.status, 409, "second piggy in another race blocked");
      assert.equal((await prisma.racePowerup.findUnique({ where: { id: pw2.id } })).status, "HELD");
    });
  });

  // ── 11b. Piggy Bank live "banked so far" counter (display-only) ──────────
  // The viewer's OWN active PIGGY_BANK entry in progress carries an additive
  // piggyBank:{bankedCoins,coinCap,windowSteps} computed with the SAME
  // sumStepsInWindow the mint uses over [startsAt, min(expiresAt, now)]. No coin
  // writes, no mint-timing change. See piggy-bank-live-counter-requirements.md.
  describe("piggy bank live counter", () => {
    // hour-aligned start N hours ago (matches giveHourlySamples bucketing).
    const alignedHoursAgo = (h) =>
      new Date(Math.floor((Date.now() - h * HOUR_MS) / HOUR_MS) * HOUR_MS);

    it("owner sees bankedCoins = floor(windowSteps/rate), coinCap, windowSteps", async () => {
      const a = await createUser("LiveSaver");
      const b = await createUser("LZ");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      // 4 closed hourly samples of 1500 = 6000 steps inside the window.
      await giveHourlySamples(a.userId, 6, 4, 1500);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: alignedHoursAgo(6),
        expiresAt: new Date(Date.now() + HOUR_MS), // future → endCap = now
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const prog = await getProgress(a.token, raceId);
      const eff = findEffect(prog, "PIGGY_BANK", a.userId);
      assert.ok(eff, "owner sees their piggy entry");
      assert.ok(eff.piggyBank, "piggyBank field present");
      assert.equal(eff.piggyBank.bankedCoins, 20, "floor(6000/300)=20");
      assert.equal(eff.piggyBank.coinCap, 80, "cap from snapshot");
      assert.ok(
        Math.abs(eff.piggyBank.windowSteps - 6000) <= 100,
        `windowSteps ≈ 6000 (got ${eff.piggyBank.windowSteps})`
      );
      assert.equal(Number.isInteger(eff.piggyBank.windowSteps), true, "windowSteps is int");
    });

    it("clamps bankedCoins to coinCap when steps exceed cap*rate", async () => {
      const a = await createUser("CapSaver");
      const b = await createUser("CZ");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      // 5 × 6000 = 30000 steps → floor(30000/300)=100, clamped to cap 80.
      await giveHourlySamples(a.userId, 6, 5, 6000);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: alignedHoursAgo(6),
        expiresAt: new Date(Date.now() + HOUR_MS),
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const prog = await getProgress(a.token, raceId);
      const eff = findEffect(prog, "PIGGY_BANK", a.userId);
      assert.equal(eff.piggyBank.bankedCoins, 80, "clamped to coinCap");
      assert.equal(eff.piggyBank.coinCap, 80);
    });

    it("excludes steps taken before startsAt", async () => {
      const a = await createUser("EarlySaver");
      const b = await createUser("EZ");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      // Pre-activation sample (now-6h, 9000 steps) must NOT count.
      await giveHourlySamples(a.userId, 6, 1, 9000);
      // In-window samples: now-3h and now-2h, 1500 each = 3000.
      await giveHourlySamples(a.userId, 3, 2, 1500);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: alignedHoursAgo(3),
        expiresAt: new Date(Date.now() + HOUR_MS),
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const prog = await getProgress(a.token, raceId);
      const eff = findEffect(prog, "PIGGY_BANK", a.userId);
      assert.equal(eff.piggyBank.bankedCoins, 10, "floor(3000/300)=10, pre-start excluded");
      assert.ok(
        Math.abs(eff.piggyBank.windowSteps - 3000) <= 100,
        `windowSteps ≈ 3000 (got ${eff.piggyBank.windowSteps})`
      );
    });

    it("kill-switch snapshot (coinCap:0) → entry present, piggyBank absent", async () => {
      const a = await createUser("DeadSaver");
      const b = await createUser("DZ");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await giveHourlySamples(a.userId, 6, 4, 1500);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: alignedHoursAgo(6),
        expiresAt: new Date(Date.now() + HOUR_MS),
        metadata: { stepsPerCoin: 300, coinCap: 0, stepsAtStart: 0 },
      });
      const prog = await getProgress(a.token, raceId);
      const eff = findEffect(prog, "PIGGY_BANK", a.userId);
      assert.ok(eff, "entry still present");
      assert.equal(eff.piggyBank, undefined, "no piggyBank field when nothing will mint");
    });

    it("opponent never sees the owner's piggy entry (HIDDEN_FROM_OPPONENTS holds)", async () => {
      const a = await createUser("HiddenSaver");
      const b = await createUser("HZ");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await giveHourlySamples(a.userId, 6, 4, 1500);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: alignedHoursAgo(6),
        expiresAt: new Date(Date.now() + HOUR_MS),
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const bProg = await getProgress(b.token, raceId);
      assert.equal(findEffect(bProg, "PIGGY_BANK"), undefined, "no piggy entry for opponent");
    });

    it("non-powerups5 client sees no PIGGY_BANK entry at all", async () => {
      const a = await createUser("OldSaver");
      const b = await createUser("OZ");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await giveHourlySamples(a.userId, 6, 4, 1500);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: alignedHoursAgo(6),
        expiresAt: new Date(Date.now() + HOUR_MS),
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const prog = await getProgress(a.token, raceId, OLD);
      assert.equal(findEffect(prog, "PIGGY_BANK"), undefined, "withheld without powerups5");
    });
  });

  // ── 12. Bounty ──────────────────────────────────────────────────────────
  describe("bounty", () => {
    it("must target a rival ahead; pays out when the caster out-places the target; publicly visible", async () => {
      await seedCatalog();
      const a = await createUser("Hunter"); const b = await createUser("Prey");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await setSteps(raceId, a.userId, 3000);
      await setSteps(raceId, b.userId, 9000); // b ahead of a

      // a can't target someone behind: try targeting nobody-ahead is enforced by ahead check.
      const behindPw = await giveHeld(raceId, b.userId, "BOUNTY");
      const behindRes = await usePU(b.token, raceId, behindPw.id, { targetUserId: a.userId });
      assert.equal(behindRes.status, 400, "cannot bounty a rival behind you");

      const pw = await giveHeld(raceId, a.userId, "BOUNTY");
      const ok = await usePU(a.token, raceId, pw.id, { targetUserId: b.userId });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).result.payoutCoins, 150);

      // Bounty is publicly visible to the target.
      const bProg = await getProgress(b.token, raceId);
      assert.ok(findEffect(bProg, "BOUNTY"), "bounty visible to opponent");

      // Now a out-places b. Settlement recomputes totals from step samples, so
      // seed a >> b to make the final placement deterministic.
      await giveHourlySamples(a.userId, 6, 5, 4000); // 20000
      await giveHourlySamples(b.userId, 6, 1, 500);  // 500
      const coinsBefore = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      await prisma.race.update({ where: { id: raceId }, data: { endsAt: new Date(Date.now() - 60 * 1000) } });
      await resolveExpiredRaces();
      const coinsAfter = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      assert.equal(coinsAfter - coinsBefore, 150, "bounty paid on out-place");
      // Idempotent second settle.
      await resolveExpiredRaces();
      const coinsAfter2 = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      assert.equal(coinsAfter2, coinsAfter, "no double bounty payout");
    });

    it("no payout when the caster does NOT out-place the target", async () => {
      await seedCatalog();
      const a = await createUser("Hunter2"); const b = await createUser("Prey2");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await setSteps(raceId, a.userId, 3000);
      await setSteps(raceId, b.userId, 9000);
      const pw = await giveHeld(raceId, a.userId, "BOUNTY");
      await usePU(a.token, raceId, pw.id, { targetUserId: b.userId });
      // b stays ahead at settlement (seed b >> a) → no payout.
      await giveHourlySamples(a.userId, 6, 1, 500);
      await giveHourlySamples(b.userId, 6, 5, 4000);
      const coinsBefore = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      await prisma.race.update({ where: { id: raceId }, data: { endsAt: new Date(Date.now() - 60 * 1000) } });
      await resolveExpiredRaces();
      const coinsAfter = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      assert.equal(coinsAfter, coinsBefore, "no payout when not out-placed");
    });

    it("rejected 400 on a target-step race (no fixed end)", async () => {
      await seedCatalog();
      const a = await createUser("Hunter3"); const b = await createUser("Prey3");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b], { endsAt: null });
      await setSteps(raceId, a.userId, 1000);
      await setSteps(raceId, b.userId, 9000);
      const pw = await giveHeld(raceId, a.userId, "BOUNTY");
      const res = await usePU(a.token, raceId, pw.id, { targetUserId: b.userId });
      assert.equal(res.status, 400);
    });
  });

  // ── 3. Ghost Pepper (not cleansable) ────────────────────────────────────
  describe("ghost pepper", () => {
    it("self-inflicted freeze is not removable by Cleanse", async () => {
      const a = await createUser("Spicy");
      const b = await createUser("Q");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", {
        startsAt: new Date(Date.now() - 10 * 60 * 1000),
        expiresAt: new Date(Date.now() + 50 * 60 * 1000),
        metadata: { boostMs: 30 * 60 * 1000, multiplier: 3, freezeMs: 30 * 60 * 1000, stepsAtBoostStart: 0 },
      });
      const cleanse = await giveHeld(raceId, a.userId, "CLEANSE");
      const res = await usePU(a.token, raceId, cleanse.id, {});
      // Cleanse rejects (no opponent debuffs) — ghost pepper is self-sourced.
      assert.equal(res.status, 400);
      const gp = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "GHOST_PEPPER" } });
      assert.equal(gp.status, "ACTIVE", "ghost pepper survives cleanse");
    });
  });

  // ── 5. Mystery Potion ───────────────────────────────────────────────────
  describe("mystery potion", () => {
    it("resolves to a valid rolled outcome and never fails after consumption", async () => {
      await seedCatalog();
      const a = await createUser("Alchemist", 100); const b = await createUser("Rival");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await setSteps(raceId, b.userId, 5000);
      const pw = await giveHeld(raceId, a.userId, "MYSTERY_POTION");
      const res = await usePU(a.token, raceId, pw.id, {});
      assert.equal(res.status, 200);
      const r = (await res.json()).result;
      assert.ok(r.rolled, "a rolled outcome is reported");
      assert.equal((await prisma.racePowerup.findUnique({ where: { id: pw.id } })).status, "USED");
    });
  });
});

})();
