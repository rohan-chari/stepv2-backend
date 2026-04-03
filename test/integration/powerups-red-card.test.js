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
  const appleId = `apple-rc-${++nextAppleId}`;
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
      name: "Red Card Test",
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

describe("red card", () => {
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
    it("deducts 10% of leader's steps", async () => {
      const alice = await createUser("AliceCardAAA");
      const bob = await createUser("BobCardAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      // Bob is leader with 10000 steps
      await giveBonusSteps(raceId, bob.userId, 10000);
      // Alice has fewer
      await giveBonusSteps(raceId, alice.userId, 3000);

      const card = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99901);
      const res = await usePowerup(alice.token, raceId, card.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.penalty, 1000); // 10% of 10000

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 9000); // 10000 - 1000
    });

    it("auto-targets the current leader (no target specified)", async () => {
      const alice = await createUser("AliceCardBBB");
      const bob = await createUser("BobCardBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      await giveBonusSteps(raceId, bob.userId, 20000);
      await giveBonusSteps(raceId, alice.userId, 5000);

      const card = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99901);
      const res = await usePowerup(alice.token, raceId, card.id); // no targetUserId
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.penalty, 2000); // 10% of 20000
    });

    it("in 3+ player race, always hits the #1 leader", async () => {
      const alice = await createUser("AliceCardCCC");
      const bob = await createUser("BobCardCCCCC");
      const charlie = await createUser("CharlieCardC");
      await makeFriends(alice, bob);
      await makeFriends(alice, charlie);
      await makeFriends(bob, charlie);
      const raceId = await createActiveRaceWith([alice, bob, charlie]);

      // Charlie is leader, Bob is second, Alice is last
      await giveBonusSteps(raceId, charlie.userId, 25000);
      await giveBonusSteps(raceId, bob.userId, 10000);
      await giveBonusSteps(raceId, alice.userId, 5000);

      const card = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99901);
      const res = await usePowerup(alice.token, raceId, card.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.penalty, 2500); // 10% of 25000 (charlie, not bob)

      const progress = await getProgress(alice.token, raceId);
      const charlieP = findUser(progress, charlie.userId);
      assert.equal(charlieP.totalSteps, 22500);
      // Bob should be unaffected
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 10000);
    });

    it("penalty rounds correctly with Math.round", async () => {
      const alice = await createUser("AliceCardDDD");
      const bob = await createUser("BobCardDDDDD");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      // 10% of 1555 = 155.5 → Math.round → 156
      await giveBonusSteps(raceId, bob.userId, 1555);
      await giveBonusSteps(raceId, alice.userId, 100);

      const card = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99901);
      const res = await usePowerup(alice.token, raceId, card.id);
      const body = await res.json();
      assert.equal(body.result.penalty, 156);
    });
  });

  // === VALIDATION ===

  describe("validation", () => {
    it("cannot use while you are the leader", async () => {
      const alice = await createUser("AliceValAAAA");
      const bob = await createUser("BobValAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      // Alice is leader
      await giveBonusSteps(raceId, alice.userId, 15000);
      await giveBonusSteps(raceId, bob.userId, 5000);

      const card = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99901);
      const res = await usePowerup(alice.token, raceId, card.id);
      assert.equal(res.status, 400);
    });

    it("cannot use when leaders are tied", async () => {
      const alice = await createUser("AliceValBBBB");
      const bob = await createUser("BobValBBBBBB");
      const charlie = await createUser("CharlieValBB");
      await makeFriends(alice, bob);
      await makeFriends(alice, charlie);
      await makeFriends(bob, charlie);
      const raceId = await createActiveRaceWith([alice, bob, charlie]);

      // Bob and charlie tied at top
      await giveBonusSteps(raceId, bob.userId, 10000);
      await giveBonusSteps(raceId, charlie.userId, 10000);
      await giveBonusSteps(raceId, alice.userId, 3000);

      const card = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99901);
      const res = await usePowerup(alice.token, raceId, card.id);
      assert.equal(res.status, 400);
    });

    it("rejects if targetUserId is explicitly provided", async () => {
      const alice = await createUser("AliceValCCCC");
      const bob = await createUser("BobValCCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      await giveBonusSteps(raceId, bob.userId, 10000);
      await giveBonusSteps(raceId, alice.userId, 3000);

      const card = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99901);
      const res = await usePowerup(alice.token, raceId, card.id, bob.userId);
      assert.equal(res.status, 400);
    });

    it("skips finished participants when finding leader", async () => {
      const alice = await createUser("AliceValDDDD");
      const bob = await createUser("BobValDDDDDD");
      const charlie = await createUser("CharlieValDD");
      await makeFriends(alice, bob);
      await makeFriends(alice, charlie);
      await makeFriends(bob, charlie);
      const raceId = await createActiveRaceWith([alice, bob, charlie], { targetSteps: 5000 });

      // Charlie finishes the race
      await giveBonusSteps(raceId, charlie.userId, 8000);
      await recordSamples(charlie.token, [
        { periodStart: minutesAgo(30).toISOString(), periodEnd: new Date().toISOString(), steps: 8000 },
      ]);
      await getProgress(charlie.token, raceId); // trigger finish

      // Bob is leader among active participants
      await giveBonusSteps(raceId, bob.userId, 3000);
      await giveBonusSteps(raceId, alice.userId, 1000);

      const card = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99901);
      const res = await usePowerup(alice.token, raceId, card.id);
      assert.equal(res.status, 200);

      // Should target bob (active leader), not charlie (finished)
      const body = await res.json();
      assert.equal(body.result.penalty, 300); // 10% of 3000
    });
  });

  // === SHIELD INTERACTION ===

  describe("shield interaction", () => {
    it("blocked by compression socks — no steps deducted", async () => {
      const alice = await createUser("AliceShldAAA");
      const bob = await createUser("BobShieldAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      await giveBonusSteps(raceId, bob.userId, 10000);
      await giveBonusSteps(raceId, alice.userId, 3000);

      // Bob activates shield
      const shield = await giveHeldPowerup(raceId, bob.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(bob.token, raceId, shield.id);

      // Alice uses red card
      const card = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99902);
      const res = await usePowerup(alice.token, raceId, card.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.blocked, true);

      // Bob should still have 10000
      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 10000);
    });

    it("both powerups consumed on block", async () => {
      const alice = await createUser("AliceShldBBB");
      const bob = await createUser("BobShieldBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      await giveBonusSteps(raceId, bob.userId, 10000);
      await giveBonusSteps(raceId, alice.userId, 3000);

      const shield = await giveHeldPowerup(raceId, bob.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(bob.token, raceId, shield.id);

      const card = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99902);
      await usePowerup(alice.token, raceId, card.id);

      // Red card consumed — can't use again
      const res = await usePowerup(alice.token, raceId, card.id);
      assert.ok(res.status >= 400);

      // Shield consumed — next attack goes through
      const card2 = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99903);
      const res2 = await usePowerup(alice.token, raceId, card2.id);
      assert.equal(res2.status, 200);
      assert.ok(!(await res2.json()).result.blocked);
    });
  });

  // === EDGE CASES ===

  describe("edge cases", () => {
    it("leader with very few steps — penalty doesn't make them negative", async () => {
      const alice = await createUser("AliceEdgeAAA");
      const bob = await createUser("BobEdgeAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      await giveBonusSteps(raceId, bob.userId, 5);
      await giveBonusSteps(raceId, alice.userId, 1);

      const card = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99901);
      const res = await usePowerup(alice.token, raceId, card.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.ok(body.result.penalty >= 0);
      assert.ok(body.result.penalty <= 5);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.ok(bobP.totalSteps >= 0, `should not go negative, got ${bobP.totalSteps}`);
    });

    it("red card on leader who only has bonus steps", async () => {
      const alice = await createUser("AliceEdgeBBB");
      const bob = await createUser("BobEdgeBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      // Bob has only bonus steps (from protein shakes)
      const shake1 = await giveHeldPowerup(raceId, bob.userId, "PROTEIN_SHAKE", 99901);
      const shake2 = await giveHeldPowerup(raceId, bob.userId, "PROTEIN_SHAKE", 99902);
      await usePowerup(bob.token, raceId, shake1.id);
      await usePowerup(bob.token, raceId, shake2.id);
      // Bob has 3000 bonus steps

      // Sync totalSteps so red card sees bob as leader
      await getProgress(bob.token, raceId);

      await giveBonusSteps(raceId, alice.userId, 1000);

      const card = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99903);
      const res = await usePowerup(alice.token, raceId, card.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.penalty, 300); // 10% of 3000
    });

    it("multiple red cards reduce leader's steps compound", async () => {
      const alice = await createUser("AliceEdgeCCC");
      const bob = await createUser("BobEdgeCCCCC");
      const charlie = await createUser("CharlieEdgeC");
      await makeFriends(alice, bob);
      await makeFriends(alice, charlie);
      await makeFriends(bob, charlie);
      const raceId = await createActiveRaceWith([alice, bob, charlie]);

      await giveBonusSteps(raceId, bob.userId, 10000);
      await giveBonusSteps(raceId, alice.userId, 2000);
      await giveBonusSteps(raceId, charlie.userId, 2000);

      // Alice red cards — bob loses 1000 (10% of 10000) → 9000
      const c1 = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99901);
      await usePowerup(alice.token, raceId, c1.id);

      // Sync totalSteps so charlie's red card sees bob's reduced total
      await getProgress(alice.token, raceId);

      // Charlie red cards — bob loses 900 (10% of 9000) → 8100
      const c2 = await giveHeldPowerup(raceId, charlie.userId, "RED_CARD", 99902);
      await usePowerup(charlie.token, raceId, c2.id);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 8100);
    });

    it("stealthed leader is still targeted", async () => {
      const alice = await createUser("AliceEdgeDDD");
      const bob = await createUser("BobEdgeDDDDD");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      await giveBonusSteps(raceId, bob.userId, 10000);
      await giveBonusSteps(raceId, alice.userId, 3000);

      // Bob goes stealth
      const stealth = await giveHeldPowerup(raceId, bob.userId, "STEALTH_MODE", 99901);
      await usePowerup(bob.token, raceId, stealth.id);

      // Alice uses red card — should still target bob despite stealth
      const card = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99902);
      const res = await usePowerup(alice.token, raceId, card.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.penalty, 1000); // 10% of 10000
    });
  });

  // === FEED ===

  describe("feed", () => {
    it("shows who was targeted and the penalty amount", async () => {
      const alice = await createUser("AliceFeedAAA");
      const bob = await createUser("BobFeedAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRaceWith([alice, bob]);

      await giveBonusSteps(raceId, bob.userId, 10000);
      await giveBonusSteps(raceId, alice.userId, 3000);

      const card = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99901);
      await usePowerup(alice.token, raceId, card.id);

      const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
      const feedBody = await feedRes.json();

      const event = feedBody.events.find(
        (e) => e.eventType === "POWERUP_USED" && e.powerupType === "RED_CARD"
      );
      assert.ok(event, "feed should contain red card event");
      assert.ok(event.description.includes("1,000") || event.description.includes("1000"));
      assert.equal(event.targetUserId, bob.userId);
    });
  });
});
