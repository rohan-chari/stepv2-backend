// Canonical powerup integration suite.


// ---- consolidated from powerups-compression-socks.test.js ----
(function powerups_compression_socks_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

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

  describe("activation is silent", () => {
    // Announcing "X is shielded" tells every rival to hold their attack, or to
    // burn a cheap one to strip the shield. MIRROR — the other held shield — is
    // already silent for exactly this reason; socks now match. The after-the-
    // fact POWERUP_BLOCKED event stays: by then both players know.
    it("writes no POWERUP_USED feed event when the shield goes up", async () => {
      const alice = await createUser("AliceSilentA");
      const bob = await createUser("BobSilentAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const shield = await giveHeldPowerup(raceId, alice.userId, "COMPRESSION_SOCKS", 99911);
      const useRes = await usePowerup(alice.token, raceId, shield.id);
      assert.equal(useRes.status, 200);

      // The shield really is armed...
      const effects = await prisma.raceActiveEffect.findMany({
        where: { raceId, targetUserId: alice.userId, type: "COMPRESSION_SOCKS" },
      });
      assert.equal(effects.length, 1, "the shield effect row must still be written");

      // ...but nobody is told about it, including the caster.
      for (const viewer of [alice, bob]) {
        const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: viewer.token });
        const feedBody = await feedRes.json();
        const socksEvent = feedBody.events.find(
          (e) => e.powerupType === "COMPRESSION_SOCKS" && e.eventType === "POWERUP_USED"
        );
        assert.equal(socksEvent, undefined, "no POWERUP_USED event may announce the shield");
      }
    });
  });
});

})();


// ---- consolidated from powerups-dual-shield.test.js ----
(function powerups_dual_shield_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

// ---------------------------------------------------------------------------
// DUAL SHIELD: Compression Socks + Mirror both active, then attacked
//
// Design rule under test: MIRROR takes precedence over Compression Socks. When
// a target holds BOTH active shields and an offensive powerup (Red Card,
// Shortcut, etc.) is used against them, the Mirror fires first: the attack is
// REFLECTED back onto the attacker (the attacker eats the penalty), the Mirror
// is consumed, and the Compression Socks shield is left ACTIVE — banked for a
// later attack. So a dual-shield holder gets two saves: this hit reflects off
// the Mirror, and a follow-up hit would then be blocked by the socks.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-dual-${++nextAppleId}`;
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
      name: "Dual Shield Test",
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
  const rareTypes = ["COMPRESSION_SOCKS", "MIRROR"];
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: rareTypes.includes(type) ? "RARE" : "COMMON",
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

async function shieldStatus(raceId, userId, type) {
  const effect = await prisma.raceActiveEffect.findFirst({
    where: { raceId, type, targetUserId: userId },
    orderBy: { startsAt: "desc" },
  });
  return effect ? effect.status : "(none)";
}

// Arm a defender (Bob) with BOTH shields active and return the race id.
async function setupDualShield({ aliceSteps, bobSteps }) {
  const alice = await createUser("AliceAtk"); // attacker
  const bob = await createUser("BobDualSh"); // holds BOTH shields
  await makeFriends(alice, bob);
  const raceId = await createActiveRace(alice, bob);

  await giveBonusSteps(raceId, alice.userId, aliceSteps);
  await giveBonusSteps(raceId, bob.userId, bobSteps);

  const socks = await giveHeldPowerup(raceId, bob.userId, "COMPRESSION_SOCKS", 99901);
  const socksRes = await usePowerup(bob.token, raceId, socks.id);
  assert.equal(socksRes.status, 200, "socks should activate");

  const mirror = await giveHeldPowerup(raceId, bob.userId, "MIRROR", 99902);
  const mirrorRes = await usePowerup(bob.token, raceId, mirror.id);
  assert.equal(mirrorRes.status, 200, "mirror should activate");

  return { alice, bob, raceId };
}

async function reportOutcome(label, { alice, bob, raceId }, attackRes) {
  const body = await attackRes.json();
  const progress = await getProgress(alice.token, raceId);
  const aliceP = findUser(progress, alice.userId);
  const bobP = findUser(progress, bob.userId);

  const summary = {
    scenario: label,
    httpStatus: attackRes.status,
    result: body.result,
    attackerSteps_after: aliceP.totalSteps,
    defenderSteps_after: bobP.totalSteps,
    socks_status_after: await shieldStatus(raceId, bob.userId, "COMPRESSION_SOCKS"),
    mirror_status_after: await shieldStatus(raceId, bob.userId, "MIRROR"),
  };
  console.log(`\n=== DUAL SHIELD OUTCOME: ${label} ===`);
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

describe("dual shield (compression socks + mirror) under attack", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {});

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("SHORTCUT against a dual-shield holder reflects off the Mirror; socks banked", async () => {
    // Both at 5000 so the reflected steal has steps to move.
    const ctx = await setupDualShield({ aliceSteps: 5000, bobSteps: 5000 });

    const shortcut = await giveHeldPowerup(ctx.raceId, ctx.alice.userId, "SHORTCUT", 99903);
    const res = await usePowerup(ctx.alice.token, ctx.raceId, shortcut.id, ctx.bob.userId);
    const summary = await reportOutcome("SHORTCUT vs socks+mirror", ctx, res);

    assert.equal(res.status, 200);
    // Mirror wins: the Shortcut reflects back onto the attacker.
    assert.equal(summary.result.outcome, "REFLECTED");
    assert.equal(summary.result.reflectedBy, "MIRROR");
    assert.equal(summary.result.stolen, 1000);
    // The reflected steal moves 1000 steps FROM the attacker TO the mirror holder.
    assert.equal(summary.attackerSteps_after, 4000, "attacker loses the reflected 1000");
    assert.equal(summary.defenderSteps_after, 6000, "mirror holder gains the reflected 1000");
    // Mirror is spent; the socks shield is untouched and banked for next time.
    assert.equal(summary.mirror_status_after, "EXPIRED", "mirror is consumed on reflect");
    assert.equal(summary.socks_status_after, "ACTIVE", "socks survives — banked for a later attack");
  });

  it("RED CARD against a dual-shield holder reflects off the Mirror; socks banked", async () => {
    // Red Card auto-targets the leader, so the dual-shield holder (Bob) must be
    // ahead for the attack to land on him. Bob 8000 > Alice 5000.
    const ctx = await setupDualShield({ aliceSteps: 5000, bobSteps: 8000 });

    const redCard = await giveHeldPowerup(ctx.raceId, ctx.alice.userId, "RED_CARD", 99903);
    // Red Card resolves its own target (the leader); targetUserId is ignored.
    const res = await usePowerup(ctx.alice.token, ctx.raceId, redCard.id);
    const summary = await reportOutcome("RED_CARD vs socks+mirror", ctx, res);

    assert.equal(res.status, 200);
    // Mirror wins: the Red Card reflects back onto the attacker.
    assert.equal(summary.result.outcome, "REFLECTED");
    assert.equal(summary.result.reflectedBy, "MIRROR");
    // Item 8: penalty is 10% of the (post-reflect) target = the attacker's own 5000 steps.
    assert.equal(summary.result.penalty, 500);
    assert.equal(summary.attackerSteps_after, 4500, "attacker eats the 500-step Red Card penalty");
    assert.equal(summary.defenderSteps_after, 8000, "mirror holder is untouched");
    // Mirror is spent; the socks shield is untouched and banked for next time.
    assert.equal(summary.mirror_status_after, "EXPIRED", "mirror is consumed on reflect");
    assert.equal(summary.socks_status_after, "ACTIVE", "socks survives — banked for a later attack");
  });
});

})();


