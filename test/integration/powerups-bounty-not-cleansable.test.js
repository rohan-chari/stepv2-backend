const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// ---------------------------------------------------------------------------
// BOUNTY is not a debuff — Cleanse and Quick Rinse must never clear it.
//
// A Bounty is a placement WAGER the caster puts on a rival ahead of them: it
// inflicts nothing on the target and settles at race end. But the row lives on
// the TARGET's participant with sourceUserId = caster, targetUserId = target —
// exactly the shape the cleanse selector (`isOpponentInflicted`) uses to mean
// "a debuff someone else put on me". Left unfiltered, the bountied rival could
// spend one Cleanse to erase the caster's stake, and a Quick Rinse could be
// burned on it too (its expiresAt = race end, so it reads as a live timed
// effect).
//
// These run the REAL use-powerup endpoint end to end and assert on what the
// API returns plus the surviving effect row.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-bnty-${++nextAppleId}`;
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

// Bounty requires a race with a fixed end instant (time-based), so this is a
// duration race rather than the step-target races the cleanse suite uses.
async function createActiveRace(alice, bob) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Bounty Cleanse Test",
      timeBased: true,
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
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: alice.token,
  });
  const start = hoursAgo(8);
  await prisma.race.update({
    where: { id: raceId },
    data: {
      startedAt: start,
      endsAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: start },
  });
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findFirst({
    where: { raceId, userId },
  });
  const rareTypes = ["COMPRESSION_SOCKS", "MIRROR", "CLEANSE", "BOUNTY"];
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: rareTypes.includes(type) ? "RARE" : "UNCOMMON",
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
    {
      body: targetUserId ? { targetUserId } : {},
      token,
      // Wave-5 types are client-feature gated; a powerups5 build is what can
      // cast a Bounty at all.
      headers: { "X-Client-Features": "powerups5" },
    }
  );
}

async function recordSamples(token, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", {
    body: { samples },
    token,
  });
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

function sample(startH, endH, steps) {
  return {
    periodStart: hoursAgo(startH).toISOString(),
    periodEnd: hoursAgo(endH).toISOString(),
    steps,
  };
}

// Alice trails Bob, so Alice can legally place a Bounty on Bob (the wager must
// target a rival AHEAD of the caster). Returns the created BOUNTY effect row.
async function placeBountyOnBob(alice, bob, raceId) {
  // This suite exercises cleanser semantics, not asynchronous score
  // projection. Establish the prerequisite standings deterministically, as
  // the canonical Bounty integration suite does.
  await prisma.raceParticipant.updateMany({
    where: { raceId, userId: bob.userId }, data: { totalSteps: 9000 },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId, userId: alice.userId }, data: { totalSteps: 1000 },
  });
  const bounty = await giveHeldPowerup(raceId, alice.userId, "BOUNTY", 99801);
  const res = await usePowerup(alice.token, raceId, bounty.id, bob.userId);
  assert.equal(res.status, 200, "Alice can place a Bounty on the rival ahead");
  const effect = await prisma.raceActiveEffect.findFirst({
    where: { raceId, type: "BOUNTY" },
  });
  assert.ok(effect, "bounty effect row exists");
  assert.equal(effect.sourceUserId, alice.userId);
  assert.equal(effect.targetUserId, bob.userId);
  return effect;
}

describe("Bounty survives Cleanse and Quick Rinse", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("Cleanse with ONLY a bounty on you is rejected and leaves it ACTIVE", async () => {
    const alice = await createUser("AliceBountyHunter");
    const bob = await createUser("BobBountied");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const bountyEffect = await placeBountyOnBob(alice, bob, raceId);

    // Bob has no real debuffs — only the bounty. Cleanse must reject as
    // "nothing to cleanse" rather than eating Alice's wager.
    const cleanse = await giveHeldPowerup(raceId, bob.userId, "CLEANSE", 99802);
    const res = await usePowerup(bob.token, raceId, cleanse.id);
    assert.equal(res.status, 400, "no cleansable debuff → rejected");

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: bountyEffect.id },
    });
    assert.equal(after.status, "ACTIVE", "bounty is untouched by Cleanse");
    assert.equal(
      after.expiresAt.getTime(),
      bountyEffect.expiresAt.getTime(),
      "bounty window is not truncated"
    );
  });

  it("Cleanse clears real debuffs but not the bounty", async () => {
    const alice = await createUser("AliceBountyHunter2");
    const bob = await createUser("BobBountied2");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const bountyEffect = await placeBountyOnBob(alice, bob, raceId);

    // Alice ALSO leg-cramps Bob — a genuine opponent-inflicted debuff.
    const cramp = await giveHeldPowerup(
      raceId,
      alice.userId,
      "LEG_CRAMP",
      99803
    );
    const crampRes = await usePowerup(
      alice.token,
      raceId,
      cramp.id,
      bob.userId
    );
    assert.equal(crampRes.status, 200);

    const cleanse = await giveHeldPowerup(raceId, bob.userId, "CLEANSE", 99804);
    const res = await usePowerup(bob.token, raceId, cleanse.id);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(
      body.result.cleared,
      1,
      "only the leg cramp is cleared — the bounty is not counted"
    );

    const crampEffect = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "LEG_CRAMP" },
    });
    assert.equal(crampEffect.status, "EXPIRED", "the real debuff is cleared");

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: bountyEffect.id },
    });
    assert.equal(after.status, "ACTIVE", "bounty survives the cleanse");
  });

  it("Quick Rinse with ONLY a bounty on you is rejected and leaves it ACTIVE", async () => {
    const alice = await createUser("AliceBountyHunter3");
    const bob = await createUser("BobBountied3");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const bountyEffect = await placeBountyOnBob(alice, bob, raceId);

    // The bounty row carries expiresAt = race end, so it reads as a LIVE TIMED
    // effect. Quick Rinse must still see nothing to rinse.
    const rinse = await giveHeldPowerup(
      raceId,
      bob.userId,
      "QUICK_RINSE",
      99805
    );
    const res = await usePowerup(bob.token, raceId, rinse.id);
    assert.equal(res.status, 409, "no timed debuffs → NO_TIMED_DEBUFFS");
    const body = await res.json();
    assert.equal(body.code, "NO_TIMED_DEBUFFS");

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: bountyEffect.id },
    });
    assert.equal(after.status, "ACTIVE", "bounty is untouched by Quick Rinse");
  });
});
