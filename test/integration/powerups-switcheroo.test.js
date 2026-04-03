const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

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

async function createActiveRace(alice, bob) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Switcheroo Test",
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
      rarity: type === "COMPRESSION_SOCKS" ? "RARE" : "RARE",
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

describe("switcheroo", () => {
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
    it("after swap, user has target's old total, target has user's old total", async () => {
      const alice = await createUser("AliceSwapAAA");
      const bob = await createUser("BobSwapAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      await giveBonusSteps(raceId, alice.userId, 5000);
      await giveBonusSteps(raceId, bob.userId, 15000);

      // Sync totalSteps
      await getProgress(alice.token, raceId);

      const swap = await giveHeldPowerup(raceId, alice.userId, "SWITCHEROO", 99901);
      const res = await usePowerup(alice.token, raceId, swap.id, bob.userId);
      assert.equal(res.status, 200);

      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(aliceP.totalSteps, 15000);
      assert.equal(bobP.totalSteps, 5000);
    });

    it("swap persists in progress across fetches", async () => {
      const alice = await createUser("AliceSwapBBB");
      const bob = await createUser("BobSwapBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      await giveBonusSteps(raceId, alice.userId, 3000);
      await giveBonusSteps(raceId, bob.userId, 20000);
      await getProgress(alice.token, raceId);

      const swap = await giveHeldPowerup(raceId, alice.userId, "SWITCHEROO", 99901);
      await usePowerup(alice.token, raceId, swap.id, bob.userId);

      const p1 = await getProgress(alice.token, raceId);
      const p2 = await getProgress(alice.token, raceId);

      assert.equal(findUser(p1, alice.userId).totalSteps, 20000);
      assert.equal(findUser(p2, alice.userId).totalSteps, 20000);
    });

    it("swap interacts correctly with existing bonusSteps", async () => {
      const alice = await createUser("AliceSwapCCC");
      const bob = await createUser("BobSwapCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Give alice some bonus via protein shake first
      const shake = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
      await usePowerup(alice.token, raceId, shake.id);
      // Alice: 1500 bonus

      await giveBonusSteps(raceId, bob.userId, 10000);
      await getProgress(alice.token, raceId);

      // Alice has 1500, Bob has 10000 → swap → Alice 10000, Bob 1500
      const swap = await giveHeldPowerup(raceId, alice.userId, "SWITCHEROO", 99902);
      await usePowerup(alice.token, raceId, swap.id, bob.userId);

      const progress = await getProgress(alice.token, raceId);
      assert.equal(findUser(progress, alice.userId).totalSteps, 10000);
      assert.equal(findUser(progress, bob.userId).totalSteps, 1500);
    });
  });

  // === VALIDATION ===

  describe("validation", () => {
    it("can only swap up — rejects if target has fewer steps", async () => {
      const alice = await createUser("AliceValAAAA");
      const bob = await createUser("BobValAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      await giveBonusSteps(raceId, alice.userId, 15000);
      await giveBonusSteps(raceId, bob.userId, 5000);
      await getProgress(alice.token, raceId);

      const swap = await giveHeldPowerup(raceId, alice.userId, "SWITCHEROO", 99901);
      const res = await usePowerup(alice.token, raceId, swap.id, bob.userId);
      assert.equal(res.status, 400);
    });

    it("rejects if target has equal steps", async () => {
      const alice = await createUser("AliceValBBBB");
      const bob = await createUser("BobValBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      await giveBonusSteps(raceId, alice.userId, 10000);
      await giveBonusSteps(raceId, bob.userId, 10000);
      await getProgress(alice.token, raceId);

      const swap = await giveHeldPowerup(raceId, alice.userId, "SWITCHEROO", 99901);
      const res = await usePowerup(alice.token, raceId, swap.id, bob.userId);
      assert.equal(res.status, 400);
    });

    it("requires a target", async () => {
      const alice = await createUser("AliceValCCCC");
      const bob = await createUser("BobValCCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const swap = await giveHeldPowerup(raceId, alice.userId, "SWITCHEROO", 99901);
      const res = await usePowerup(alice.token, raceId, swap.id);
      assert.equal(res.status, 400);
    });

    it("cannot target yourself", async () => {
      const alice = await createUser("AliceValDDDD");
      const bob = await createUser("BobValDDDDDD");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const swap = await giveHeldPowerup(raceId, alice.userId, "SWITCHEROO", 99901);
      const res = await usePowerup(alice.token, raceId, swap.id, alice.userId);
      assert.equal(res.status, 400);
    });

    it("cannot target finished participant", async () => {
      const alice = await createUser("AliceValEEEE");
      const bob = await createUser("BobValEEEEEE");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const swap = await giveHeldPowerup(raceId, alice.userId, "SWITCHEROO", 99901);

      // Bob finishes
      await giveBonusSteps(raceId, bob.userId, 250000);
      await request(server.baseUrl, "POST", "/steps/samples", {
        body: { samples: [{ periodStart: new Date(Date.now() - 3600000).toISOString(), periodEnd: new Date().toISOString(), steps: 250000 }] },
        token: bob.token,
      });
      await getProgress(bob.token, raceId);

      const res = await usePowerup(alice.token, raceId, swap.id, bob.userId);
      assert.ok(res.status >= 400);
    });
  });

  // === SHIELD ===

  describe("shield interaction", () => {
    it("blocked by compression socks — no swap happens", async () => {
      const alice = await createUser("AliceShldAAA");
      const bob = await createUser("BobShieldAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      await giveBonusSteps(raceId, alice.userId, 5000);
      await giveBonusSteps(raceId, bob.userId, 15000);
      await getProgress(alice.token, raceId);

      // Bob activates shield
      const shield = await giveHeldPowerup(raceId, bob.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(bob.token, raceId, shield.id);

      const swap = await giveHeldPowerup(raceId, alice.userId, "SWITCHEROO", 99902);
      const res = await usePowerup(alice.token, raceId, swap.id, bob.userId);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.blocked, true);

      // Steps unchanged
      const progress = await getProgress(alice.token, raceId);
      assert.equal(findUser(progress, alice.userId).totalSteps, 5000);
      assert.equal(findUser(progress, bob.userId).totalSteps, 15000);
    });
  });

  // === FEED ===

  describe("feed", () => {
    it("shows swap event with target", async () => {
      const alice = await createUser("AliceFeedAAA");
      const bob = await createUser("BobFeedAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      await giveBonusSteps(raceId, alice.userId, 5000);
      await giveBonusSteps(raceId, bob.userId, 15000);
      await getProgress(alice.token, raceId);

      const swap = await giveHeldPowerup(raceId, alice.userId, "SWITCHEROO", 99901);
      await usePowerup(alice.token, raceId, swap.id, bob.userId);

      const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
      const feedBody = await feedRes.json();

      const event = feedBody.events.find(
        (e) => e.eventType === "POWERUP_USED" && e.powerupType === "SWITCHEROO"
      );
      assert.ok(event, "feed should contain switcheroo event");
      assert.ok(event.description.includes("Switcheroo"));
      assert.equal(event.targetUserId, bob.userId);
    });
  });
});