// ---- consolidated from powerups-shortcut-mirror.test.js ----
(function powerups_shortcut_mirror_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

// ---------------------------------------------------------------------------
// SHORTCUT vs MIRROR (end-to-end)
//
// The attacker uses Shortcut on a target holding an active Mirror. The Mirror
// reflects the Shortcut back onto the attacker, so the steal runs in reverse:
// 1000 steps are taken FROM the attacker and given to the original target.
//
// Expectation under test: the net result is the attacker ("the user") just
// losing 1000 steps.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-scm-${++nextAppleId}`;
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
      name: "Shortcut vs Mirror",
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
  const rareTypes = ["COMPRESSION_SOCKS", "MIRROR"];
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: rareTypes.includes(type) ? "RARE" : "COMMON",
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

describe("shortcut reflected by mirror", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {});

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("net result is the attacker just losing 1000 steps", async () => {
    const alice = await createUser("AliceAttacker"); // uses the shortcut
    const bob = await createUser("BobMirror"); // holds the mirror
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // Both start with 5000 steps. Alice needs steps so the reflected steal has
    // something to take; Bob needs steps so the shortcut is a valid attack.
    await giveBonusSteps(raceId, alice.userId, 5000);
    await giveBonusSteps(raceId, bob.userId, 5000);

    // Bob activates Mirror (self-applied, no target).
    const mirror = await giveHeldPowerup(raceId, bob.userId, "MIRROR", 99901);
    const mirrorRes = await usePowerup(bob.token, raceId, mirror.id);
    assert.equal(mirrorRes.status, 200);

    // Alice uses Shortcut on Bob — Bob's Mirror reflects it back at Alice.
    const shortcut = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99902);
    const res = await usePowerup(alice.token, raceId, shortcut.id, bob.userId);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.result.outcome, "REFLECTED");
    assert.equal(body.result.stolen, 1000);

    // End result: Alice (the user who used the shortcut) is down exactly 1000.
    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    const bobP = findUser(progress, bob.userId);

    assert.equal(aliceP.totalSteps, 4000, "attacker should lose 1000 steps");
    assert.equal(bobP.totalSteps, 6000, "the reflected steps go to the mirror holder");
  });
});

})();


// ---- consolidated from powerups-stealth-redcard.test.js ----
(function powerups_stealth_redcard_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

// ---------------------------------------------------------------------------
// STEALTH MODE + RED CARD
//
// A player is the leader AND has Stealth Mode active (their progress is hidden
// on the leaderboard). Another player uses Red Card — which auto-targets the
// leader. Behavior under test:
//
// Red Card resolves the leader by TRUE server-side steps (usePowerup.js:236),
// while Stealth Mode only masks the leaderboard/feed VIEW at read time. So:
//   * the Red Card still lands on the stealthed leader (5% of their steps),
//   * Stealth Mode is NOT consumed (it is a timed buff, not a shield),
//   * the leader stays hidden on the leaderboard afterward, and
//   * the feed event hides the leader's name (??? to the attacker, real name to
//     the stealthed player themselves).
//
// In short: stealth hides WHO got hit, it does not grant damage immunity.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-stealth-${++nextAppleId}`;
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
      name: "Stealth + Red Card Test",
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
  const rareTypes = ["COMPRESSION_SOCKS", "MIRROR", "RED_CARD", "STEALTH_MODE", "SECOND_WIND"];
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: rareTypes.includes(type) ? "RARE" : "COMMON",
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

async function getFeed(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token });
  return (await res.json()).events;
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

async function stealthStatus(raceId, userId) {
  const effect = await prisma.raceActiveEffect.findFirst({
    where: { raceId, type: "STEALTH_MODE", targetUserId: userId },
    orderBy: { startsAt: "desc" },
  });
  return effect ? effect.status : "(none)";
}

describe("stealth mode + red card", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {});

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("RED CARD lands on a stealthed leader; stealth survives and masks the feed", async () => {
    const alice = await createUser("AliceAtk"); // behind; uses Red Card
    const bob = await createUser("BobStealth"); // leader; goes stealth
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // Bob leads with 8000, Alice trails with 5000.
    await giveBonusSteps(raceId, alice.userId, 5000);
    await giveBonusSteps(raceId, bob.userId, 8000);

    // Bob activates Stealth Mode (self-only, no target).
    const stealth = await giveHeldPowerup(raceId, bob.userId, "STEALTH_MODE", 99901);
    const stealthRes = await usePowerup(bob.token, raceId, stealth.id);
    assert.equal(stealthRes.status, 200, "stealth should activate");

    // Alice uses Red Card — auto-targets the leader (Bob) by true steps.
    const redCard = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99902);
    const res = await usePowerup(alice.token, raceId, redCard.id);
    const body = await res.json();

    // Bob's own view shows his true steps (stealth never hides self).
    const bobView = await getProgress(bob.token, raceId);
    const bobSelf = findUser(bobView, bob.userId);

    // Alice's view of Bob (should be stealth-masked).
    const aliceView = await getProgress(alice.token, raceId);
    const bobAsSeenByAlice = findUser(aliceView, bob.userId);

    // Feed descriptions for the Red Card event from each viewer's POV.
    const aliceFeed = await getFeed(alice.token, raceId);
    const bobFeed = await getFeed(bob.token, raceId);
    const redCardEventForAlice = aliceFeed.find((e) => e.powerupType === "RED_CARD");
    const redCardEventForBob = bobFeed.find((e) => e.powerupType === "RED_CARD");

    // The Red Card lands normally — not blocked, not reflected.
    assert.equal(res.status, 200);
    assert.equal(body.result.outcome, "APPLIED");
    assert.ok(!body.result.blocked);
    assert.equal(body.result.penalty, 800, "10% of the stealthed leader's 8000 steps");

    // The penalty hits the stealthed leader's true total.
    assert.equal(bobSelf.totalSteps, 7200, "leader loses 800 despite being stealthed");

    // Stealth Mode is untouched — it is a timed buff, not a shield.
    assert.equal(await stealthStatus(raceId, bob.userId), "ACTIVE");

    // The leader stays hidden on the leaderboard to the attacker after the hit.
    assert.ok(bobAsSeenByAlice, "Bob is still listed for Alice");
    assert.equal(bobAsSeenByAlice.stealthed, true, "Bob is still stealthed to Alice");
    assert.equal(bobAsSeenByAlice.totalSteps, null, "Bob's steps stay hidden from Alice");

    // Feed redaction survives the hit: the attacker sees who did it but not who
    // got hit (??? for the stealthed target); the stealthed player sees their
    // own real name.
    assert.ok(redCardEventForAlice, "Red Card event is in Alice's feed");
    assert.ok(
      redCardEventForAlice.description.includes("???"),
      "the stealthed target's name is masked in the attacker's feed"
    );
    assert.ok(
      !redCardEventForAlice.description.includes("BobStealth"),
      "the stealthed target's real name must not leak to the attacker"
    );
    assert.ok(redCardEventForBob, "Red Card event is in Bob's feed");
    assert.ok(
      redCardEventForBob.description.includes("BobStealth"),
      "the stealthed player sees their own real name in their feed"
    );
  });
});

})();

