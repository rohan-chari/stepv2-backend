const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// ---------------------------------------------------------------------------
// Leg Cramp × Wrong Turn mutual exclusion (owner decision 2026-07-29).
//
// A target can never carry BOTH a freeze and a reversal:
//   * DIRECT uses of either type on a target with the other active are
//     rejected with a 400 validation error (item stays HELD, nothing consumed,
//     the existing effect untouched). This REPLACES the old shipped behavior
//     where a direct Wrong Turn silently cancelled the target's Leg Cramp.
//   * INDIRECT landings (Mirror reflect / Decoy redirect) keep cancel
//     semantics — the conflicting effect on the landing target is
//     truncated-expired — so a hidden conflict never wastes the shield or
//     violates the invariant.
//
// End-to-end through the real /use endpoint; the error message must be
// user-facing because frozen clients render it verbatim (powerupUseErrorCopy
// falls through to the server message for unknown codes).
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-conflict-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
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
      name: "Cramp WT Conflict Test",
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
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: creator.token,
  });
  const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start } });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: start },
  });
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity: type === "MIRROR" ? "RARE" : "UNCOMMON",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function usePowerup(token, raceId, powerupId, targetUserId) {
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/use`,
    { body: targetUserId ? { targetUserId } : {}, token }
  );
}

async function activeEffects(raceId, targetUserId, type) {
  return prisma.raceActiveEffect.findMany({
    where: { raceId, targetUserId, type, status: "ACTIVE" },
  });
}

describe("Leg Cramp × Wrong Turn mutual exclusion", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("direct Wrong Turn on a cramped target is rejected; the cramp keeps running", async () => {
    const alice = await createUser("AliceConfA");
    const bob = await createUser("BobConfA");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 5001);
    assert.equal((await usePowerup(alice.token, raceId, cramp.id, bob.userId)).status, 200);
    const [crampEffect] = await activeEffects(raceId, bob.userId, "LEG_CRAMP");
    assert.ok(crampEffect);

    const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 5002);
    const res = await usePowerup(alice.token, raceId, wt.id, bob.userId);
    assert.equal(res.status, 400);
    const body = await res.json();
    // Frozen clients render this message verbatim — it must be user-facing.
    assert.match(body.error, /Leg Cramp/);
    assert.equal(body.code, "TARGET_EFFECT_CONFLICT");

    // The cramp is untouched: still ACTIVE, window not truncated.
    const after = await prisma.raceActiveEffect.findUnique({ where: { id: crampEffect.id } });
    assert.equal(after.status, "ACTIVE");
    assert.equal(after.expiresAt.getTime(), crampEffect.expiresAt.getTime());

    // No Wrong Turn effect was created and the item stays HELD.
    assert.equal((await activeEffects(raceId, bob.userId, "WRONG_TURN")).length, 0);
    const item = await prisma.racePowerup.findUnique({ where: { id: wt.id } });
    assert.equal(item.status, "HELD");
  });

  it("direct Leg Cramp on a wrong-turned target is rejected; the reversal keeps running", async () => {
    const alice = await createUser("AliceConfB");
    const bob = await createUser("BobConfB");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 5001);
    assert.equal((await usePowerup(alice.token, raceId, wt.id, bob.userId)).status, 200);
    const [wtEffect] = await activeEffects(raceId, bob.userId, "WRONG_TURN");
    assert.ok(wtEffect);

    const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 5002);
    const res = await usePowerup(alice.token, raceId, cramp.id, bob.userId);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Wrong Turn/);
    assert.equal(body.code, "TARGET_EFFECT_CONFLICT");

    const after = await prisma.raceActiveEffect.findUnique({ where: { id: wtEffect.id } });
    assert.equal(after.status, "ACTIVE");
    assert.equal(after.expiresAt.getTime(), wtEffect.expiresAt.getTime());

    assert.equal((await activeEffects(raceId, bob.userId, "LEG_CRAMP")).length, 0);
    const item = await prisma.racePowerup.findUnique({ where: { id: cramp.id } });
    assert.equal(item.status, "HELD");
  });

  it("a reflected Leg Cramp landing on an attacker with an active Wrong Turn cancels the reversal (invariant holds, mirror not wasted)", async () => {
    const alice = await createUser("AliceConfC");
    const bob = await createUser("BobConfC");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    // Bob reverses Alice, then arms a Mirror.
    const wt = await giveHeldPowerup(raceId, bob.userId, "WRONG_TURN", 5001);
    assert.equal((await usePowerup(bob.token, raceId, wt.id, alice.userId)).status, 200);
    const [aliceWT] = await activeEffects(raceId, alice.userId, "WRONG_TURN");
    assert.ok(aliceWT);
    const mirror = await giveHeldPowerup(raceId, bob.userId, "MIRROR", 5002);
    assert.equal((await usePowerup(bob.token, raceId, mirror.id)).status, 200);

    // Alice cramps Bob (Bob is clean, so the direct pre-check passes) — the
    // Mirror reflects it back onto Alice, who has an active Wrong Turn.
    const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 5003);
    const res = await usePowerup(alice.token, raceId, cramp.id, bob.userId);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result.outcome, "REFLECTED");

    // Invariant: Alice now carries the cramp and her Wrong Turn was cancelled
    // with a truncated window (scoring reads EXPIRED rows over
    // [startsAt, expiresAt], so status-only cancels leave phantom effects).
    assert.equal((await activeEffects(raceId, alice.userId, "LEG_CRAMP")).length, 1);
    assert.equal((await activeEffects(raceId, alice.userId, "WRONG_TURN")).length, 0);
    const cancelledWT = await prisma.raceActiveEffect.findUnique({ where: { id: aliceWT.id } });
    assert.equal(cancelledWT.status, "EXPIRED");
    assert.ok(
      cancelledWT.expiresAt.getTime() <= Date.now(),
      "cancelled Wrong Turn's expiresAt must be truncated to the cancel moment"
    );
  });
});
