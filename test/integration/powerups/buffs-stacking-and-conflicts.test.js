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

describe("buff stacking (sum) + signed event scoring — integration", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); await prisma.globalStepEvent.deleteMany(); nextAppleId = 0; });
  after(async () => { await prisma.globalStepEvent.deleteMany(); });

  // Boost/freeze ghost pepper covering [startH..startH-boostHours] as boost.
  function pepperMeta(mult = 3) {
    return { boostMs: HOUR_MS, multiplier: mult, freezeMs: HOUR_MS, stepsAtBoostStart: 0 };
  }

  // 1. Pepper boost + 2x event → 6x (DrAmogh's case; the headline bug).
  it("pepper boost + 2x event = 6x", async () => {
    const a = await createUser("A1"); const b = await createUser("B1");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100); // [4h,3h)
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", {
      startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(2), metadata: pepperMeta(3), // boost [4h,3h), freeze [3h,2h)
    });
    await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
    const prog = await getProgress(a.token, raceId);
    assert.equal(boardSteps(prog, a.userId), 600, "100 base + 200 buff + 300 event = 600 (6x)");
  });

  // 2. Pepper + RH, no event → 5x (sum replaces max).
  it("pepper + runner's high, no event = 5x", async () => {
    const a = await createUser("A2"); const b = await createUser("B2");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100);
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(2), metadata: pepperMeta(3) });
    await giveEffect(raceId, a.userId, a.userId, "RUNNERS_HIGH", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: {} });
    const prog = await getProgress(a.token, raceId);
    assert.equal(boardSteps(prog, a.userId), 500, "3x + 2x summed = 5x (not max 3x)");
  });

  // 3. Pepper + RH + 2x event → 10x (the owner's target number).
  it("pepper + RH + 2x event = 10x", async () => {
    const a = await createUser("A3"); const b = await createUser("B3");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100);
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(2), metadata: pepperMeta(3) });
    await giveEffect(raceId, a.userId, a.userId, "RUNNERS_HIGH", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: {} });
    await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
    const prog = await getProgress(a.token, raceId);
    assert.equal(boardSteps(prog, a.userId), 1000, "5x rate × 2x event = 10x");
  });

  // 4. Pepper + RH + WT + 2x event → −10x (seed prior steps so the floor doesn't mask it).
  it("pepper + RH + wrong turn + 2x event = −10x", async () => {
    const a = await createUser("A4"); const b = await createUser("B4");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 7, 1, 2000); // prior, no effects → base 2000
    await giveHourlySamples(a.userId, 4, 1, 100);  // the reversed hour
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(2), metadata: pepperMeta(3) });
    await giveEffect(raceId, a.userId, a.userId, "RUNNERS_HIGH", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: {} });
    await giveEffect(raceId, a.userId, b.userId, "WRONG_TURN", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: { stepsAtStart: 0 } });
    await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
    const prog = await getProgress(a.token, raceId);
    // Pre-walk total = 2000. Walking 100 at −10x drops it by 1000 → 1000.
    assert.equal(boardSteps(prog, a.userId), 1000, "2100 base − 4000 buff − 200 reversal − 1000 event = 1000");
  });

  // 5. WT alone + 2x event → −2x (event credit goes negative — the latent leak).
  it("wrong turn alone + 2x event = −2x", async () => {
    const a = await createUser("A5"); const b = await createUser("B5");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 7, 1, 500); // prior base
    await giveHourlySamples(a.userId, 4, 1, 100); // reversed hour
    await giveEffect(raceId, a.userId, b.userId, "WRONG_TURN", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: { stepsAtStart: 0 } });
    await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
    const prog = await getProgress(a.token, raceId);
    // Pre-walk 500; walking 100 at −2x drops by 200 → 300.
    assert.equal(boardSteps(prog, a.userId), 300, "600 base − 200 reversal − 100 event = 300");
  });

  // 6. Pepper FREEZE phase + 2x event → 0 (frozen steps earn no event credit).
  it("pepper freeze phase + 2x event = 0", async () => {
    const a = await createUser("A6"); const b = await createUser("B6");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100); // [4h,3h) → the freeze half
    // boost [5h,4h), freeze [4h,3h)
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", { startsAt: alignedHoursAgo(5), expiresAt: alignedHoursAgo(3), metadata: pepperMeta(3) });
    await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
    const prog = await getProgress(a.token, raceId);
    assert.equal(boardSteps(prog, a.userId), 0, "frozen: 100 base − 100 frozen + 0 event = 0");
  });

  // 7. Freeze + WT overlap → 0 (freeze beats reversal).
  it("freeze + wrong turn = 0 (freeze beats WT)", async () => {
    const a = await createUser("A7"); const b = await createUser("B7");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100);
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", { startsAt: alignedHoursAgo(5), expiresAt: alignedHoursAgo(3), metadata: pepperMeta(3) }); // freeze [4h,3h)
    await giveEffect(raceId, a.userId, b.userId, "WRONG_TURN", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: { stepsAtStart: 0 } });
    const prog = await getProgress(a.token, raceId);
    assert.equal(boardSteps(prog, a.userId), 0, "freeze wins: no base, no reversal");
  });

  // 8. Three-way RH + Uprising(2) + Pepper → 7x (proves true sum, not pairwise).
  it("RH + uprising(2) + pepper = 7x (three-way sum)", async () => {
    const a = await createUser("A8"); const b = await createUser("B8");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100);
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(2), metadata: pepperMeta(3) });
    await giveEffect(raceId, a.userId, a.userId, "RUNNERS_HIGH", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: {} });
    await giveEffect(raceId, a.userId, a.userId, "UPRISING", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: { multiplier: 2 } });
    const prog = await getProgress(a.token, raceId);
    assert.equal(boardSteps(prog, a.userId), 700, "3 + 2 + 2 = 7x");
  });

  // 9. Campfire boost 2.25 + RH → 4.25x (old max test's scenario, new rule).
  it("campfire boost 2.25 + RH = 4.25x", async () => {
    const a = await createUser("A9"); const b = await createUser("B9");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100); // boost half [4h,3h)
    // freeze [5h,4h), boost [4h,3h)
    await giveEffect(raceId, a.userId, a.userId, "CAMPFIRE_REST", {
      startsAt: alignedHoursAgo(5), expiresAt: alignedHoursAgo(3),
      metadata: { freezeMs: HOUR_MS, boostMs: HOUR_MS, multiplier: 2.25, stepsAtRestStart: 0 },
    });
    await giveEffect(raceId, a.userId, a.userId, "RUNNERS_HIGH", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: {} });
    const prog = await getProgress(a.token, raceId);
    assert.equal(boardSteps(prog, a.userId), 425, "2.25 + 2 = 4.25x → 100 + 325");
  });

  // 10. Rainstorm + 2x event → 1x (reduction is multiplied by the event).
  it("rainstorm(0.5) + 2x event = 1x", async () => {
    const a = await createUser("A10"); const b = await createUser("B10");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100);
    await giveEffect(raceId, a.userId, b.userId, "RAINSTORM", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: { multiplier: 0.5, stepsAtStart: 0 } });
    await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
    const prog = await getProgress(a.token, raceId);
    // 0.5x rate × 2x event = 1x. 100 − 50 + 50 = 100.
    assert.equal(boardSteps(prog, a.userId), 100, "0.5 × 2 event = 1x");
  });

  // 11a. Settlement parity: scenario 3 active at race end, settled == live.
  it("settlement parity: settled total equals the live 10x total", async () => {
    const a = await createUser("A11"); const b = await createUser("B11");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100);
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(2), metadata: pepperMeta(3) });
    await giveEffect(raceId, a.userId, a.userId, "RUNNERS_HIGH", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: {} });
    await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
    const live = boardSteps(await getProgress(a.token, raceId), a.userId);
    assert.equal(live, 1000);
    await prisma.race.update({ where: { id: raceId }, data: { endsAt: new Date(Date.now() - 60 * 1000) } });
    await resolveExpiredRaces();
    const settled = await participant(raceId, a.userId);
    assert.equal(settled.totalSteps, live, "settled == live (no divergence)");
  });

  // 11b. determineFinishSnapshot interpolates a target crossing using the SUMMED
  // multiplier. This function is only reachable through settlement's tie-break
  // (races are time-based; no live target-finish), so it is asserted directly —
  // the same pattern test/services/raceStateResolution.test.js uses for it.
  it("determineFinishSnapshot interpolates the crossing at the summed (pepper+RH=5x) rate", async () => {
    const T0 = new Date("2026-04-07T10:00:00Z");
    const T1 = new Date("2026-04-07T11:00:00Z");
    const samples = [{ periodStart: T0.toISOString(), periodEnd: T1.toISOString(), steps: 1200 }]; // 20/min raw
    const snapshotDeps = {
      stepSampleModel: { async findByUserIdAndTimeRange() { return samples; } },
      powerupEventModel: { async findByRaceAsc() { return []; } },
    };
    const snapshot = await determineFinishSnapshot({
      participant: { userId: "user-1", bonusSteps: 0 },
      currentTotal: 6000, // 1200 × 5x
      targetSteps: 2500,
      effectiveStart: T0,
      effectGroups: {
        legCramps: [], runnersHighs: [{ startsAt: T0, expiresAt: T1, metadata: {} }], wrongTurns: [],
        campfires: [], rainstorms: [], uprisings: [], rallyFlags: [], coinFlipWins: [], coinFlipLoses: [],
        ghostPeppers: [{ startsAt: T0, expiresAt: T1, metadata: { boostMs: 60 * 60 * 1000, multiplier: 3 } }],
      },
      ...snapshotDeps,
      raceId: "race-1",
      now: T1,
    });
    // Raw 20/min at 5x = 100 counted/min → 2500 reached at minute 25 (10:25).
    // Old max(3,2)=3x would give 60/min → 2500 at ~41.7min, so 10:25 proves SUM.
    assert.equal(snapshot.finishTotalSteps, 2500);
    assert.equal(snapshot.finishedAt.toISOString(), "2026-04-07T10:25:00.000Z");
  });

  // ── Batch 2026-08-10b item 6 — RAINSTORM is MULTIPLICATIVE ──────────────
  //
  // Rainstorm multiplication is permanent. Scenario 10 above pins the
  // unbuffed case; these pin the buffed case end-to-end through the HTTP
  // response a client actually receives, including the retired env name.
  const RAIN_FLAG = "RAINSTORM_MULTIPLICATIVE_ENABLED";

  async function prodRepro(a, b, raceId) {
    // DrAmogh's row: Rally Flag (×1.25) + Ghost Pepper boost (×3) during a 2×
    // global step event, rainstormed. Buff sum = 4.25.
    await giveHourlySamples(a.userId, 4, 1, 100);
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", {
      startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(2), metadata: pepperMeta(3),
    });
    await giveEffect(raceId, a.userId, a.userId, "RALLY_FLAG", {
      startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: { multiplier: 1.25 },
    });
    await giveEffect(raceId, a.userId, b.userId, "RAINSTORM", {
      startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: { multiplier: 0.5, stepsAtStart: 0 },
    });
    await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
  }

  it("item 6 ON: buffed + rainstorm halves the whole stack (4.25 → 2.125, not 3.75)", async () => {
    process.env[RAIN_FLAG] = "true";
    try {
      const a = await createUser("A13"); const b = await createUser("B13");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await prodRepro(a, b, raceId);
      const prog = await getProgress(a.token, raceId);
      // rate 4.25 × 0.5 = 2.125; × 2 event = 4.25 → 100 walked steps score 425.
      assert.equal(boardSteps(prog, a.userId), 425, "2.125 rate × 2x event");
    } finally {
      delete process.env[RAIN_FLAG];
    }
  });

  it("retired OFF env cannot restore subtractive rainstorm scoring", async () => {
    process.env[RAIN_FLAG] = "false";
    try {
      const a = await createUser("A14"); const b = await createUser("B14");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await prodRepro(a, b, raceId);
      const prog = await getProgress(a.token, raceId);
      // Permanent: 4.25 × 0.5 × 2 event → 425, regardless of stale env.
      assert.equal(boardSteps(prog, a.userId), 425, "retired env cannot disable multiplication");
    } finally {
      delete process.env[RAIN_FLAG];
    }
  });

  it("item 6 ON: settlement matches the live buffed-storm total", async () => {
    process.env[RAIN_FLAG] = "true";
    try {
      const a = await createUser("A15"); const b = await createUser("B15");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await prodRepro(a, b, raceId);
      const live = boardSteps(await getProgress(a.token, raceId), a.userId);
      assert.equal(live, 425);
      await prisma.race.update({ where: { id: raceId }, data: { endsAt: new Date(Date.now() - 60 * 1000) } });
      await resolveExpiredRaces();
      const settled = await participant(raceId, a.userId);
      assert.equal(settled.totalSteps, live, "settled == live (no divergence)");
    } finally {
      delete process.env[RAIN_FLAG];
    }
  });

  it("item 6 ON: an unbuffed rainstormed racer is bit-identical to scenario 10", async () => {
    process.env[RAIN_FLAG] = "true";
    try {
      const a = await createUser("A16"); const b = await createUser("B16");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await giveHourlySamples(a.userId, 4, 1, 100);
      await giveEffect(raceId, a.userId, b.userId, "RAINSTORM", {
        startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: { multiplier: 0.5, stepsAtStart: 0 },
      });
      await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
      const prog = await getProgress(a.token, raceId);
      assert.equal(boardSteps(prog, a.userId), 100, "M=1 unbuffed: unchanged by the fix");
    } finally {
      delete process.env[RAIN_FLAG];
    }
  });

  it("item 6 ON: an umbrella'd victim is protected while it is up and halved after", async () => {
    process.env[RAIN_FLAG] = "true";
    try {
      const a = await createUser("A17"); const b = await createUser("B17");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      // Two walked hours; the umbrella covers only the first.
      await giveHourlySamples(a.userId, 5, 2, 100); // [5h,4h) and [4h,3h)
      await giveEffect(raceId, a.userId, a.userId, "RUNNERS_HIGH", {
        startsAt: alignedHoursAgo(5), expiresAt: alignedHoursAgo(3), metadata: {},
      });
      await giveEffect(raceId, a.userId, b.userId, "RAINSTORM", {
        startsAt: alignedHoursAgo(5), expiresAt: alignedHoursAgo(3), metadata: { multiplier: 0.5, stepsAtStart: 0 },
      });
      await giveEffect(raceId, a.userId, a.userId, "UMBRELLA", {
        startsAt: alignedHoursAgo(5), expiresAt: alignedHoursAgo(4), metadata: {},
      });
      const prog = await getProgress(a.token, raceId);
      // hour 1: RH 2x, umbrella cancels the rain → 200.
      // hour 2: RH 2x halved → 1x → 100. (Old rule: 2 − 0.5 = 1.5 → 150.)
      assert.equal(boardSteps(prog, a.userId), 300, "200 + 100");
    } finally {
      delete process.env[RAIN_FLAG];
    }
  });

  // 12. No-effects regression: with and without an event → plain 1x / 2x.
  it("no effects: 1x without event, 2x with event", async () => {
    const a = await createUser("A12"); const b = await createUser("B12");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100);
    const noEvent = boardSteps(await getProgress(a.token, raceId), a.userId);
    assert.equal(noEvent, 100, "1x with no effects and no event");

    await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
    const withEvent = boardSteps(await getProgress(a.token, raceId), a.userId);
    assert.equal(withEvent, 200, "2x with the event, still no per-participant effects");
  });
});

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