// ---- consolidated from decoy-redirection-concurrency.test.js ----
(function decoy_redirection_concurrency_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

let server;
let nextAppleId = 0;

const POWERUPS5 = {
  "X-Client-Features": "characters,powerups5",
};
const TEAM_POWERUPS5 = {
  "X-Client-Features": "characters,team_races,powerups5",
};

async function createUser(displayName, headers = POWERUPS5) {
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: `apple-decoy-${++nextAppleId}` },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
    headers,
  });
  return { userId: body.user.id, token: body.sessionToken };
}

async function makeFriends(a, b, headers = POWERUPS5) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
    headers,
  });
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
    body: { accept: true },
    token: b.token,
    headers,
  });
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function createSoloRace(users) {
  const [creator, ...opponents] = users;
  for (const opponent of opponents) await makeFriends(creator, opponent);
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Decoy Solo",
      isPublic: true,
      targetSteps: 200000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: creator.token,
    headers: POWERUPS5,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: opponents.map((user) => user.userId) },
    token: creator.token,
    headers: POWERUPS5,
  });
  for (const opponent of opponents) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: opponent.token,
      headers: POWERUPS5,
    });
  }
  const startRes = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: creator.token,
    headers: POWERUPS5,
  });
  assert.equal(startRes.status, 200);
  return raceId;
}

async function createTeamRace(users) {
  const [creator, ...opponents] = users;
  for (const opponent of opponents) await makeFriends(creator, opponent, TEAM_POWERUPS5);
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Decoy Teams",
      maxDurationDays: 7,
      isPublic: true,
      isTeamRace: true,
      teamSize: 2,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: creator.token,
    headers: TEAM_POWERUPS5,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: opponents.map((user) => user.userId) },
    token: creator.token,
    headers: TEAM_POWERUPS5,
  });
  const teams = ["TEAM_A", "TEAM_B", "TEAM_B"];
  for (const [index, opponent] of opponents.entries()) {
    const response = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true, team: teams[index] },
      token: opponent.token,
      headers: TEAM_POWERUPS5,
    });
    assert.equal(response.status, 200);
  }
  const startRes = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: creator.token,
    headers: TEAM_POWERUPS5,
  });
  assert.equal(startRes.status, 200);
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function giveActiveEffect(raceId, userId, type, powerupId, expiresAt) {
  const p = await participant(raceId, userId);
  return prisma.raceActiveEffect.create({
    data: {
      raceId,
      targetParticipantId: p.id,
      targetUserId: userId,
      sourceUserId: userId,
      powerupId,
      type,
      status: "ACTIVE",
      startsAt: new Date(),
      expiresAt,
    },
  });
}

async function usePowerup(user, raceId, powerupId, body = {}, headers = POWERUPS5) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body,
    token: user.token,
    headers,
  });
}

async function activeEffects(raceId, type) {
  return prisma.raceActiveEffect.findMany({
    where: { raceId, type, status: "ACTIVE" },
    orderBy: [{ targetUserId: "asc" }, { id: "asc" }],
  });
}

