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
  const appleId = `apple-wt-${++nextAppleId}`;
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
      name: "Wrong Turn Test",
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

describe("wrong turn", () => {
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
    it("steps walked during window are reversed (subtracted 2x)", async () => {
      const alice = await createUser("AliceTurnAAA");
      const bob = await createUser("BobTurnAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Apply wrong turn, then backdate its window so we can place samples inside it
      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      await usePowerup(alice.token, raceId, wt.id, bob.userId);

      // Backdate wrong turn to 3h ago → expires 2h ago (1h duration)
      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "WRONG_TURN" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { startsAt: hoursAgo(3), expiresAt: hoursAgo(2), status: "EXPIRED" },
      });

      // Bob walks 5000 steps BEFORE wrong turn window (5h-4h ago)
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(5).toISOString(), periodEnd: hoursAgo(4).toISOString(), steps: 5000 },
      ]);

      // Bob walks 1000 steps DURING wrong turn window (2.5h-2.25h ago)
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(2.5).toISOString(), periodEnd: hoursAgo(2.25).toISOString(), steps: 1000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      // base = 6000, reversedSteps = 1000, total = 6000 - 2*1000 = 4000
      assert.equal(bobP.totalSteps, 4000);
    });

    it("steps walked before wrong turn are unaffected", async () => {
      const alice = await createUser("AliceTurnBBB");
      const bob = await createUser("BobTurnBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);
      await backdateRaceStart(raceId, hoursAgo(6));

      // Bob walks 5000 steps before wrong turn
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(5).toISOString(), periodEnd: hoursAgo(4).toISOString(), steps: 5000 },
      ]);

      // Alice applies wrong turn — bob doesn't walk during it
      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      await usePowerup(alice.token, raceId, wt.id, bob.userId);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 5000);
    });

    it("steps walked after expiry are unaffected", async () => {
      const alice = await createUser("AliceTurnCCC");
      const bob = await createUser("BobTurnCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);
      await backdateRaceStart(raceId, hoursAgo(6));

      // Create an already-expired Wrong Turn (ended 30 min ago)
      const powerup = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      await prisma.racePowerup.update({ where: { id: powerup.id }, data: { status: "USED" } });
      const bobP = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
      await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: bobP.id,
          targetUserId: bob.userId,
          sourceUserId: alice.userId,
          powerupId: powerup.id,
          type: "WRONG_TURN",
          status: "EXPIRED",
          startsAt: hoursAgo(2),
          expiresAt: hoursAgo(1),
          metadata: { stepsAtStart: 0 },
        },
      });

      // Bob walks after expiry — should count normally
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(30).toISOString(), periodEnd: new Date().toISOString(), steps: 3000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobEntry = findUser(progress, bob.userId);
      assert.equal(bobEntry.totalSteps, 3000);
    });

    it("total cannot go below 0", async () => {
      const alice = await createUser("AliceTurnDDD");
      const bob = await createUser("BobTurnDDDDD");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Apply wrong turn, then backdate so samples fall inside it
      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      await usePowerup(alice.token, raceId, wt.id, bob.userId);

      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "WRONG_TURN" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { startsAt: hoursAgo(2), expiresAt: hoursAgo(1) },
      });

      // Bob walks DURING wrong turn window (all steps reversed)
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(1.5).toISOString(), periodEnd: hoursAgo(1.25).toISOString(), steps: 5000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      // base = 5000, reversed = 5000, total = max(0, 5000 - 2*5000) = 0
      assert.equal(bobP.totalSteps, 0);
    });
  });

  // === VALIDATION ===

  describe("validation", () => {
    it("requires a target", async () => {
      const alice = await createUser("AliceValAAAA");
      const bob = await createUser("BobValAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      const res = await usePowerup(alice.token, raceId, wt.id);
      assert.equal(res.status, 400);
    });

    it("cannot target yourself", async () => {
      const alice = await createUser("AliceValBBBB");
      const bob = await createUser("BobValBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      const res = await usePowerup(alice.token, raceId, wt.id, alice.userId);
      assert.equal(res.status, 400);
    });

    it("cannot stack — rejects if target already has active wrong turn", async () => {
      const alice = await createUser("AliceValCCCC");
      const bob = await createUser("BobValCCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const wt1 = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      const wt2 = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99902);

      await usePowerup(alice.token, raceId, wt1.id, bob.userId);
      const res = await usePowerup(alice.token, raceId, wt2.id, bob.userId);
      assert.equal(res.status, 400);
    });

    it("cannot target finished participant", async () => {
      const alice = await createUser("AliceValDDDD");
      const bob = await createUser("BobValDDDDDD");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Give alice the powerup before bob finishes
      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);

      // Bob finishes
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(30).toISOString(), periodEnd: new Date().toISOString(), steps: 250000 },
      ]);
      await getProgress(bob.token, raceId);

      const res = await usePowerup(alice.token, raceId, wt.id, bob.userId);
      assert.ok(res.status >= 400);
    });
  });

  // === PRORATING ===

  describe("prorating at window boundaries", () => {
    it("sample overlapping wrong turn start — only portion during effect is reversed", async () => {
      const alice = await createUser("AliceProrAAA");
      const bob = await createUser("BobProrAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);
      await backdateRaceStart(raceId, hoursAgo(6));

      // Create wrong turn starting 1 hour ago, lasting 1 hour (ends now-ish)
      const wtStart = hoursAgo(1);
      const wtEnd = new Date(wtStart.getTime() + 1 * 60 * 60 * 1000);
      const bobParticipant = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
      const powerup = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      await prisma.racePowerup.update({ where: { id: powerup.id }, data: { status: "USED" } });
      await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: bobParticipant.id,
          targetUserId: bob.userId,
          sourceUserId: alice.userId,
          powerupId: powerup.id,
          type: "WRONG_TURN",
          status: "ACTIVE",
          startsAt: wtStart,
          expiresAt: wtEnd,
          metadata: { stepsAtStart: 0 },
        },
      });

      // Sample: 90min ago to 30min ago (60 min)
      // Wrong turn started 60min ago, so overlap = 60min-30min = 30min out of 60min
      // 1000 steps → 500 should be reversed
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(90).toISOString(), periodEnd: minutesAgo(30).toISOString(), steps: 1000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);

      // base = 1000, reversedSteps = 500 (prorated)
      // total = max(0, 1000 - 2*500) = 0
      assert.equal(bobP.totalSteps, 0, "should prorate: only 500 of 1000 steps reversed");
    });

    it("sample overlapping wrong turn end — only portion during effect is reversed", async () => {
      const alice = await createUser("AliceProrBBB");
      const bob = await createUser("BobProrBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);
      await backdateRaceStart(raceId, hoursAgo(6));

      // Create expired wrong turn that ended 30min ago
      const wtStart = hoursAgo(1.5);
      const wtEnd = minutesAgo(30);
      const bobParticipant = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
      const powerup = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      await prisma.racePowerup.update({ where: { id: powerup.id }, data: { status: "USED" } });
      await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: bobParticipant.id,
          targetUserId: bob.userId,
          sourceUserId: alice.userId,
          powerupId: powerup.id,
          type: "WRONG_TURN",
          status: "EXPIRED",
          startsAt: wtStart,
          expiresAt: wtEnd,
          metadata: { stepsAtStart: 0 },
        },
      });

      // Sample: 60min ago to now (60 min)
      // Wrong turn ended 30min ago, so overlap = 60min-30min = 30min out of 60min
      // 1000 steps → 500 should be reversed
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(60).toISOString(), periodEnd: new Date().toISOString(), steps: 1000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);

      // base = 1000, reversedSteps = 500 (prorated)
      // total = max(0, 1000 - 2*500) = 0
      assert.equal(bobP.totalSteps, 0, "should prorate: only 500 of 1000 steps reversed");
    });
  });

  // === EFFECT INTERACTIONS ===

  describe("effect interactions", () => {
    it("cancels active leg cramp on target when applied", async () => {
      const alice = await createUser("AliceInterAA");
      const bob = await createUser("BobInterAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Alice freezes bob
      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      await usePowerup(alice.token, raceId, cramp.id, bob.userId);

      // Verify leg cramp is active
      const crampEffect = await prisma.raceActiveEffect.findFirst({
        where: { raceId, type: "LEG_CRAMP", status: "ACTIVE" },
      });
      assert.ok(crampEffect);

      // Alice applies wrong turn (should cancel the cramp)
      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99902);
      await usePowerup(alice.token, raceId, wt.id, bob.userId);

      // Leg cramp should now be expired
      const updatedCramp = await prisma.raceActiveEffect.findFirst({
        where: { id: crampEffect.id },
      });
      assert.equal(updatedCramp.status, "EXPIRED");

      // New leg cramp should be possible (old one cancelled)
      const cramp2 = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99903);
      const res = await usePowerup(alice.token, raceId, cramp2.id, bob.userId);
      assert.equal(res.status, 200);
    });

    it("wrong turn during runners high — overlapping steps reversed not buffed", async () => {
      const alice = await createUser("AliceInterBB");
      const bob = await createUser("BobInterBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Bob activates Runner's High
      const rh = await giveHeldPowerup(raceId, bob.userId, "RUNNERS_HIGH", 99901);
      await usePowerup(bob.token, raceId, rh.id);

      // Alice applies Wrong Turn to bob (both effects active)
      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99902);
      await usePowerup(alice.token, raceId, wt.id, bob.userId);

      // Backdate both effects so samples fall inside them
      const effects = await prisma.raceActiveEffect.findMany({ where: { raceId, targetUserId: bob.userId } });
      for (const e of effects) {
        await prisma.raceActiveEffect.update({
          where: { id: e.id },
          data: { startsAt: hoursAgo(2), expiresAt: hoursAgo(0.5) },
        });
      }

      // Bob walks during both effects (1.5h-1h ago)
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(1.5).toISOString(), periodEnd: hoursAgo(1).toISOString(), steps: 1000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      // Wrong Turn + Runner's High overlap: steps are reversed, not buffed
      // total should be 0 (all steps penalized)
      assert.equal(bobP.totalSteps, 0);
    });

    it("blocked by compression socks", async () => {
      const alice = await createUser("AliceInterCC");
      const bob = await createUser("BobInterCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Bob activates shield
      const shield = await giveHeldPowerup(raceId, bob.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(bob.token, raceId, shield.id);

      // Alice uses wrong turn
      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99902);
      const res = await usePowerup(alice.token, raceId, wt.id, bob.userId);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.blocked, true);

      // Bob walks — steps should count normally (no wrong turn effect)
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(10).toISOString(), periodEnd: new Date().toISOString(), steps: 3000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 3000);
    });
  });

  // === EDGE CASES ===

  describe("edge cases", () => {
    it("bonus steps not affected by wrong turn reversal", async () => {
      const alice = await createUser("AliceEdgeAAA");
      const bob = await createUser("BobEdgeAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Alice applies wrong turn to bob
      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      await usePowerup(alice.token, raceId, wt.id, bob.userId);

      // Bob uses protein shake during wrong turn — bonus should still count
      const shake = await giveHeldPowerup(raceId, bob.userId, "PROTEIN_SHAKE", 99902);
      await usePowerup(bob.token, raceId, shake.id);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 1500);
    });
  });

  // === FEED ===

  describe("feed", () => {
    it("shows usage and expiry events", async () => {
      const alice = await createUser("AliceFeedAAA");
      const bob = await createUser("BobFeedAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      await usePowerup(alice.token, raceId, wt.id, bob.userId);

      // Force expiry
      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "WRONG_TURN" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { expiresAt: minutesAgo(1) },
      });
      await getProgress(alice.token, raceId);

      const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
      const feedBody = await feedRes.json();

      const useEvent = feedBody.events.find(
        (e) => e.eventType === "POWERUP_USED" && e.powerupType === "WRONG_TURN"
      );
      const expiryEvent = feedBody.events.find(
        (e) => e.eventType === "EFFECT_EXPIRED" && e.powerupType === "WRONG_TURN"
      );
      assert.ok(useEvent, "feed should have usage event");
      assert.ok(expiryEvent, "feed should have expiry event");
      assert.ok(useEvent.description.includes("Wrong Turn"));
    });
  });
});
