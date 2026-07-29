const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

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
});