describe("Decoy redirection and concurrency — integration", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("rejects a second active Decoy with DECOY_ACTIVE and retains the held item", async () => {
    const alice = await createUser("DecoyOwner");
    const bob = await createUser("DecoyOpponent");
    const raceId = await createSoloRace([alice, bob]);
    const first = await giveHeldPowerup(raceId, alice.userId, "DECOY", 1000);
    const second = await giveHeldPowerup(raceId, alice.userId, "DECOY", 2000);

    assert.equal((await usePowerup(alice, raceId, first.id)).status, 200);
    const rejected = await usePowerup(alice, raceId, second.id);
    assert.equal(rejected.status, 409);
    assert.deepEqual(await rejected.json(), {
      error: "You already have an active Decoy in this race",
      code: "DECOY_ACTIVE",
    });

    const held = await prisma.racePowerup.findUnique({ where: { id: second.id } });
    assert.equal(held.status, "HELD");
    assert.equal(
      (await prisma.raceActiveEffect.count({
        where: { raceId, targetUserId: alice.userId, type: "DECOY", status: "ACTIVE" },
      })),
      1,
    );
  });

  it("treats an expired ACTIVE Decoy as inactive and permits re-arming", async () => {
    const alice = await createUser("ExpiredDecoyOwner");
    const bob = await createUser("ExpiredDecoyOpponent");
    const raceId = await createSoloRace([alice, bob]);
    const expiredPowerup = await giveHeldPowerup(raceId, alice.userId, "DECOY", 1000);
    await giveActiveEffect(
      raceId,
      alice.userId,
      "DECOY",
      expiredPowerup.id,
      new Date(Date.now() - 1000),
    );
    const fresh = await giveHeldPowerup(raceId, alice.userId, "DECOY", 2000);

    const response = await usePowerup(alice, raceId, fresh.id);
    assert.equal(response.status, 200);
    const live = await prisma.raceActiveEffect.findMany({
      where: { raceId, targetUserId: alice.userId, type: "DECOY", status: "ACTIVE" },
    });
    assert.equal(live.length, 2, "historical expired row is preserved and fresh row is active");
    assert.equal(live.filter((row) => row.expiresAt > new Date()).length, 1);
  });

  it("serializes concurrent Decoy activation so exactly one row is active", async () => {
    const alice = await createUser("ConcurrentDecoyOwner");
    const bob = await createUser("ConcurrentDecoyOpponent");
    const raceId = await createSoloRace([alice, bob]);
    const first = await giveHeldPowerup(raceId, alice.userId, "DECOY", 1000);
    const second = await giveHeldPowerup(raceId, alice.userId, "DECOY", 2000);

    const responses = await Promise.all([
      usePowerup(alice, raceId, first.id),
      usePowerup(alice, raceId, second.id),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const active = await prisma.raceActiveEffect.findMany({
      where: { raceId, targetUserId: alice.userId, type: "DECOY", status: "ACTIVE" },
    });
    assert.equal(active.length, 1);
    const held = await prisma.racePowerup.count({
      where: { raceId, userId: alice.userId, type: "DECOY", status: "HELD" },
    });
    assert.equal(held, 1);
  });

  it("redirects Rainstorm per victim in a 3-runner solo race and applies once", async () => {
    const alice = await createUser("RainSoloCaster");
    const bob = await createUser("RainSoloDecoy");
    const carol = await createUser("RainSoloDestination");
    const raceId = await createSoloRace([alice, bob, carol]);
    const decoyPowerup = await giveHeldPowerup(raceId, bob.userId, "DECOY", 1000);
    await giveActiveEffect(raceId, bob.userId, "DECOY", decoyPowerup.id, new Date(Date.now() + 86400000));
    const storm = await giveHeldPowerup(raceId, alice.userId, "RAINSTORM", 2000);

    const response = await usePowerup(alice, raceId, storm.id);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.redirected, true);
    assert.deepEqual(body.result.redirectedToUserIds, [carol.userId]);
    assert.equal(body.result.redirectedToUserId, carol.userId);
    assert.equal(body.result.decoyBlockedCount, 0);
    const effects = await activeEffects(raceId, "RAINSTORM");
    assert.deepEqual(effects.map((effect) => effect.targetUserId), [carol.userId]);
    assert.equal(effects.filter((effect) => effect.targetUserId === bob.userId).length, 0);
  });

  it("makes a redirected Rainstorm landing onto an existing effect a durable no-op", async () => {
    const alice = await createUser("DuplicateTeamCaster");
    const bob = await createUser("DuplicateTeamExisting");
    const carol = await createUser("DuplicateTeamDecoy");
    const dave = await createUser("DuplicateTeamVictim");
    const raceId = await createTeamRace([alice, bob, carol, dave]);
    const decoyPowerup = await giveHeldPowerup(raceId, carol.userId, "DECOY", 1000);
    await giveActiveEffect(raceId, carol.userId, "DECOY", decoyPowerup.id, new Date(Date.now() + 86400000));
    const existingPowerup = await giveHeldPowerup(raceId, bob.userId, "RAINSTORM", 1100);
    const original = await giveActiveEffect(raceId, bob.userId, "RAINSTORM", existingPowerup.id, new Date(Date.now() + 3600000));
    const snapshot = {
      id: original.id, type: original.type, targetParticipantId: original.targetParticipantId,
      targetUserId: original.targetUserId, sourceUserId: original.sourceUserId,
      powerupId: original.powerupId, startsAt: original.startsAt, expiresAt: original.expiresAt,
      status: original.status, metadata: original.metadata,
    };
    const storm = await giveHeldPowerup(raceId, alice.userId, "RAINSTORM", 2000);
    const response = await usePowerup(alice, raceId, storm.id, {}, TEAM_POWERUPS5);
    assert.equal(response.status, 200);
    const effects = await activeEffects(raceId, "RAINSTORM");
    assert.equal(effects.filter((effect) => effect.targetUserId === bob.userId).length, 1);
    const after = await prisma.raceActiveEffect.findUnique({ where: { id: original.id } });
    assert.deepEqual({
      id: after.id, type: after.type, targetParticipantId: after.targetParticipantId,
      targetUserId: after.targetUserId, sourceUserId: after.sourceUserId,
      powerupId: after.powerupId, startsAt: after.startsAt, expiresAt: after.expiresAt,
      status: after.status, metadata: after.metadata,
    }, snapshot);
    assert.ok(effects.some((effect) => effect.targetUserId === dave.userId));
  });

  it("combines redirected-duplicate no-op with race-scoped Rainstorm cooldown", async () => {
    await prisma.powerupShopItem.upsert({
      where: { sku: "POWERUP_RAINSTORM" },
      update: { active: true },
      create: { sku: "POWERUP_RAINSTORM", name: "Rainstorm", priceCoins: 75, powerupType: "RAINSTORM", active: true },
    });
    const alice = await createUser("CombinedCaster");
    const bob = await createUser("CombinedExisting");
    const carol = await createUser("CombinedDecoy");
    const dave = await createUser("CombinedVictim");
    const raceA = await createTeamRace([alice, bob, carol, dave]);
    const decoy = await giveHeldPowerup(raceA, carol.userId, "DECOY", 1000);
    await giveActiveEffect(raceA, carol.userId, "DECOY", decoy.id, new Date(Date.now() + 86400000));
    const existingPowerup = await giveHeldPowerup(raceA, bob.userId, "RAINSTORM", 1100);
    const original = await giveActiveEffect(raceA, bob.userId, "RAINSTORM", existingPowerup.id, new Date(Date.now() + 3600000));
    const stormA = await giveHeldPowerup(raceA, alice.userId, "RAINSTORM", 1200);
    const retryItem = await giveHeldPowerup(raceA, alice.userId, "RAINSTORM", 1300);
    assert.equal((await usePowerup(alice, raceA, stormA.id, {}, TEAM_POWERUPS5)).status, 200);
    assert.equal(await prisma.raceActiveEffect.count({ where: { raceId: raceA, targetUserId: bob.userId, type: "RAINSTORM", status: "ACTIVE" } }), 1);
    assert.ok(await prisma.powerupUsageState.findUnique({ where: { raceId_userId_powerupType: { raceId: raceA, userId: alice.userId, powerupType: "RAINSTORM" } } }));
    const retry = await usePowerup(alice, raceA, retryItem.id, {}, TEAM_POWERUPS5);
    const retryBody = await retry.json();
    assert.ok([400, 409].includes(retry.status), JSON.stringify(retryBody));
    if (retry.status === 409) assert.equal(retryBody.code, "POWERUP_COOLDOWN");

    const raceB = await createSoloRace([alice, await createUser("CombinedRaceBVictim")]);
    const stormB = await giveHeldPowerup(raceB, alice.userId, "RAINSTORM", 1400);
    assert.equal((await usePowerup(alice, raceB, stormB.id)).status, 200);
    const unchanged = await prisma.raceActiveEffect.findUnique({ where: { id: original.id } });
    assert.equal(unchanged.id, original.id);
    assert.equal(unchanged.startsAt.getTime(), original.startsAt.getTime());
    assert.equal(unchanged.expiresAt.getTime(), original.expiresAt.getTime());
  });

  it("redirects Power Outage per victim in a 3-runner solo race", async () => {
    const alice = await createUser("OutageSoloCaster");
    const bob = await createUser("OutageSoloDecoy");
    const carol = await createUser("OutageSoloDestination");
    const raceId = await createSoloRace([alice, bob, carol]);
    const decoyPowerup = await giveHeldPowerup(raceId, bob.userId, "DECOY", 1000);
    await giveActiveEffect(raceId, bob.userId, "DECOY", decoyPowerup.id, new Date(Date.now() + 86400000));
    const outage = await giveHeldPowerup(raceId, alice.userId, "POWER_OUTAGE", 2000);

    const response = await usePowerup(alice, raceId, outage.id);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.result.redirectedToUserIds, [carol.userId]);
    assert.equal(body.result.redirectedToUserId, carol.userId);
    assert.equal(body.result.decoyBlockedCount, 0);
    const effects = await activeEffects(raceId, "POWER_OUTAGE");
    assert.deepEqual(effects.map((effect) => effect.targetUserId), [carol.userId]);
  });

  it("skips an already-outaged redirected recipient while preserving other AoE landings", async () => {
    const alice = await createUser("DuplicateOutageCaster");
    const bob = await createUser("DuplicateOutageDecoy");
    const carol = await createUser("DuplicateOutageTarget");
    const dave = await createUser("DuplicateOutageOther");
    const raceId = await createSoloRace([alice, bob, carol, dave]);
    const decoyPowerup = await giveHeldPowerup(raceId, bob.userId, "DECOY", 1000);
    await giveActiveEffect(raceId, bob.userId, "DECOY", decoyPowerup.id, new Date(Date.now() + 86400000));
    const existingPowerup = await giveHeldPowerup(raceId, bob.userId, "POWER_OUTAGE", 1100);
    const original = await giveActiveEffect(raceId, carol.userId, "POWER_OUTAGE", existingPowerup.id, new Date(Date.now() + 1800000), bob.userId);
    const snapshot = { startsAt: original.startsAt, expiresAt: original.expiresAt, sourceUserId: original.sourceUserId, powerupId: original.powerupId, metadata: original.metadata };
    const outage = await giveHeldPowerup(raceId, alice.userId, "POWER_OUTAGE", 2000);
    assert.equal((await usePowerup(alice, raceId, outage.id)).status, 200);
    const after = await prisma.raceActiveEffect.findUnique({ where: { id: original.id } });
    assert.deepEqual({ startsAt: after.startsAt, expiresAt: after.expiresAt, sourceUserId: after.sourceUserId, powerupId: after.powerupId, metadata: after.metadata }, snapshot);
    assert.equal((await activeEffects(raceId, "POWER_OUTAGE")).filter((effect) => effect.targetUserId === carol.userId).length, 1);
    assert.ok((await activeEffects(raceId, "POWER_OUTAGE")).some((effect) => effect.targetUserId === dave.userId));
  });

  it("consumes a Decoy as a block for Rainstorm and Power Outage when head-to-head has no destination", async () => {
    const alice = await createUser("TwoWayCaster");
    const bob = await createUser("TwoWayDecoy");
    const raceId = await createSoloRace([alice, bob]);
    const decoyPowerup = await giveHeldPowerup(raceId, bob.userId, "DECOY", 1000);
    await giveActiveEffect(raceId, bob.userId, "DECOY", decoyPowerup.id, new Date(Date.now() + 86400000));
    const storm = await giveHeldPowerup(raceId, alice.userId, "RAINSTORM", 2000);

    const response = await usePowerup(alice, raceId, storm.id);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.affected, 0);
    assert.equal(body.result.decoyBlockedCount, 1);
    assert.equal(body.result.redirected, undefined);
    assert.equal((await activeEffects(raceId, "RAINSTORM")).length, 0);
    const decoy = await prisma.raceActiveEffect.findFirst({
      where: { raceId, targetUserId: bob.userId, type: "DECOY" },
    });
    assert.equal(decoy.status, "EXPIRED");

    const secondDecoyPowerup = await giveHeldPowerup(raceId, bob.userId, "DECOY", 3000);
    await giveActiveEffect(
      raceId,
      bob.userId,
      "DECOY",
      secondDecoyPowerup.id,
      new Date(Date.now() + 86400000),
    );
    const outage = await giveHeldPowerup(raceId, alice.userId, "POWER_OUTAGE", 4000);
    const outageResponse = await usePowerup(alice, raceId, outage.id);
    assert.equal(outageResponse.status, 200);
    const outageBody = await outageResponse.json();
    assert.equal(outageBody.result.affected, 0);
    assert.equal(outageBody.result.decoyBlockedCount, 1);
    assert.equal((await activeEffects(raceId, "POWER_OUTAGE")).length, 0);
  });

  it("uses existing team eligibility, supports duplicate destinations, and does not chain Decoys", async () => {
    const alice = await createUser("TeamCaster", TEAM_POWERUPS5);
    const erin = await createUser("TeamTeammate", TEAM_POWERUPS5);
    const bob = await createUser("TeamDecoyOne", TEAM_POWERUPS5);
    const carol = await createUser("TeamDecoyTwo", TEAM_POWERUPS5);
    const raceId = await createTeamRace([alice, erin, bob, carol]);
    const bobDecoy = await giveHeldPowerup(raceId, bob.userId, "DECOY", 1000);
    const carolDecoy = await giveHeldPowerup(raceId, carol.userId, "DECOY", 2000);
    const teammateDecoy = await giveHeldPowerup(raceId, erin.userId, "DECOY", 2500);
    const bobDecoyEffect = await giveActiveEffect(raceId, bob.userId, "DECOY", bobDecoy.id, new Date(Date.now() + 86400000));
    const carolDecoyEffect = await giveActiveEffect(raceId, carol.userId, "DECOY", carolDecoy.id, new Date(Date.now() + 86400000));
    const teammateDecoyEffect = await giveActiveEffect(
      raceId,
      erin.userId,
      "DECOY",
      teammateDecoy.id,
      new Date(Date.now() + 86400000),
    );
    const storm = await giveHeldPowerup(raceId, alice.userId, "RAINSTORM", 3000);

    const response = await usePowerup(alice, raceId, storm.id, {}, TEAM_POWERUPS5);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.result.redirectedToUserIds, [erin.userId]);
    assert.equal(body.result.redirectedToUserId, erin.userId);
    assert.equal(body.result.decoyBlockedCount, 0);
    assert.equal(body.result.affected, 1, "duplicate destination receives one effect");
    const effects = await activeEffects(raceId, "RAINSTORM");
    assert.deepEqual(effects.map((effect) => effect.targetUserId), [erin.userId]);
    assert.equal(
      (await prisma.raceActiveEffect.count({
        where: { raceId, type: "RAINSTORM", targetUserId: alice.userId },
      })),
      0,
      "caster teammate is not an AoE victim before redirection",
    );
    assert.equal(
      (await prisma.raceActiveEffect.count({
        where: { raceId, type: "DECOY", status: "ACTIVE" },
      })),
      1,
      "victim Decoys are consumed exactly once and destination Decoy is not chained",
    );
    assert.equal(
      (await prisma.raceActiveEffect.findUnique({ where: { id: teammateDecoyEffect.id } })).status,
      "ACTIVE",
    );
    const stormConsumptionEvents = await prisma.domainEventOutbox.findMany({
      where: {
        eventKey: {
          in: [
            `DECOY_CONSUMED_V1:${bobDecoyEffect.id}`,
            `DECOY_CONSUMED_V1:${carolDecoyEffect.id}`,
          ],
        },
      },
      orderBy: { eventKey: "asc" },
    });
    assert.equal(stormConsumptionEvents.length, 2);
    assert.deepEqual(
      stormConsumptionEvents.map((event) => event.payload.attackPowerupType),
      ["RAINSTORM", "RAINSTORM"],
    );

    const bobOutageDecoy = await giveHeldPowerup(raceId, bob.userId, "DECOY", 4000);
    const carolOutageDecoy = await giveHeldPowerup(raceId, carol.userId, "DECOY", 5000);
    await giveActiveEffect(raceId, bob.userId, "DECOY", bobOutageDecoy.id, new Date(Date.now() + 86400000));
    await giveActiveEffect(raceId, carol.userId, "DECOY", carolOutageDecoy.id, new Date(Date.now() + 86400000));
    const outage = await giveHeldPowerup(raceId, alice.userId, "POWER_OUTAGE", 6000);
    const outageResponse = await usePowerup(alice, raceId, outage.id, {}, TEAM_POWERUPS5);
    assert.equal(outageResponse.status, 200);
    const outageBody = await outageResponse.json();
    assert.deepEqual(outageBody.result.redirectedToUserIds, [erin.userId]);
    assert.equal(outageBody.result.affected, 1);
    assert.deepEqual(
      (await activeEffects(raceId, "POWER_OUTAGE")).map((effect) => effect.targetUserId),
      [erin.userId],
    );
  });

  it("runs destination Umbrella and Socks defenses after an AoE Decoy redirect", async () => {
    const alice = await createUser("DefenseCaster");
    const bob = await createUser("DefenseDecoy");
    const carol = await createUser("DefenseDestination");
    const raceId = await createSoloRace([alice, bob, carol]);
    const decoyPowerup = await giveHeldPowerup(raceId, bob.userId, "DECOY", 1000);
    const umbrellaPowerup = await giveHeldPowerup(raceId, carol.userId, "UMBRELLA", 2000);
    await giveActiveEffect(raceId, bob.userId, "DECOY", decoyPowerup.id, new Date(Date.now() + 86400000));
    const umbrella = await giveActiveEffect(
      raceId,
      carol.userId,
      "UMBRELLA",
      umbrellaPowerup.id,
      new Date(Date.now() + 86400000),
    );
    const storm = await giveHeldPowerup(raceId, alice.userId, "RAINSTORM", 3000);

    const response = await usePowerup(alice, raceId, storm.id);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.result.redirectedToUserIds, [carol.userId]);
    assert.equal(body.result.affected, 0);
    assert.equal(body.result.blockedCount, 0);
    assert.equal((await activeEffects(raceId, "RAINSTORM")).length, 0);
    assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: umbrella.id } })).status, "ACTIVE");

    const alice2 = await createUser("SocksDefenseCaster");
    const bob2 = await createUser("SocksDefenseDecoy");
    const carol2 = await createUser("SocksDefenseDestination");
    const raceId2 = await createSoloRace([alice2, bob2, carol2]);
    const decoy2 = await giveHeldPowerup(raceId2, bob2.userId, "DECOY", 4000);
    const socksPowerup = await giveHeldPowerup(raceId2, carol2.userId, "COMPRESSION_SOCKS", 5000);
    await giveActiveEffect(raceId2, bob2.userId, "DECOY", decoy2.id, new Date(Date.now() + 86400000));
    const socks = await giveActiveEffect(
      raceId2,
      carol2.userId,
      "COMPRESSION_SOCKS",
      socksPowerup.id,
      new Date(Date.now() + 86400000),
    );
    const outage = await giveHeldPowerup(raceId2, alice2.userId, "POWER_OUTAGE", 6000);
    const outageResponse = await usePowerup(alice2, raceId2, outage.id);
    assert.equal(outageResponse.status, 200);
    const outageBody = await outageResponse.json();
    assert.deepEqual(outageBody.result.redirectedToUserIds, [carol2.userId]);
    assert.equal(outageBody.result.affected, 0);
    assert.equal(outageBody.result.blockedCount, 1);
    assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: socks.id } })).status, "BLOCKED");
    assert.equal((await activeEffects(raceId2, "POWER_OUTAGE")).length, 0);
  });

  it("does not let an expired destination Socks row block a redirected Power Outage", async () => {
    const alice = await createUser("ExpiredSocksCaster");
    const bob = await createUser("ExpiredSocksDecoy");
    const carol = await createUser("ExpiredSocksDestination");
    const raceId = await createSoloRace([alice, bob, carol]);
    const decoy = await giveHeldPowerup(raceId, bob.userId, "DECOY", 1000);
    const socksPowerup = await giveHeldPowerup(raceId, carol.userId, "COMPRESSION_SOCKS", 2000);
    await giveActiveEffect(raceId, bob.userId, "DECOY", decoy.id, new Date(Date.now() + 86400000));
    await giveActiveEffect(
      raceId,
      carol.userId,
      "COMPRESSION_SOCKS",
      socksPowerup.id,
      new Date(Date.now() - 1000),
    );
    const outage = await giveHeldPowerup(raceId, alice.userId, "POWER_OUTAGE", 3000);

    const response = await usePowerup(alice, raceId, outage.id);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.affected, 1);
    assert.equal(body.result.blockedCount, 0);
    assert.equal((await activeEffects(raceId, "POWER_OUTAGE")).length, 1);
  });
});

})();

