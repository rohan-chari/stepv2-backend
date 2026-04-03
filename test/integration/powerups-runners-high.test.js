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
      await getProgress(alice.token, raceId); // triggers expiry

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
  });
});
