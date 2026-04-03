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
  const appleId = `apple-lc-${++nextAppleId}`;
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

async function createActiveRace(alice, bob, opts = {}) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Leg Cramp Test",
      targetSteps: opts.targetSteps || 200000,
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
  // Default backdate so step samples fall within race window
  const defaultStart = new Date(Date.now() - 7 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: defaultStart } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: defaultStart } });
  return raceId;
}

// Override race start to a specific time
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

// Helper: create a date relative to now
function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

function minutesAgo(m) {
  return new Date(Date.now() - m * 60 * 1000);
}

describe("leg cramp", () => {
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
    it("steps walked during freeze window are subtracted from total", async () => {
      const alice = await createUser("AliceCrampAA");
      const bob = await createUser("BobCrampAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Apply freeze, then backdate its startsAt so we can place samples inside it
      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      const useRes = await usePowerup(alice.token, raceId, cramp.id, bob.userId);
      assert.equal(useRes.status, 200);

      // Backdate freeze to 3h ago → expires 1h ago
      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEG_CRAMP" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { startsAt: hoursAgo(3), expiresAt: hoursAgo(1) },
      });

      // Bob walks 3000 steps BEFORE freeze window (5h-4h ago, before 3h ago)
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(5).toISOString(), periodEnd: hoursAgo(4).toISOString(), steps: 3000 },
      ]);

      // Bob walks 2000 steps DURING freeze window (2.5h-1.5h ago, within 3h-1h ago)
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(2.5).toISOString(), periodEnd: hoursAgo(1.5).toISOString(), steps: 2000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);

      // Bob should have 3000 (pre-freeze) but not the 2000 during freeze
      assert.equal(bobP.totalSteps, 3000);
    });

    it("steps walked before the freeze still count", async () => {
      const alice = await createUser("AliceCrampBB");
      const bob = await createUser("BobCrampBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Bob walks before any freeze (1h ago, well within backdated race start of 7h ago)
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(1).toISOString(), periodEnd: minutesAgo(30).toISOString(), steps: 8000 },
      ]);

      // Apply freeze NOW (samples are before the freeze window)
      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      await usePowerup(alice.token, raceId, cramp.id, bob.userId);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 8000);
    });

    it("can freeze someone with 0 steps", async () => {
      const alice = await createUser("AliceCrampCC");
      const bob = await createUser("BobCrampCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      const res = await usePowerup(alice.token, raceId, cramp.id, bob.userId);
      assert.equal(res.status, 200);

      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEG_CRAMP" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { startsAt: minutesAgo(20), expiresAt: new Date(Date.now() + 100 * 60 * 1000) },
      });

      // Steps walked during freeze should be frozen
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(10).toISOString(), periodEnd: new Date().toISOString(), steps: 1500 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 0);
    });

    it("bonus steps (protein shake) still apply during freeze", async () => {
      const alice = await createUser("AliceCrampDD");
      const bob = await createUser("BobCrampDDDD");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Alice freezes bob
      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      await usePowerup(alice.token, raceId, cramp.id, bob.userId);

      // Bob uses protein shake while frozen — bonus should still count
      const shake = await giveHeldPowerup(raceId, bob.userId, "PROTEIN_SHAKE", 99902);
      await usePowerup(bob.token, raceId, shake.id);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 1500);
    });
  });

  // === PRORATING (currently broken — tests should expose the bug) ===

  describe("prorating at window boundaries", () => {
    it("sample overlapping freeze start: only steps during freeze are frozen", async () => {
      const alice = await createUser("AlicePrortAA");
      const bob = await createUser("BobProrateAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Create a leg cramp effect directly in DB starting 1 hour ago
      const freezeStart = hoursAgo(1);
      const freezeEnd = new Date(freezeStart.getTime() + 2 * 60 * 60 * 1000); // +2h from start
      const bobParticipant = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
      const powerup = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      await prisma.racePowerup.update({ where: { id: powerup.id }, data: { status: "USED" } });
      await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: bobParticipant.id,
          targetUserId: bob.userId,
          sourceUserId: alice.userId,
          powerupId: powerup.id,
          type: "LEG_CRAMP",
          status: "ACTIVE",
          startsAt: freezeStart,
          expiresAt: freezeEnd,
          metadata: { stepsAtFreezeStart: 0 },
        },
      });

      // Bob has a sample that spans 90min ago to 30min ago (1 hour sample)
      // Freeze started 60min ago, so overlap is 60min-30min = 30min out of 60min sample
      // 1000 steps in 60 min → ~500 steps should be frozen (30/60 of the sample)
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(90).toISOString(), periodEnd: minutesAgo(30).toISOString(), steps: 1000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);

      // With correct prorating: 500 of the 1000 steps overlap the freeze → freeze 500 → total = 500
      // Without prorating (current bug): all 1000 frozen → total = 0
      assert.equal(bobP.totalSteps, 500, "should prorate: only 500 of 1000 steps overlap the freeze window");
    });

    it("sample overlapping freeze end: only steps during freeze are frozen", async () => {
      const alice = await createUser("AlicePrortBB");
      const bob = await createUser("BobProrateBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Create an EXPIRED leg cramp that ended 30 min ago
      const freezeStart = hoursAgo(2.5);
      const freezeEnd = minutesAgo(30);
      const bobParticipant = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
      const powerup = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      await prisma.racePowerup.update({ where: { id: powerup.id }, data: { status: "USED" } });
      await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: bobParticipant.id,
          targetUserId: bob.userId,
          sourceUserId: alice.userId,
          powerupId: powerup.id,
          type: "LEG_CRAMP",
          status: "EXPIRED",
          startsAt: freezeStart,
          expiresAt: freezeEnd,
          metadata: { stepsAtFreezeStart: 0, stepsAtExpiry: 0 },
        },
      });

      // Bob has a sample spanning 60min ago to now (1 hour)
      // Freeze ended 30min ago, so overlap is 60min-30min = 30min out of 60min
      // 1000 steps → ~500 should be frozen
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(60).toISOString(), periodEnd: new Date().toISOString(), steps: 1000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);

      // With correct prorating: 500 frozen → total = 500
      // Without prorating (current bug): all 1000 frozen → total = 0
      assert.equal(bobP.totalSteps, 500, "should prorate: only 500 of 1000 steps overlap the freeze window");
    });
  });

  // === VALIDATION ===

  describe("validation", () => {
    it("requires a target", async () => {
      const alice = await createUser("AliceValAAAA");
      const bob = await createUser("BobValAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      const res = await usePowerup(alice.token, raceId, cramp.id);
      assert.equal(res.status, 400);
    });

    it("cannot target yourself", async () => {
      const alice = await createUser("AliceValBBBB");
      const bob = await createUser("BobValBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      const res = await usePowerup(alice.token, raceId, cramp.id, alice.userId);
      assert.equal(res.status, 400);
    });

    it("cannot stack — rejects if target already has active leg cramp", async () => {
      const alice = await createUser("AliceValCCCC");
      const bob = await createUser("BobValCCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const c1 = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      const c2 = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99902);

      await usePowerup(alice.token, raceId, c1.id, bob.userId);

      const res = await usePowerup(alice.token, raceId, c2.id, bob.userId);
      assert.equal(res.status, 400);
    });

    it("cannot target finished participant", async () => {
      const alice = await createUser("AliceValDDDD");
      const bob = await createUser("BobValDDDDDD");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob, { targetSteps: 1000 });

      // Bob finishes
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(1).toISOString(), periodEnd: new Date().toISOString(), steps: 2000 },
      ]);
      await getProgress(bob.token, raceId); // trigger finish detection

      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      const res = await usePowerup(alice.token, raceId, cramp.id, bob.userId);
      assert.ok(res.status >= 400);
    });
  });

  // === SHIELD INTERACTION ===

  describe("shield interaction", () => {
    it("blocked by compression socks — no effect created", async () => {
      const alice = await createUser("AliceShldAAA");
      const bob = await createUser("BobShieldAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);
      await backdateRaceStart(raceId, hoursAgo(6));

      // Bob walks and activates shield
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(3).toISOString(), periodEnd: hoursAgo(2).toISOString(), steps: 5000 },
      ]);
      const shield = await giveHeldPowerup(raceId, bob.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(bob.token, raceId, shield.id);

      // Alice tries to freeze bob
      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99902);
      const res = await usePowerup(alice.token, raceId, cramp.id, bob.userId);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.blocked, true);

      // Bob walks more — should count (no freeze applied)
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(30).toISOString(), periodEnd: new Date().toISOString(), steps: 2000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 7000); // 5000 + 2000, no freeze
    });
  });

  // === EFFECT INTERACTIONS ===

  describe("effect interactions", () => {
    it("wrong turn cancels an active leg cramp on same target", async () => {
      const alice = await createUser("AliceInterAA");
      const bob = await createUser("BobInterAAAA");
      const charlie = await createUser("CharlieInterA");
      await makeFriends(alice, bob);
      await makeFriends(alice, charlie);

      // Need charlie in the race too
      const createRes = await request(server.baseUrl, "POST", "/races", {
        body: { name: "Interaction Test", targetSteps: 200000, maxDurationDays: 7, powerupsEnabled: true, powerupStepInterval: 5000 },
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

      // Alice freezes bob
      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      await usePowerup(alice.token, raceId, cramp.id, bob.userId);

      // Charlie uses wrong turn on bob (should cancel the cramp)
      const wrongTurn = await giveHeldPowerup(raceId, charlie.userId, "WRONG_TURN", 99902);
      const res = await usePowerup(charlie.token, raceId, wrongTurn.id, bob.userId);
      assert.equal(res.status, 200);

      // Now a second leg cramp should work (old one was cancelled)
      const cramp2 = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99903);
      const res2 = await usePowerup(alice.token, raceId, cramp2.id, bob.userId);
      assert.equal(res2.status, 200);
    });
  });

  // === EXPIRY ===

  describe("expiry", () => {
    it("after expiry, new steps resume counting", async () => {
      const alice = await createUser("AliceExpAAAA");
      const bob = await createUser("BobExpAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Create an already-expired leg cramp (ended 30 min ago)
      const bobParticipant = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
      const powerup = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      await prisma.racePowerup.update({ where: { id: powerup.id }, data: { status: "USED" } });
      await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: bobParticipant.id,
          targetUserId: bob.userId,
          sourceUserId: alice.userId,
          powerupId: powerup.id,
          type: "LEG_CRAMP",
          status: "EXPIRED",
          startsAt: hoursAgo(3),
          expiresAt: hoursAgo(1),
          metadata: { stepsAtFreezeStart: 0, stepsAtExpiry: 0 },
        },
      });

      // Bob walks steps entirely after freeze ended — should count
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(30).toISOString(), periodEnd: new Date().toISOString(), steps: 4000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 4000);
    });

    it("feed shows both usage and expiry events", async () => {
      const alice = await createUser("AliceExpBBBB");
      const bob = await createUser("BobExpBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Create leg cramp that should expire immediately
      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      await usePowerup(alice.token, raceId, cramp.id, bob.userId);

      // Force expiry by setting expiresAt to the past
      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEG_CRAMP" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { expiresAt: minutesAgo(1) },
      });

      // Fetch progress to trigger expiry
      await getProgress(alice.token, raceId);

      const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
      const feedBody = await feedRes.json();

      const useEvent = feedBody.events.find(
        (e) => e.eventType === "POWERUP_USED" && e.powerupType === "LEG_CRAMP"
      );
      const expiryEvent = feedBody.events.find(
        (e) => e.eventType === "EFFECT_EXPIRED" && e.powerupType === "LEG_CRAMP"
      );
      assert.ok(useEvent, "feed should have usage event");
      assert.ok(expiryEvent, "feed should have expiry event");
    });
  });
});