// ---- consolidated from powerups-reflected-attack-socks.test.js ----
(function powerups_reflected_attack_socks_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  startServer,
} = require("../setup");
const {
  buildUsePowerup,
} = require("../../../src/modules/powerups/commands/usePowerup");
const {
  RaceImpactEvent,
} = require("../../../src/modules/races/models/raceImpactEvent");

// ---------------------------------------------------------------------------
// REFLECTED ATTACK vs THE ATTACKER'S OWN COMPRESSION SOCKS
//
// Design rule under test: when an offensive powerup is reflected by the
// target's Mirror, the reflected hit lands on the original attacker — and the
// attacker's own active Compression Socks now BLOCK that bounce. Both shields
// are consumed (Mirror EXPIRED on the defender, socks BLOCKED on the
// attacker), the effect never applies to anyone, and the response carries the
// combined discriminator: outcome "BLOCKED" + blockedBy "COMPRESSION_SOCKS"
// + reflected true + reflectedBy "MIRROR". Covers the primary Mirror branch,
// the Decoy-redirect-then-Mirror branch, and the Mystery Potion enemy-attack
// path.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-refsocks-${++nextAppleId}`;
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

async function createActiveRace(creator, others) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Reflected Socks Test",
      targetSteps: 200000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: creator.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((o) => o.userId) },
    token: creator.token,
  });
  for (const o of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: creator.token });
  const defaultStart = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: defaultStart } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: defaultStart } });
  return raceId;
}

