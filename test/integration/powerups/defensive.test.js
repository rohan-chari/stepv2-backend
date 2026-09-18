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
