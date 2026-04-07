const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-tm-${++nextAppleId}`;
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
      name: "Trail Mix Test",
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
      rarity: "COMMON",
      status: "HELD",
      earnedAtSteps,
    },
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

describe("trail mix", () => {
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
    it("first powerup used is trail mix → 1 unique type × 100 = 100 bonus", async () => {
      const alice = await createUser("AliceMixAAAA");
      const bob = await createUser("BobMixAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99901);
      const res = await usePowerup(alice.token, raceId, tm.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.bonus, 100);

      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      assert.equal(aliceP.totalSteps, 100);
    });

    it("used 2 other types before trail mix → 3 × 100 = 300 bonus", async () => {
      const alice = await createUser("AliceMixBBBB");
      const bob = await createUser("BobMixBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Use 2 different powerup types first
      const shake = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
      await usePowerup(alice.token, raceId, shake.id);

      const shortcut = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99902);
      // Bob needs steps for shortcut to work
      const bobP = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
      await prisma.raceParticipant.update({ where: { id: bobP.id }, data: { bonusSteps: 5000, totalSteps: 5000 } });
      await usePowerup(alice.token, raceId, shortcut.id, bob.userId);

      // Now use trail mix
      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99903);
      const res = await usePowerup(alice.token, raceId, tm.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      // PROTEIN_SHAKE + SHORTCUT + TRAIL_MIX = 3 unique × 100 = 300
      assert.equal(body.result.bonus, 300);
    });

    it("using same type twice doesn't double count", async () => {
      const alice = await createUser("AliceMixCCCC");
      const bob = await createUser("BobMixCCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Use two protein shakes
      const s1 = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
      const s2 = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99902);
      await usePowerup(alice.token, raceId, s1.id);
      await usePowerup(alice.token, raceId, s2.id);

      // Trail mix should count only 1 unique type (PROTEIN_SHAKE) + itself
      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99903);
      const res = await usePowerup(alice.token, raceId, tm.id);
      const body = await res.json();
      // PROTEIN_SHAKE (1 unique, not 2) + TRAIL_MIX = 2 × 100 = 200
      assert.equal(body.result.bonus, 200);
    });

    it("multiple trail mixes recalculate with updated unique count", async () => {
      const alice = await createUser("AliceMixDDDD");
      const bob = await createUser("BobMixDDDDDD");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // First trail mix: only itself = 100
      const tm1 = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99901);
      const res1 = await usePowerup(alice.token, raceId, tm1.id);
      assert.equal((await res1.json()).result.bonus, 100);

      // Use a protein shake
      const shake = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99902);
      await usePowerup(alice.token, raceId, shake.id);

      // Second trail mix: TRAIL_MIX + PROTEIN_SHAKE + this TRAIL_MIX = still 2 unique types
      // (TRAIL_MIX is already counted from first use)
      const tm2 = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99903);
      const res2 = await usePowerup(alice.token, raceId, tm2.id);
      // TRAIL_MIX + PROTEIN_SHAKE = 2 unique × 100 = 200
      assert.equal((await res2.json()).result.bonus, 200);
    });
  });

  // === VALIDATION ===

  describe("validation", () => {
    it("self-only — rejects if targetUserId provided", async () => {
      const alice = await createUser("AliceValAAAA");
      const bob = await createUser("BobValAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99901);
      const res = await usePowerup(alice.token, raceId, tm.id, bob.userId);
      assert.equal(res.status, 400);
    });

    it("not blocked by compression socks", async () => {
      const alice = await createUser("AliceValBBBB");
      const bob = await createUser("BobValBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Alice has shield
      const shield = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(alice.token, raceId, shield.id);

      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99902);
      const res = await usePowerup(alice.token, raceId, tm.id);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.ok(!body.result.blocked);
    });
  });

  // === EDGE CASES ===

  describe("edge cases", () => {
    it("only counts USED powerups, not HELD or DISCARDED", async () => {
      const alice = await createUser("AliceEdgeAAA");
      const bob = await createUser("BobEdgeAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Give alice a held protein shake (not used)
      await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);

      // Give alice a discarded shortcut
      const sc = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99902);
      await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${sc.id}/discard`, { token: alice.token });

      // Trail mix should only count itself (no USED types yet)
      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99903);
      const res = await usePowerup(alice.token, raceId, tm.id);
      assert.equal((await res.json()).result.bonus, 100);
    });

    it("only counts powerups from this race, not other races", async () => {
      const alice = await createUser("AliceEdgeBBB");
      const bob = await createUser("BobEdgeBBBBB");
      const charlie = await createUser("CharlieEdgeB");
      await makeFriends(alice, bob);
      await makeFriends(alice, charlie);

      // Race A: use a protein shake
      const raceA = await createActiveRace(alice, bob);
      const shakeA = await giveHeldPowerup(raceA, alice.userId, "PROTEIN_SHAKE", 99901);
      await usePowerup(alice.token, raceA, shakeA.id);

      // Race B: trail mix should not count Race A's protein shake
      const raceB = await createActiveRace(alice, charlie);
      const tm = await giveHeldPowerup(raceB, alice.userId, "TRAIL_MIX", 99902);
      const res = await usePowerup(alice.token, raceB, tm.id);
      // Only trail mix itself = 100
      assert.equal((await res.json()).result.bonus, 100);
    });

    it("bonus persists in progress", async () => {
      const alice = await createUser("AliceEdgeCCC");
      const bob = await createUser("BobEdgeCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99901);
      await usePowerup(alice.token, raceId, tm.id);

      const progress = await getProgress(alice.token, raceId);
      const aliceP = findUser(progress, alice.userId);
      assert.equal(aliceP.totalSteps, 100);

      // Fetch again
      const progress2 = await getProgress(alice.token, raceId);
      const aliceP2 = findUser(progress2, alice.userId);
      assert.equal(aliceP2.totalSteps, 100);
    });
  });

  // === FEED ===

  describe("feed", () => {
    it("shows bonus amount and unique count in event", async () => {
      const alice = await createUser("AliceFeedAAA");
      const bob = await createUser("BobFeedAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Use a protein shake first
      const shake = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
      await usePowerup(alice.token, raceId, shake.id);

      const tm = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MIX", 99902);
      await usePowerup(alice.token, raceId, tm.id);

      const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
      const feedBody = await feedRes.json();

      const event = feedBody.events.find(
        (e) => e.eventType === "POWERUP_USED" && e.powerupType === "TRAIL_MIX"
      );
      assert.ok(event, "feed should contain trail mix event");
      assert.ok(event.description.includes("Trail Mix"));
    });
  });
});