async function getParticipant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await getParticipant(raceId, userId);
  const rareTypes = ["COMPRESSION_SOCKS", "MIRROR"];
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: rareTypes.includes(type) ? "RARE" : "COMMON",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function giveBonusSteps(raceId, userId, amount) {
  const participant = await getParticipant(raceId, userId);
  await prisma.raceParticipant.update({
    where: { id: participant.id },
    data: { bonusSteps: { increment: amount }, totalSteps: amount },
  });
}

// Wave-gated types (DECOY, MYSTERY_POTION) 400 without the client-features header.
const FEATURES = { "X-Client-Features": "characters,powerups3,powerups4,powerups5" };

async function usePowerup(token, raceId, powerupId, targetUserId) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body: targetUserId ? { targetUserId } : {},
    token,
    headers: FEATURES,
  });
}

// Activate a held self-shield (socks/mirror/decoy) and assert it stuck.
async function activateShield(raceId, user, type, earnedAtSteps) {
  const held = await giveHeldPowerup(raceId, user.userId, type, earnedAtSteps);
  const res = await usePowerup(user.token, raceId, held.id);
  assert.equal(res.status, 200, `${type} should activate`);
}

async function shieldStatus(raceId, userId, type) {
  const effect = await prisma.raceActiveEffect.findFirst({
    where: { raceId, type, targetUserId: userId },
    orderBy: { startsAt: "desc" },
  });
  return effect ? effect.status : "(none)";
}

