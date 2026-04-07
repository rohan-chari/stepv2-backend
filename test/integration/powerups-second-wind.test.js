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

    it("finished participants excluded from leader calculation", async () => {
      const alice = await createUser("AliceEdgeBBB");
      const bob = await createUser("BobEdgeBBBBB");
      const charlie = await createUser("CharlieEdgeB");
      const dave = await createUser("DaveEdgeBBBB");
      await makeFriends(alice, bob);
      await makeFriends(alice, charlie);
      await makeFriends(alice, dave);
      await makeFriends(bob, charlie);
      const raceId = await createActiveRaceWith([alice, bob, charlie, dave], { targetSteps: 5000 });

      // Charlie finishes
      await giveBonusSteps(raceId, charlie.userId, 8000);
      await recordSamples(charlie.token, [
        { periodStart: minutesAgo(30).toISOString(), periodEnd: new Date().toISOString(), steps: 8000 },
      ]);

      // Bob is leader among active, alice is behind
      await giveBonusSteps(raceId, bob.userId, 4000);
      await giveBonusSteps(raceId, alice.userId, 1000);

      // Gap should be to bob (4000 - 1000 = 3000), not charlie
      const sw = await giveHeldPowerup(raceId, alice.userId, "SECOND_WIND", 99901);
      const res = await usePowerup(alice.token, raceId, sw.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      // gap = 3000, 25% = 750
      assert.equal(body.result.bonus, 750);
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
