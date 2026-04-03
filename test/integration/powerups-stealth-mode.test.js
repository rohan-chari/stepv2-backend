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
  const appleId = `apple-sm-${++nextAppleId}`;
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
      name: "Stealth Test",
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
  // Backdate so step samples recorded with minutesAgo() fall within race window
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: twoHoursAgo } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: twoHoursAgo } });
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

describe("stealth mode", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // === CORE MECHANIC — VISIBILITY ===

  describe("visibility", () => {
    it("stealthed user appears as ??? with null steps to opponents", async () => {
      const alice = await createUser("AliceStlthAA");
      const bob = await createUser("BobStealthAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Alice goes stealth
      const stealth = await giveHeldPowerup(raceId, alice.userId, "STEALTH_MODE", 99901);
      await usePowerup(alice.token, raceId, stealth.id);

      // Give alice some steps so there's something to hide
      await recordSamples(alice.token, [
        { periodStart: minutesAgo(10).toISOString(), periodEnd: new Date().toISOString(), steps: 5000 },
      ]);

      // Bob views progress — should see alice as ???
      const progress = await getProgress(bob.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      assert.equal(aliceP.displayName, "???");
      assert.equal(aliceP.totalSteps, null);
      assert.equal(aliceP.progress, null);
      assert.equal(aliceP.stealthed, true);
    });

    it("stealthed user can see their own real progress", async () => {
      const alice = await createUser("AliceStlthBB");
      const bob = await createUser("BobStealthBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const stealth = await giveHeldPowerup(raceId, alice.userId, "STEALTH_MODE", 99901);
      await usePowerup(alice.token, raceId, stealth.id);

      await recordSamples(alice.token, [
        { periodStart: minutesAgo(10).toISOString(), periodEnd: new Date().toISOString(), steps: 5000 },
      ]);

      // Alice views her own progress — should see real data
      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      assert.equal(aliceP.displayName, "AliceStlthBB");
      assert.equal(aliceP.totalSteps, 5000);
      assert.equal(aliceP.stealthed, false);
    });

    it("stealthed users sort to the top of the leaderboard", async () => {
      const alice = await createUser("AliceStlthCC");
      const bob = await createUser("BobStealthCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Bob has way more steps
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(30).toISOString(), periodEnd: new Date().toISOString(), steps: 20000 },
      ]);

      // Alice goes stealth with fewer steps
      await recordSamples(alice.token, [
        { periodStart: minutesAgo(10).toISOString(), periodEnd: new Date().toISOString(), steps: 1000 },
      ]);
      const stealth = await giveHeldPowerup(raceId, alice.userId, "STEALTH_MODE", 99901);
      await usePowerup(alice.token, raceId, stealth.id);

      // Bob views — stealthed alice should be at top despite fewer steps
      const progress = await getProgress(bob.token, raceId);
      assert.equal(progress.participants[0].stealthed, true);
      assert.equal(progress.participants[0].userId, alice.userId);
    });

    it("multiple opponents all see ??? for stealthed user", async () => {
      const alice = await createUser("AliceStlthDD");
      const bob = await createUser("BobStealthDD");
      const charlie = await createUser("CharlieStlDD");
      await makeFriends(alice, bob);
      await makeFriends(alice, charlie);

      const createRes = await request(server.baseUrl, "POST", "/races", {
        body: { name: "3 Player Stealth", targetSteps: 200000, maxDurationDays: 7, powerupsEnabled: true, powerupStepInterval: 5000 },
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

      const stealth = await giveHeldPowerup(raceId, alice.userId, "STEALTH_MODE", 99901);
      await usePowerup(alice.token, raceId, stealth.id);

      // Both bob and charlie should see ???
      const bobProgress = await getProgress(bob.token, raceId);
      const charlieProgress = await getProgress(charlie.token, raceId);

      const aliceFromBob = findUser(bobProgress, alice.userId);
      const aliceFromCharlie = findUser(charlieProgress, alice.userId);
      assert.equal(aliceFromBob.displayName, "???");
      assert.equal(aliceFromCharlie.displayName, "???");
    });
  });

  // === UNMASKING CONDITIONS ===

  describe("unmasking", () => {
    it("after expiry, user becomes visible again", async () => {
      const alice = await createUser("AliceUnmskAA");
      const bob = await createUser("BobUnmaskAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Create an already-expired stealth
      const powerup = await giveHeldPowerup(raceId, alice.userId, "STEALTH_MODE", 99901);
      await prisma.racePowerup.update({ where: { id: powerup.id }, data: { status: "USED" } });
      const aliceP = await prisma.raceParticipant.findFirst({ where: { raceId, userId: alice.userId } });
      await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: aliceP.id,
          targetUserId: alice.userId,
          sourceUserId: alice.userId,
          powerupId: powerup.id,
          type: "STEALTH_MODE",
          status: "EXPIRED",
          startsAt: hoursAgo(5),
          expiresAt: hoursAgo(1),
        },
      });

      await recordSamples(alice.token, [
        { periodStart: minutesAgo(30).toISOString(), periodEnd: new Date().toISOString(), steps: 3000 },
      ]);

      // Bob should see alice's real data
      const progress = await getProgress(bob.token, raceId);
      const aliceEntry = findUser(progress, alice.userId);
      assert.equal(aliceEntry.displayName, "AliceUnmskAA");
      assert.ok(aliceEntry.totalSteps > 0);
      assert.equal(aliceEntry.stealthed, false);
    });

    it("finished user becomes visible even if stealth is still active", async () => {
      const alice = await createUser("AliceUnmskBB");
      const bob = await createUser("BobUnmaskBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob, { targetSteps: 3000 });

      // Alice goes stealth
      const stealth = await giveHeldPowerup(raceId, alice.userId, "STEALTH_MODE", 99901);
      await usePowerup(alice.token, raceId, stealth.id);

      // Alice finishes the race while stealthed
      await recordSamples(alice.token, [
        { periodStart: minutesAgo(10).toISOString(), periodEnd: new Date().toISOString(), steps: 5000 },
      ]);
      await getProgress(alice.token, raceId); // trigger finish detection

      // Bob should now see alice (finished overrides stealth)
      const progress = await getProgress(bob.token, raceId);
      const aliceEntry = findUser(progress, alice.userId);
      assert.equal(aliceEntry.displayName, "AliceUnmskBB");
      assert.equal(aliceEntry.stealthed, false);
      assert.ok(aliceEntry.finishedAt);
    });
  });

  // === VALIDATION ===

  describe("validation", () => {
    it("self-only — rejects if targetUserId provided", async () => {
      const alice = await createUser("AliceValAAAA");
      const bob = await createUser("BobValAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const stealth = await giveHeldPowerup(raceId, alice.userId, "STEALTH_MODE", 99901);
      const res = await usePowerup(alice.token, raceId, stealth.id, bob.userId);
      assert.equal(res.status, 400);
    });

    it("cannot stack — rejects second while one active", async () => {
      const alice = await createUser("AliceValBBBB");
      const bob = await createUser("BobValBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const s1 = await giveHeldPowerup(raceId, alice.userId, "STEALTH_MODE", 99901);
      const s2 = await giveHeldPowerup(raceId, alice.userId, "STEALTH_MODE", 99902);

      await usePowerup(alice.token, raceId, s1.id);
      const res = await usePowerup(alice.token, raceId, s2.id);
      assert.equal(res.status, 400);
    });

    it("can re-activate after first expires", async () => {
      const alice = await createUser("AliceValCCCC");
      const bob = await createUser("BobValCCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const s1 = await giveHeldPowerup(raceId, alice.userId, "STEALTH_MODE", 99901);
      await usePowerup(alice.token, raceId, s1.id);

      // Force expiry
      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "STEALTH_MODE" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { expiresAt: minutesAgo(1), status: "EXPIRED" },
      });

      const s2 = await giveHeldPowerup(raceId, alice.userId, "STEALTH_MODE", 99902);
      const res = await usePowerup(alice.token, raceId, s2.id);
      assert.equal(res.status, 200);
    });
  });

  // === STEPS STILL COUNT WHILE STEALTHED ===

  describe("steps during stealth", () => {
    it("steps walked while stealthed still count toward race total", async () => {
      const alice = await createUser("AliceStepAAA");
      const bob = await createUser("BobStepAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const stealth = await giveHeldPowerup(raceId, alice.userId, "STEALTH_MODE", 99901);
      await usePowerup(alice.token, raceId, stealth.id);

      await recordSamples(alice.token, [
        { periodStart: minutesAgo(30).toISOString(), periodEnd: new Date().toISOString(), steps: 7000 },
      ]);

      // Alice sees her own real total
      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      assert.equal(aliceP.totalSteps, 7000);
    });

    it("opponents can still use powerups on a stealthed user", async () => {
      const alice = await createUser("AliceStepBBB");
      const bob = await createUser("BobStepBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Alice goes stealth and walks
      const stealth = await giveHeldPowerup(raceId, alice.userId, "STEALTH_MODE", 99901);
      await usePowerup(alice.token, raceId, stealth.id);

      await recordSamples(alice.token, [
        { periodStart: minutesAgo(30).toISOString(), periodEnd: new Date().toISOString(), steps: 5000 },
      ]);
      await getProgress(alice.token, raceId); // update totalSteps

      // Bob uses Leg Cramp on alice — stealth doesn't protect from attacks
      const cramp = await giveHeldPowerup(raceId, bob.userId, "LEG_CRAMP", 99902);
      const res = await usePowerup(bob.token, raceId, cramp.id, alice.userId);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.ok(!body.result.blocked, "stealth should not block attacks");
    });
  });

  // === FEED ===

  describe("feed", () => {
    it("feed shows activation and expiry events to all participants", async () => {
      const alice = await createUser("AliceFeedAAA");
      const bob = await createUser("BobFeedAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const stealth = await giveHeldPowerup(raceId, alice.userId, "STEALTH_MODE", 99901);
      await usePowerup(alice.token, raceId, stealth.id);

      // Force expiry
      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "STEALTH_MODE" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { expiresAt: minutesAgo(1) },
      });
      await getProgress(alice.token, raceId); // trigger expiry

      // Bob can see both events in feed
      const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: bob.token });
      const feedBody = await feedRes.json();

      const useEvent = feedBody.events.find(
        (e) => e.eventType === "POWERUP_USED" && e.powerupType === "STEALTH_MODE"
      );
      const expiryEvent = feedBody.events.find(
        (e) => e.eventType === "EFFECT_EXPIRED" && e.powerupType === "STEALTH_MODE"
      );
      assert.ok(useEvent, "feed should show stealth activation");
      assert.ok(expiryEvent, "feed should show stealth expiry");
    });
  });
});