async function activeEffectCount(raceId, type) {
  return prisma.raceActiveEffect.count({ where: { raceId, type, status: "ACTIVE" } });
}

async function feedEventCount(raceId, eventType, powerupType) {
  return prisma.racePowerupEvent.count({ where: { raceId, eventType, powerupType } });
}

describe("reflected attack blocked by the attacker's own compression socks", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {});

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("WRONG_TURN reflected by the target's Mirror is blocked by the attacker's socks", async () => {
    const alice = await createUser("AliceAtk");
    const bob = await createUser("BobMirror");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);
    await giveBonusSteps(raceId, alice.userId, 5000);
    await giveBonusSteps(raceId, bob.userId, 5000);

    await activateShield(raceId, alice, "COMPRESSION_SOCKS", 99901);
    await activateShield(raceId, bob, "MIRROR", 99902);

    const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99903);
    const res = await usePowerup(alice.token, raceId, wt.id, bob.userId);
    assert.equal(res.status, 200);
    const { result } = await res.json();

    assert.equal(result.outcome, "BLOCKED");
    assert.equal(result.blocked, true);
    assert.equal(result.blockedBy, "COMPRESSION_SOCKS");
    assert.equal(result.reflected, true);
    assert.equal(result.reflectedBy, "MIRROR");

    assert.equal(await shieldStatus(raceId, bob.userId, "MIRROR"), "EXPIRED", "mirror consumed");
    assert.equal(await shieldStatus(raceId, alice.userId, "COMPRESSION_SOCKS"), "BLOCKED", "attacker socks consumed");
    assert.equal(await activeEffectCount(raceId, "WRONG_TURN"), 0, "wrong turn never lands on anyone");

    const powerup = await prisma.racePowerup.findUnique({ where: { id: wt.id } });
    assert.equal(powerup.status, "USED", "the wrong turn item is consumed");

    assert.equal(await feedEventCount(raceId, "POWERUP_REFLECTED", "WRONG_TURN"), 1);
    assert.equal(await feedEventCount(raceId, "POWERUP_BLOCKED", "WRONG_TURN"), 1);
  });

  it("reflected WRONG_TURN still lands when the attacker has NO socks (regression)", async () => {
    const alice = await createUser("AliceAtk");
    const bob = await createUser("BobMirror");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);
    await giveBonusSteps(raceId, alice.userId, 5000);
    await giveBonusSteps(raceId, bob.userId, 5000);

    await activateShield(raceId, bob, "MIRROR", 99902);

    const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99903);
    const res = await usePowerup(alice.token, raceId, wt.id, bob.userId);
    assert.equal(res.status, 200);
    const { result } = await res.json();

    assert.equal(result.outcome, "REFLECTED");
    assert.equal(result.reflectedBy, "MIRROR");
    assert.notEqual(result.blocked, true);
    assert.equal(await shieldStatus(raceId, bob.userId, "MIRROR"), "EXPIRED");
    assert.equal(await shieldStatus(raceId, alice.userId, "WRONG_TURN"), "ACTIVE", "bounced wrong turn lands on the attacker");
  });

  it("socks-holding attacker who ALREADY has a Wrong Turn gets blocked, not a 400", async () => {
    const alice = await createUser("AliceAtk");
    const bob = await createUser("BobMirror");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);
    await giveBonusSteps(raceId, alice.userId, 5000);
    await giveBonusSteps(raceId, bob.userId, 5000);

    await activateShield(raceId, alice, "COMPRESSION_SOCKS", 99901);
    await activateShield(raceId, bob, "MIRROR", 99902);

    // Seed an already-active Wrong Turn ON the attacker (sourced by Bob).
    const aliceP = await getParticipant(raceId, alice.userId);
    const seedItem = await giveHeldPowerup(raceId, bob.userId, "WRONG_TURN", 99904);
    await prisma.racePowerup.update({ where: { id: seedItem.id }, data: { status: "USED", usedAt: new Date() } });
    await prisma.raceActiveEffect.create({
      data: {
        raceId,
        targetParticipantId: aliceP.id,
        targetUserId: alice.userId,
        sourceUserId: bob.userId,
        powerupId: seedItem.id,
        type: "WRONG_TURN",
        status: "ACTIVE",
        startsAt: new Date(Date.now() - 10 * 60 * 1000),
        expiresAt: new Date(Date.now() + 50 * 60 * 1000),
      },
    });

    const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99903);
    const res = await usePowerup(alice.token, raceId, wt.id, bob.userId);
    assert.equal(res.status, 200, "socks precedence: no stacking 400 when the bounce is blocked anyway");
    const { result } = await res.json();
    assert.equal(result.outcome, "BLOCKED");
    assert.equal(result.blockedBy, "COMPRESSION_SOCKS");
    assert.equal(result.reflected, true);
    assert.equal(await shieldStatus(raceId, alice.userId, "COMPRESSION_SOCKS"), "BLOCKED");
    assert.equal(await shieldStatus(raceId, bob.userId, "MIRROR"), "EXPIRED");
    // Only the pre-seeded wrong turn remains active on Alice — no second stack.
    assert.equal(await activeEffectCount(raceId, "WRONG_TURN"), 1);
  });

  it("Decoy redirect → new victim's Mirror reflect → attacker socks block", async () => {
    const alice = await createUser("AliceAtk"); // attacker, socks
    const bob = await createUser("BobDecoy"); // decoy holder
    const carol = await createUser("CarolMirr"); // mirror holder (redirect victim)
    await makeFriends(alice, bob);
    await makeFriends(alice, carol);
    await makeFriends(bob, carol);
    const raceId = await createActiveRace(alice, [bob, carol]);
    for (const u of [alice, bob, carol]) await giveBonusSteps(raceId, u.userId, 5000);

    await activateShield(raceId, alice, "COMPRESSION_SOCKS", 99901);
    await activateShield(raceId, carol, "MIRROR", 99902);
    // Decoy is a shop powerup; grant it held and activate.
    await activateShield(raceId, bob, "DECOY", 99905);

    const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99903);
    const res = await usePowerup(alice.token, raceId, wt.id, bob.userId);
    assert.equal(res.status, 200);
    const { result } = await res.json();

    assert.equal(result.outcome, "BLOCKED");
    assert.equal(result.blockedBy, "COMPRESSION_SOCKS");
    assert.equal(result.reflected, true);
    assert.equal(result.reflectedBy, "MIRROR");

    assert.equal(await shieldStatus(raceId, bob.userId, "DECOY"), "EXPIRED", "decoy consumed");
    assert.equal(await shieldStatus(raceId, carol.userId, "MIRROR"), "EXPIRED", "mirror consumed");
    assert.equal(await shieldStatus(raceId, alice.userId, "COMPRESSION_SOCKS"), "BLOCKED", "attacker socks consumed");
    assert.equal(await activeEffectCount(raceId, "WRONG_TURN"), 0);
  });

  it("Leg Cramp consumes Mirror before Decoy before Compression Socks when defenses coexist", async () => {
    const alice = await createUser("AliceOrder");
    const bob = await createUser("BobOrder");
    const carol = await createUser("CarolOrder");
    await makeFriends(alice, bob);
    await makeFriends(alice, carol);
    const raceId = await createActiveRace(alice, [bob, carol]);
    for (const user of [alice, bob, carol]) {
      await giveBonusSteps(raceId, user.userId, 5000);
    }
    await activateShield(raceId, bob, "COMPRESSION_SOCKS", 99801);
    await activateShield(raceId, bob, "DECOY", 99802);
    await activateShield(raceId, bob, "MIRROR", 99803);

    const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99804);
    const response = await usePowerup(alice.token, raceId, cramp.id, bob.userId);
    assert.equal(response.status, 200);
    const { result } = await response.json();
    assert.equal(result.outcome, "REFLECTED");
    assert.equal(result.reflectedBy, "MIRROR");
    assert.equal(await shieldStatus(raceId, bob.userId, "MIRROR"), "EXPIRED");
    assert.equal(await shieldStatus(raceId, bob.userId, "DECOY"), "ACTIVE");
    assert.equal(await shieldStatus(raceId, bob.userId, "COMPRESSION_SOCKS"), "ACTIVE");
    assert.equal(await shieldStatus(raceId, alice.userId, "LEG_CRAMP"), "ACTIVE");
  });

  it("Mystery Potion enemy attack reflected by the victim's Mirror is blocked by the caster's socks", async () => {
    const alice = await createUser("AlicePot");
    const bob = await createUser("BobMirror");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);
    await giveBonusSteps(raceId, alice.userId, 5000);
    await giveBonusSteps(raceId, bob.userId, 5000);

    await activateShield(raceId, alice, "COMPRESSION_SOCKS", 99901);
    await activateShield(raceId, bob, "MIRROR", 99902);

    // The potion roll is random; enemy-attack outcomes (PINECONE_TOSS /
    // SHORTCUT / LEG_CRAMP) have substantial weight, so casting repeatedly
    // reaches one with overwhelming probability. Non-attack rolls only buff
    // the caster and never touch either shield, so the first enemy roll is
    // the one that exercises the Mirror.
    const enemyOutcomes = new Set(["PINECONE_TOSS", "SHORTCUT", "LEG_CRAMP"]);
    let attackResult = null;
    for (let i = 0; i < 40 && !attackResult; i++) {
      const potion = await giveHeldPowerup(raceId, alice.userId, "MYSTERY_POTION", 90000 + i);
      const res = await usePowerup(alice.token, raceId, potion.id);
      assert.equal(res.status, 200, `potion cast ${i} should succeed`);
      const { result } = await res.json();
      if (enemyOutcomes.has(result.rolled)) attackResult = result;
    }
    assert.ok(attackResult, "expected at least one enemy-attack potion roll in 40 casts");

    assert.equal(attackResult.reflected, true, "mirror fires on the enemy roll");
    assert.equal(attackResult.reflectedBy, "MIRROR");
    assert.equal(attackResult.blocked, true, "caster's own socks block the bounce");
    assert.equal(attackResult.blockedBy, "COMPRESSION_SOCKS");
    assert.equal(attackResult.outcome, "BLOCKED");

    assert.equal(await shieldStatus(raceId, bob.userId, "MIRROR"), "EXPIRED");
    assert.equal(await shieldStatus(raceId, alice.userId, "COMPRESSION_SOCKS"), "BLOCKED");
  });

  it("a reflected Mystery Potion Shortcut conserves steps and credits the Mirror holder", async () => {
    const alice = await createUser("AlicePotionShortcut");
    const bob = await createUser("BobPotionMirror");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);
    await giveBonusSteps(raceId, alice.userId, 400);
    await giveBonusSteps(raceId, bob.userId, 5000);
    await activateShield(raceId, bob, "MIRROR", 99701);

    const potion = await giveHeldPowerup(
      raceId,
      alice.userId,
      "MYSTERY_POTION",
      99702,
    );
    // 0.72 deterministically selects SHORTCUT from the canonical potion pool.
    // Use a real HTTP server/handler chain while injecting only the random seam.
    const deterministicServer = await startServer({
      usePowerup: buildUsePowerup({
        random: () => 0.72,
        ActiveRaceImpact: RaceImpactEvent,
      }),
    });
    try {
      const before = await prisma.raceParticipant.findMany({
        where: { raceId, userId: { in: [alice.userId, bob.userId] } },
        orderBy: { userId: "asc" },
      });
      const beforeSum = before.reduce((sum, participant) => sum + participant.totalSteps, 0);

      const response = await request(
        deterministicServer.baseUrl,
        "POST",
        `/races/${raceId}/powerups/${potion.id}/use`,
        { token: alice.token, headers: FEATURES, body: {} },
      );
      assert.equal(response.status, 200);
      const { result } = await response.json();
      assert.equal(result.rolled, "SHORTCUT");
      assert.equal(result.reflected, true);
      assert.equal(result.reflectedBy, "MIRROR");
      assert.equal(result.stolen, 400, "the returned amount is the actual clamped debit");

      const after = await prisma.raceParticipant.findMany({
        where: { raceId, userId: { in: [alice.userId, bob.userId] } },
        orderBy: { userId: "asc" },
      });
      const byUser = new Map(after.map((participant) => [participant.userId, participant]));
      assert.equal(byUser.get(alice.userId).totalSteps, 0);
      assert.equal(byUser.get(bob.userId).totalSteps, 5400);
      assert.equal(
        after.reduce((sum, participant) => sum + participant.totalSteps, 0),
        beforeSum,
        "a reflected Shortcut transfers rather than mints or destroys steps",
      );

      const impacts = await prisma.raceImpactEvent.findMany({
        where: { raceId, powerupType: "SHORTCUT" },
        orderBy: { deltaSteps: "asc" },
      });
      assert.deepEqual(
        impacts.map((impact) => [impact.recipientUserId, impact.deltaSteps]),
        [[alice.userId, -400], [bob.userId, 400]],
      );
      const sourceEvent = await prisma.racePowerupEvent.findFirstOrThrow({
        where: { raceId, powerupType: "MYSTERY_POTION", eventType: "POWERUP_USED" },
        orderBy: { createdAt: "desc" },
      });
      assert.equal(sourceEvent.actorUserId, bob.userId);
      assert.equal(sourceEvent.targetUserId, alice.userId);
      assert.deepEqual(sourceEvent.metadata, { rolled: "SHORTCUT", stolen: 400 });
    } finally {
      await deterministicServer.close();
    }
  });
});

})();
