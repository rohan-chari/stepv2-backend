const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-ds-${++nextAppleId}`;
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
  const players = [bob];
  if (opts.charlie) players.push(opts.charlie);

  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Detour Sign Test",
      targetSteps: 200000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;
  for (const p of players) {
    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      body: { inviteeIds: [p.userId] },
      token: alice.token,
    });
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: p.token,
    });
  }
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
      rarity: type === "COMPRESSION_SOCKS" ? "RARE" : "COMMON",
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

function minutesAgo(m) {
  return new Date(Date.now() - m * 60 * 1000);
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

describe("detour sign", () => {
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
    it("target sees all participants as ??? with null steps during effect", async () => {
      const alice = await createUser("AliceDetourA");
      const bob = await createUser("BobDetourAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Both have some steps
      await recordSamples(alice.token, [
        { periodStart: minutesAgo(60).toISOString(), periodEnd: minutesAgo(30).toISOString(), steps: 5000 },
      ]);
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(60).toISOString(), periodEnd: minutesAgo(30).toISOString(), steps: 3000 },
      ]);

      // Alice applies detour sign on bob
      const detour = await giveHeldPowerup(raceId, alice.userId, "DETOUR_SIGN", 99901);
      const useRes = await usePowerup(alice.token, raceId, detour.id, bob.userId);
      assert.equal(useRes.status, 200);

      // Bob views progress — should see ??? for everyone
      const progress = await getProgress(bob.token, raceId);
      for (const p of progress.participants) {
        assert.equal(p.displayName, "???");
        assert.equal(p.totalSteps, null);
        assert.equal(p.progress, null);
      }
    });

    it("other users see normal leaderboard (not affected)", async () => {
      const alice = await createUser("AliceDetourB");
      const bob = await createUser("BobDetourBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      await recordSamples(alice.token, [
        { periodStart: minutesAgo(60).toISOString(), periodEnd: minutesAgo(30).toISOString(), steps: 5000 },
      ]);

      // Alice applies detour on bob — alice should still see normal data
      const detour = await giveHeldPowerup(raceId, alice.userId, "DETOUR_SIGN", 99901);
      await usePowerup(alice.token, raceId, detour.id, bob.userId);

      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      assert.equal(aliceP.displayName, "AliceDetourB");
      assert.equal(aliceP.totalSteps, 5000);
    });

    it("after expiry, target sees normal data again", async () => {
      const alice = await createUser("AliceDetourC");
      const bob = await createUser("BobDetourCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      await recordSamples(alice.token, [
        { periodStart: minutesAgo(60).toISOString(), periodEnd: minutesAgo(30).toISOString(), steps: 5000 },
      ]);

      // Create an already-expired detour
      const powerup = await giveHeldPowerup(raceId, alice.userId, "DETOUR_SIGN", 99901);
      await prisma.racePowerup.update({ where: { id: powerup.id }, data: { status: "USED" } });
      const bobP = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
      await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: bobP.id,
          targetUserId: bob.userId,
          sourceUserId: alice.userId,
          powerupId: powerup.id,
          type: "DETOUR_SIGN",
          status: "EXPIRED",
          startsAt: hoursAgo(4),
          expiresAt: hoursAgo(1),
        },
      });

      // Bob should see normal data now
      const progress = await getProgress(bob.token, raceId);
      const aliceEntry = findUser(progress, alice.userId);
      assert.equal(aliceEntry.displayName, "AliceDetourC");
      assert.ok(aliceEntry.totalSteps >= 0);
    });

    it("target can still use powerups while under detour", async () => {
      const alice = await createUser("AliceDetourD");
      const bob = await createUser("BobDetourDDD");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Alice applies detour on bob
      const detour = await giveHeldPowerup(raceId, alice.userId, "DETOUR_SIGN", 99901);
      await usePowerup(alice.token, raceId, detour.id, bob.userId);

      // Bob can still use a protein shake while blinded
      const shake = await giveHeldPowerup(raceId, bob.userId, "PROTEIN_SHAKE", 99902);
      const res = await usePowerup(bob.token, raceId, shake.id);
      assert.equal(res.status, 200);
    });
  });

  // === VALIDATION ===

  describe("validation", () => {
    it("requires a target", async () => {
      const alice = await createUser("AliceValAAAA");
      const bob = await createUser("BobValAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const detour = await giveHeldPowerup(raceId, alice.userId, "DETOUR_SIGN", 99901);
      const res = await usePowerup(alice.token, raceId, detour.id);
      assert.equal(res.status, 400);
    });

    it("cannot target yourself", async () => {
      const alice = await createUser("AliceValBBBB");
      const bob = await createUser("BobValBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const detour = await giveHeldPowerup(raceId, alice.userId, "DETOUR_SIGN", 99901);
      const res = await usePowerup(alice.token, raceId, detour.id, alice.userId);
      assert.equal(res.status, 400);
    });

    it("cannot stack — rejects if target already has active detour", async () => {
      const alice = await createUser("AliceValCCCC");
      const bob = await createUser("BobValCCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const d1 = await giveHeldPowerup(raceId, alice.userId, "DETOUR_SIGN", 99901);
      const d2 = await giveHeldPowerup(raceId, alice.userId, "DETOUR_SIGN", 99902);

      await usePowerup(alice.token, raceId, d1.id, bob.userId);
      const res = await usePowerup(alice.token, raceId, d2.id, bob.userId);
      assert.equal(res.status, 400);
    });

    it("blocked by compression socks", async () => {
      const alice = await createUser("AliceValDDDD");
      const bob = await createUser("BobValDDDDDD");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Bob activates shield
      const shield = await giveHeldPowerup(raceId, bob.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(bob.token, raceId, shield.id);

      const detour = await giveHeldPowerup(raceId, alice.userId, "DETOUR_SIGN", 99902);
      const res = await usePowerup(alice.token, raceId, detour.id, bob.userId);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.blocked, true);

      // Bob should see normal data (detour was blocked)
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(30).toISOString(), periodEnd: new Date().toISOString(), steps: 3000 },
      ]);
      const progress = await getProgress(bob.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.ok(bobP.totalSteps >= 0);
      assert.notEqual(bobP.displayName, "???");
    });
  });

  // === FEED ===

  describe("feed", () => {
    it("shows usage and expiry events", async () => {
      const alice = await createUser("AliceFeedAAA");
      const bob = await createUser("BobFeedAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const detour = await giveHeldPowerup(raceId, alice.userId, "DETOUR_SIGN", 99901);
      await usePowerup(alice.token, raceId, detour.id, bob.userId);

      // Force expiry
      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "DETOUR_SIGN" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { expiresAt: minutesAgo(1) },
      });
      await getProgress(alice.token, raceId); // trigger expiry

      const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
      const feedBody = await feedRes.json();

      const useEvent = feedBody.events.find(
        (e) => e.eventType === "POWERUP_USED" && e.powerupType === "DETOUR_SIGN"
      );
      const expiryEvent = feedBody.events.find(
        (e) => e.eventType === "EFFECT_EXPIRED" && e.powerupType === "DETOUR_SIGN"
      );
      assert.ok(useEvent, "feed should have usage event");
      assert.ok(expiryEvent, "feed should have expiry event");
      assert.ok(useEvent.description.includes("Detour"));
    });
  });

  // === CROSS-RACE ISOLATION ===

  describe("cross-race isolation", () => {
    it("detour in Race A does not affect Race B", async () => {
      const alice = await createUser("AliceCrossAA");
      const bob = await createUser("BobCrossAAAA");
      const charlie = await createUser("CharlieCrsAA");
      await makeFriends(alice, bob);
      await makeFriends(alice, charlie);

      // Race A: alice detours bob
      const raceA = await createActiveRace(alice, bob);
      const detour = await giveHeldPowerup(raceA, alice.userId, "DETOUR_SIGN", 99901);
      await usePowerup(alice.token, raceA, detour.id, bob.userId);

      // Race B: bob should see normal data
      await makeFriends(bob, charlie);
      const raceB = await createActiveRace(bob, charlie);
      await recordSamples(charlie.token, [
        { periodStart: minutesAgo(30).toISOString(), periodEnd: new Date().toISOString(), steps: 4000 },
      ]);

      const progress = await getProgress(bob.token, raceB);
      const charlieP = findUser(progress, charlie.userId);
      assert.notEqual(charlieP.displayName, "???");
    });
  });
});
