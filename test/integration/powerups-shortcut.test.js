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
  const appleId = `apple-sc-${++nextAppleId}`;
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
      name: "Shortcut Test",
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
      rarity: type === "COMPRESSION_SOCKS" ? "RARE" : "COMMON",
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

describe("shortcut (banana peel)", () => {
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
    it("steals 1000 steps from target, adds to attacker", async () => {
      const alice = await createUser("AliceStealAA");
      const bob = await createUser("BobVictimAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Give bob 5000 steps so there's something to steal
      await giveBonusSteps(raceId, bob.userId, 5000);

      const shortcut = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99901);
      const res = await usePowerup(alice.token, raceId, shortcut.id, bob.userId);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.stolen, 1000);

      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(aliceP.totalSteps, 1000);
      assert.equal(bobP.totalSteps, 4000);
    });

    it("capped at target's total — steals only what they have", async () => {
      const alice = await createUser("AliceStealBB");
      const bob = await createUser("BobVictimBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Bob only has 400 steps
      await giveBonusSteps(raceId, bob.userId, 400);

      const shortcut = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99901);
      const res = await usePowerup(alice.token, raceId, shortcut.id, bob.userId);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.stolen, 400);

      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(aliceP.totalSteps, 400);
      assert.equal(bobP.totalSteps, 0);
    });

    it("can steal from someone who only has bonus steps", async () => {
      const alice = await createUser("AliceStealCC");
      const bob = await createUser("BobVictimCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Give bob bonus steps via protein shake (no walked steps)
      const shake = await giveHeldPowerup(raceId, bob.userId, "PROTEIN_SHAKE", 99901);
      await usePowerup(bob.token, raceId, shake.id);

      // Sync totalSteps so shortcut validation sees bob's bonus
      await getProgress(bob.token, raceId);

      // Bob now has 1500 bonus steps, 0 walked
      const shortcut = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99902);
      const res = await usePowerup(alice.token, raceId, shortcut.id, bob.userId);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.stolen, 1000);
    });

    it("multiple shortcuts against same target accumulate the loss", async () => {
      const alice = await createUser("AliceStealDD");
      const bob = await createUser("BobVictimDDD");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      await giveBonusSteps(raceId, bob.userId, 5000);

      const s1 = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99901);
      const s2 = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99902);

      await usePowerup(alice.token, raceId, s1.id, bob.userId);
      await usePowerup(alice.token, raceId, s2.id, bob.userId);

      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(aliceP.totalSteps, 2000);
      assert.equal(bobP.totalSteps, 3000);
    });

    it("stealing doesn't take target below 0 total steps", async () => {
      const alice = await createUser("AliceStealEE");
      const bob = await createUser("BobVictimEEE");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Bob has only 50 steps
      await giveBonusSteps(raceId, bob.userId, 50);

      const shortcut = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99901);
      await usePowerup(alice.token, raceId, shortcut.id, bob.userId);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.ok(bobP.totalSteps >= 0, `target should not go below 0, got ${bobP.totalSteps}`);
    });
  });

  // === VALIDATION ===

  describe("validation", () => {
    it("requires a target", async () => {
      const alice = await createUser("AliceValAAAA");
      const bob = await createUser("BobValAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const shortcut = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99901);
      const res = await usePowerup(alice.token, raceId, shortcut.id);
      assert.equal(res.status, 400);
    });

    it("cannot target yourself", async () => {
      const alice = await createUser("AliceValBBBB");
      const bob = await createUser("BobValBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const shortcut = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99901);
      const res = await usePowerup(alice.token, raceId, shortcut.id, alice.userId);
      assert.equal(res.status, 400);
    });

    it("cannot steal from target with 0 steps", async () => {
      const alice = await createUser("AliceValCCCC");
      const bob = await createUser("BobValCCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Bob has 0 steps
      const shortcut = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99901);
      const res = await usePowerup(alice.token, raceId, shortcut.id, bob.userId);
      assert.equal(res.status, 400);
    });

    it("cannot target a finished participant", async () => {
      const alice = await createUser("AliceValDDDD");
      const bob = await createUser("BobValDDDDDD");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Give alice the shortcut BEFORE bob finishes (in case race auto-completes)
      const shortcut = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99901);

      // Bob finishes by recording enough step samples
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      await request(server.baseUrl, "POST", "/steps/samples", {
        body: { samples: [{ periodStart: oneHourAgo.toISOString(), periodEnd: now.toISOString(), steps: 250000 }] },
        token: bob.token,
      });
      // Fetch progress to trigger finish detection
      await getProgress(bob.token, raceId);

      const res = await usePowerup(alice.token, raceId, shortcut.id, bob.userId);
      assert.ok(res.status >= 400, `targeting finished participant should fail, got ${res.status}`);
    });
  });

  // === SHIELD INTERACTION ===

  describe("shield interaction", () => {
    it("blocked by compression socks — no steps transferred", async () => {
      const alice = await createUser("AliceShldAAA");
      const bob = await createUser("BobShieldAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      await giveBonusSteps(raceId, bob.userId, 5000);

      // Bob activates shield
      const shield = await giveHeldPowerup(raceId, bob.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(bob.token, raceId, shield.id);

      // Alice attacks
      const shortcut = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99902);
      const res = await usePowerup(alice.token, raceId, shortcut.id, bob.userId);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.blocked, true);

      // Bob should still have 5000 steps, alice should have 0
      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(aliceP.totalSteps, 0);
      assert.equal(bobP.totalSteps, 5000);
    });

    it("blocked attack still consumes the shortcut powerup", async () => {
      const alice = await createUser("AliceShldBBB");
      const bob = await createUser("BobShieldBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      await giveBonusSteps(raceId, bob.userId, 5000);

      const shield = await giveHeldPowerup(raceId, bob.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(bob.token, raceId, shield.id);

      const shortcut = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99902);
      await usePowerup(alice.token, raceId, shortcut.id, bob.userId);

      // Shortcut should be consumed — can't use again
      const res = await usePowerup(alice.token, raceId, shortcut.id, bob.userId);
      assert.ok(res.status >= 400);
    });

    it("shield is consumed after blocking", async () => {
      const alice = await createUser("AliceShldCCC");
      const bob = await createUser("BobShieldCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      await giveBonusSteps(raceId, bob.userId, 5000);

      const shield = await giveHeldPowerup(raceId, bob.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(bob.token, raceId, shield.id);

      // First attack — blocked
      const s1 = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99902);
      const res1 = await usePowerup(alice.token, raceId, s1.id, bob.userId);
      assert.equal((await res1.json()).result.blocked, true);

      // Second attack — should go through (shield consumed)
      const s2 = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99903);
      const res2 = await usePowerup(alice.token, raceId, s2.id, bob.userId);
      assert.equal(res2.status, 200);

      const body2 = await res2.json();
      assert.ok(!body2.result.blocked, "second attack should not be blocked");
      assert.equal(body2.result.stolen, 1000);
    });
  });

  // === FEED ===

  describe("feed", () => {
    it("shows correct stolen amount in event", async () => {
      const alice = await createUser("AliceFeedAAA");
      const bob = await createUser("BobFeedAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      await giveBonusSteps(raceId, bob.userId, 3000);

      const shortcut = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99901);
      await usePowerup(alice.token, raceId, shortcut.id, bob.userId);

      const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
      assert.equal(feedRes.status, 200);

      const feedBody = await feedRes.json();
      const event = feedBody.events.find(
        (e) => e.eventType === "POWERUP_USED" && e.powerupType === "SHORTCUT"
      );
      assert.ok(event, "feed should contain shortcut usage event");
      assert.ok(event.description.includes("1,000") || event.description.includes("1000"));
    });
  });
});
