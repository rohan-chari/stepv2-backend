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
  const appleId = `apple-cs-${++nextAppleId}`;
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
      name: "Compression Socks Test",
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
      rarity: type === "COMPRESSION_SOCKS" ? "RARE" : "UNCOMMON",
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

describe("compression socks", () => {
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


    it("shield persists across multiple progress fetches (no time expiry)", async () => {
      const alice = await createUser("AliceSocksBB");
      const bob = await createUser("BobSocksBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const shield = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(alice.token, raceId, shield.id);

      // Fetch progress multiple times — shield should survive
      await getProgress(alice.token, raceId);
      await getProgress(alice.token, raceId);
      await getProgress(alice.token, raceId);

      const effect = await prisma.raceActiveEffect.findFirst({
        where: { raceId, type: "COMPRESSION_SOCKS", targetUserId: alice.userId },
      });
      assert.equal(effect.status, "ACTIVE");
    });
  });

  // === VALIDATION ===

  describe("validation", () => {
    it("self-only — rejects if targetUserId provided", async () => {
      const alice = await createUser("AliceValAAAA");
      const bob = await createUser("BobValAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const shield = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99901);
      const res = await usePowerup(alice.token, raceId, shield.id, bob.userId);
      assert.equal(res.status, 400);
    });

    it("cannot stack — rejects second while one is active", async () => {
      const alice = await createUser("AliceValBBBB");
      const bob = await createUser("BobValBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const s1 = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99901);
      const s2 = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99902);

      await usePowerup(alice.token, raceId, s1.id);
      const res = await usePowerup(alice.token, raceId, s2.id);
      assert.equal(res.status, 400);
    });

    it("can re-activate after first is consumed by a block", async () => {
      const alice = await createUser("AliceValCCCC");
      const bob = await createUser("BobValCCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      await giveBonusSteps(raceId, alice.userId, 5000);

      // Activate shield
      const s1 = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(alice.token, raceId, s1.id);

      // Bob attacks — shield consumed
      const attack = await giveHeldPowerup(raceId, bob.userId, "SHORTCUT", 99902);
      await usePowerup(bob.token, raceId, attack.id, alice.userId);

      // Alice can activate a new shield
      const s2 = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99903);
      const res = await usePowerup(alice.token, raceId, s2.id);
      assert.equal(res.status, 200);
    });
  });

  // === BLOCKING ALL OFFENSIVE TYPES ===

  describe("blocks all offensive types", () => {
    it("blocks Wrong Turn", async () => {
      const alice = await createUser("AliceBlkAAAA");
      const bob = await createUser("BobBlockAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      await giveBonusSteps(raceId, alice.userId, 5000);

      const shield = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(alice.token, raceId, shield.id);

      const wt = await giveHeldPowerup(raceId, bob.userId, "WRONG_TURN", 99902);
      const res = await usePowerup(bob.token, raceId, wt.id, alice.userId);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.blocked, true);
      assert.equal(body.result.blockedBy, "COMPRESSION_SOCKS");
    });

    it("does NOT block self-only powerups (protein shake still works)", async () => {
      const alice = await createUser("AliceBlkBBBB");
      const bob = await createUser("BobBlockBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Alice has shield
      const shield = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(alice.token, raceId, shield.id);

      // Alice uses protein shake — should work, not blocked
      const shake = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99902);
      const res = await usePowerup(alice.token, raceId, shake.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.ok(!body.result.blocked);

      // Shield should still be active (not consumed by self-only powerup)
      const effect = await prisma.raceActiveEffect.findFirst({
        where: { raceId, type: "COMPRESSION_SOCKS", targetUserId: alice.userId, status: "ACTIVE" },
      });
      assert.ok(effect, "shield should still be active");
    });
  });

  // === EDGE CASES ===

  describe("edge cases", () => {
    it("only blocks ONE attack — second attack goes through", async () => {
      const alice = await createUser("AliceEdgeAAA");
      const bob = await createUser("BobEdgeAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      await giveBonusSteps(raceId, alice.userId, 5000);

      const shield = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(alice.token, raceId, shield.id);

      // First attack — blocked
      const a1 = await giveHeldPowerup(raceId, bob.userId, "LEG_CRAMP", 99902);
      const res1 = await usePowerup(bob.token, raceId, a1.id, alice.userId);
      assert.equal((await res1.json()).result.blocked, true);

      // Second attack — goes through
      const a2 = await giveHeldPowerup(raceId, bob.userId, "LEG_CRAMP", 99903);
      const res2 = await usePowerup(bob.token, raceId, a2.id, alice.userId);
      assert.equal(res2.status, 200);
      assert.ok(!(await res2.json()).result.blocked);
    });

    it("blocked attack shows POWERUP_BLOCKED feed event", async () => {
      const alice = await createUser("AliceEdgeBBB");
      const bob = await createUser("BobEdgeBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      await giveBonusSteps(raceId, alice.userId, 5000);

      const shield = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(alice.token, raceId, shield.id);

      const attack = await giveHeldPowerup(raceId, bob.userId, "SHORTCUT", 99902);
      await usePowerup(bob.token, raceId, attack.id, alice.userId);

      const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
      const feedBody = await feedRes.json();

      const blockEvent = feedBody.events.find((e) => e.eventType === "POWERUP_BLOCKED");
      assert.ok(blockEvent, "feed should contain POWERUP_BLOCKED event");
      assert.ok(blockEvent.description.includes("Compression Socks"));
    });

    it("shield survives when opponent uses non-offensive powerup", async () => {
      const alice = await createUser("AliceEdgeCCC");
      const bob = await createUser("BobEdgeCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Alice has shield
      const shield = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(alice.token, raceId, shield.id);

      // Bob uses runner's high (self-only, non-offensive) — shouldn't consume alice's shield
      const rh = await giveHeldPowerup(raceId, bob.userId, "RUNNERS_HIGH", 99902);
      await usePowerup(bob.token, raceId, rh.id);

      // Alice's shield should still be active
      const effect = await prisma.raceActiveEffect.findFirst({
        where: { raceId, type: "COMPRESSION_SOCKS", targetUserId: alice.userId, status: "ACTIVE" },
      });
      assert.ok(effect, "shield should survive non-offensive powerup usage");

      // Next offensive attack should still be blocked
      await giveBonusSteps(raceId, alice.userId, 5000);
      const attack = await giveHeldPowerup(raceId, bob.userId, "SHORTCUT", 99903);
      const res = await usePowerup(bob.token, raceId, attack.id, alice.userId);
      assert.equal((await res.json()).result.blocked, true);
    });
  });

  // === 24-HOUR EXPIRY ===

  describe("24-hour expiry", () => {
    it("shield expires after 24 hours if not consumed", async () => {
      const alice = await createUser("AliceExpAAAA");
      const bob = await createUser("BobExpAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const shield = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(alice.token, raceId, shield.id);

      // Force expiry by setting expiresAt to the past
      const effect = await prisma.raceActiveEffect.findFirst({
        where: { raceId, type: "COMPRESSION_SOCKS" },
      });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { expiresAt: new Date(Date.now() - 60000) },
      });

      // Trigger expiry via progress fetch
      await getProgress(alice.token, raceId);

      // Shield should be expired
      const updated = await prisma.raceActiveEffect.findFirst({
        where: { id: effect.id },
      });
      assert.equal(updated.status, "EXPIRED");

      // Next attack should go through (no shield)
      await giveBonusSteps(raceId, alice.userId, 5000);
      const attack = await giveHeldPowerup(raceId, bob.userId, "SHORTCUT", 99902);
      const attackRes = await usePowerup(bob.token, raceId, attack.id, alice.userId);
      assert.ok(!(await attackRes.json()).result.blocked, "attack should not be blocked after shield expired");
    });

    it("shield effect has expiresAt set on creation", async () => {
      const alice = await createUser("AliceExpBBBB");
      const bob = await createUser("BobExpBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const shield = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(alice.token, raceId, shield.id);

      const effect = await prisma.raceActiveEffect.findFirst({
        where: { raceId, type: "COMPRESSION_SOCKS" },
      });
      assert.ok(effect.expiresAt, "should have expiresAt set");

      const diffHours = (effect.expiresAt.getTime() - effect.startsAt.getTime()) / (60 * 60 * 1000);
      assert.equal(diffHours, 24);
    });

    it("existing shields without expiresAt still work (backwards compat)", async () => {
      const alice = await createUser("AliceExpCCCC");
      const bob = await createUser("BobExpCCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      await giveBonusSteps(raceId, alice.userId, 5000);

      // Manually create a shield with null expiresAt (old data)
      const aliceP = await prisma.raceParticipant.findFirst({ where: { raceId, userId: alice.userId } });
      const powerup = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99901);
      await prisma.racePowerup.update({ where: { id: powerup.id }, data: { status: "USED" } });
      await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: aliceP.id,
          targetUserId: alice.userId,
          sourceUserId: alice.userId,
          powerupId: powerup.id,
          type: "COMPRESSION_SOCKS",
          status: "ACTIVE",
          startsAt: new Date(),
          expiresAt: null, // old-style, no expiry
        },
      });

      // Attack should still be blocked
      const attack = await giveHeldPowerup(raceId, bob.userId, "SHORTCUT", 99902);
      const res = await usePowerup(bob.token, raceId, attack.id, alice.userId);
      assert.equal((await res.json()).result.blocked, true);
    });
  });
});
