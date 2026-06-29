const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

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
    // Penalty is 10% of the (post-reflect) target = the attacker's own 5000 steps.
    assert.equal(summary.result.penalty, 500);
    assert.equal(summary.attackerSteps_after, 4500, "attacker eats the 500-step Red Card penalty");
    assert.equal(summary.defenderSteps_after, 8000, "mirror holder is untouched");
    // Mirror is spent; the socks shield is untouched and banked for next time.
    assert.equal(summary.mirror_status_after, "EXPIRED", "mirror is consumed on reflect");
    assert.equal(summary.socks_status_after, "ACTIVE", "socks survives — banked for a later attack");
  });
});
