const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-new-pu-${++nextAppleId}`;
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
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
    body: { accept: true },
    token: b.token,
  });
}

async function createActiveRace() {
  const alice = await createUser("AliceNewPU");
  const bob = await createUser("BobbyNewPU");
  await makeFriends(alice, bob);

  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "New Powerups",
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
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: alice.token,
  });

  return { alice, bob, raceId };
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps, rarity = "COMMON") {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity,
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function usePowerup(token, raceId, powerupId, body = {}) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body,
    token,
  });
}

describe("new powerups — integration", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("Pinecone Toss targets the adjacent runner by direction", async () => {
    const { alice, bob, raceId } = await createActiveRace();
    const aliceParticipant = await participant(raceId, alice.userId);
    const bobParticipant = await participant(raceId, bob.userId);
    await prisma.raceParticipant.update({
      where: { id: aliceParticipant.id },
      data: { totalSteps: 1000 },
    });
    await prisma.raceParticipant.update({
      where: { id: bobParticipant.id },
      data: { totalSteps: 5000 },
    });

    const pinecone = await giveHeldPowerup(
      raceId,
      alice.userId,
      "PINECONE_TOSS",
      1000,
      "UNCOMMON"
    );
    const res = await usePowerup(alice.token, raceId, pinecone.id, {
      targetDirection: "FRONT",
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.penalty, 750);

    const updatedBob = await participant(raceId, bob.userId);
    assert.equal(updatedBob.bonusSteps, -750);
  });

  it("Sneaky Swap options require Sneaky Swap and reject stealthed targets", async () => {
    const { alice, bob, raceId } = await createActiveRace();
    const bobParticipant = await participant(raceId, bob.userId);

    const bobTrade = await giveHeldPowerup(raceId, bob.userId, "PINECONE_TOSS", 1000, "UNCOMMON");

    const noSneakyRes = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/powerups/sneaky-swap-options/${bob.userId}`,
      { token: alice.token }
    );
    assert.equal(noSneakyRes.status, 400);
    assert.match((await noSneakyRes.json()).error, /required/i);

    await giveHeldPowerup(raceId, alice.userId, "SNEAKY_SWAP", 1000, "RARE");
    const aliceTrade = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MAGNET", 2000, "COMMON");

    const optionsRes = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/powerups/sneaky-swap-options/${bob.userId}`,
      { token: alice.token }
    );
    assert.equal(optionsRes.status, 200);
    const options = await optionsRes.json();
    assert.deepEqual(options.ownPowerups.map((p) => p.id), [aliceTrade.id]);
    assert.deepEqual(options.targetPowerups.map((p) => p.id), [bobTrade.id]);

    const stealth = await giveHeldPowerup(raceId, bob.userId, "STEALTH_MODE", 2000, "UNCOMMON");
    await prisma.raceActiveEffect.create({
      data: {
        raceId,
        targetParticipantId: bobParticipant.id,
        targetUserId: bob.userId,
        sourceUserId: bob.userId,
        powerupId: stealth.id,
        type: "STEALTH_MODE",
        startsAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const blockedRes = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/powerups/sneaky-swap-options/${bob.userId}`,
      { token: alice.token }
    );
    assert.equal(blockedRes.status, 400);
    assert.match((await blockedRes.json()).error, /stealthed/i);
  });

  // Sneaky Swap redesign (2026-07): one-way STEAL. The attacker takes one
  // random stealable powerup from the target and gives up NOTHING — even when
  // an old app version still sends the retired mutual-swap ids.
  it("Sneaky Swap steals one target powerup and never gives up the attacker's own (legacy ids ignored)", async () => {
    const { alice, bob, raceId } = await createActiveRace();

    const sneaky = await giveHeldPowerup(raceId, alice.userId, "SNEAKY_SWAP", 1000, "RARE");
    // Alice already holds a powerup at earnedAtSteps=5000; the stolen row also
    // sits at 5000 on Bob's shelf. Pre-clear of earned_at_steps is what keeps
    // this from colliding with the (participant_id, earned_at_steps) unique
    // index (the old P2002 regression, same trap for steals).
    const aliceOwn = await giveHeldPowerup(
      raceId,
      alice.userId,
      "PROTEIN_SHAKE",
      5000,
      "COMMON"
    );
    const bobOnly = await giveHeldPowerup(
      raceId,
      bob.userId,
      "TRAIL_MIX",
      5000,
      "COMMON"
    );

    // Old-client request shape: still sends both swap ids. Both are ignored.
    const res = await usePowerup(alice.token, raceId, sneaky.id, {
      targetUserId: bob.userId,
      swapOfferedPowerupId: aliceOwn.id,
      swapRequestedPowerupId: bobOnly.id,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.swapped, true, "legacy success flag kept");
    // Bob's only stealable powerup is the deterministic pick.
    assert.equal(body.result.stolenPowerup.id, bobOnly.id);
    assert.equal(body.result.stolenPowerup.type, "TRAIL_MIX");

    const aliceParticipant = await participant(raceId, alice.userId);
    const bobParticipant = await participant(raceId, bob.userId);

    // Stolen row moved to Alice with earned_at_steps cleared (no P2002).
    const stolen = await prisma.racePowerup.findUnique({ where: { id: bobOnly.id } });
    assert.equal(stolen.participantId, aliceParticipant.id);
    assert.equal(stolen.userId, alice.userId);
    assert.equal(stolen.earnedAtSteps, null);

    // Alice's own powerup did NOT move (the legacy offered id is ignored).
    const kept = await prisma.racePowerup.findUnique({ where: { id: aliceOwn.id } });
    assert.equal(kept.participantId, aliceParticipant.id);
    assert.equal(kept.userId, alice.userId);
    assert.equal(kept.earnedAtSteps, 5000);

    // The sneaky swap is consumed — net slots: Alice holds own + stolen.
    const usedSneaky = await prisma.racePowerup.findUnique({ where: { id: sneaky.id } });
    assert.equal(usedSneaky.status, "USED");
    const aliceHeld = await prisma.racePowerup.count({
      where: { participantId: aliceParticipant.id, status: "HELD" },
    });
    const bobHeld = await prisma.racePowerup.count({
      where: { participantId: bobParticipant.id, status: "HELD" },
    });
    assert.equal(aliceHeld, 2, "own + stolen");
    assert.equal(bobHeld, 0, "target lost exactly one");
  });

  it("Sneaky Swap 400s (and is preserved) when the target holds only non-stealable powerups", async () => {
    const { alice, bob, raceId } = await createActiveRace();

    const sneaky = await giveHeldPowerup(raceId, alice.userId, "SNEAKY_SWAP", 1000, "RARE");
    // Bob holds only a Sneaky Swap and a boxed Mystery Box — neither stealable.
    const bobSwap = await giveHeldPowerup(raceId, bob.userId, "SNEAKY_SWAP", 1000, "RARE");
    const bobBox = await giveHeldPowerup(raceId, bob.userId, "MYSTERY_BOX", 2000, "COMMON");

    const res = await usePowerup(alice.token, raceId, sneaky.id, {
      targetUserId: bob.userId,
    });

    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /steal/i);

    // Nothing was consumed or moved.
    const sneakyRow = await prisma.racePowerup.findUnique({ where: { id: sneaky.id } });
    assert.equal(sneakyRow.status, "HELD", "sneaky swap not consumed on rejection");
    const bobParticipant = await participant(raceId, bob.userId);
    for (const id of [bobSwap.id, bobBox.id]) {
      const row = await prisma.racePowerup.findUnique({ where: { id } });
      assert.equal(row.participantId, bobParticipant.id);
    }
  });

  it("Compression Socks blocks the steal: shield + sneaky swap consumed, nothing changes hands", async () => {
    const { alice, bob, raceId } = await createActiveRace();
    const bobParticipant = await participant(raceId, bob.userId);

    const sneaky = await giveHeldPowerup(raceId, alice.userId, "SNEAKY_SWAP", 1000, "RARE");
    const bobLoot = await giveHeldPowerup(raceId, bob.userId, "TRAIL_MIX", 2000, "COMMON");
    const socks = await giveHeldPowerup(raceId, bob.userId, "COMPRESSION_SOCKS", 3000, "UNCOMMON");
    const shield = await prisma.raceActiveEffect.create({
      data: {
        raceId,
        targetParticipantId: bobParticipant.id,
        targetUserId: bob.userId,
        sourceUserId: bob.userId,
        powerupId: socks.id,
        type: "COMPRESSION_SOCKS",
        startsAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const res = await usePowerup(alice.token, raceId, sneaky.id, {
      targetUserId: bob.userId,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.blocked, true);
    assert.equal(body.result.outcome, "BLOCKED");

    // Product decision 2026-07-01: the sneaky swap IS lost to a shield.
    const usedSneaky = await prisma.racePowerup.findUnique({ where: { id: sneaky.id } });
    assert.equal(usedSneaky.status, "USED");
    // Shield consumed; Bob keeps his powerup.
    const shieldRow = await prisma.raceActiveEffect.findUnique({ where: { id: shield.id } });
    assert.equal(shieldRow.status, "BLOCKED");
    const loot = await prisma.racePowerup.findUnique({ where: { id: bobLoot.id } });
    assert.equal(loot.participantId, bobParticipant.id);
    assert.equal(loot.userId, bob.userId);
  });

  it("Mirror reflects the steal: the attacker loses a random powerup to the target", async () => {
    const { alice, bob, raceId } = await createActiveRace();
    const aliceParticipant = await participant(raceId, alice.userId);
    const bobParticipant = await participant(raceId, bob.userId);

    const sneaky = await giveHeldPowerup(raceId, alice.userId, "SNEAKY_SWAP", 1000, "RARE");
    const aliceLoot = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MAGNET", 2000, "COMMON");
    // Bob needs a stealable powerup for the attack to validate pre-reflect.
    const bobLoot = await giveHeldPowerup(raceId, bob.userId, "TRAIL_MIX", 2000, "COMMON");
    const mirrorPw = await giveHeldPowerup(raceId, bob.userId, "MIRROR", 3000, "RARE");
    const mirror = await prisma.raceActiveEffect.create({
      data: {
        raceId,
        targetParticipantId: bobParticipant.id,
        targetUserId: bob.userId,
        sourceUserId: bob.userId,
        powerupId: mirrorPw.id,
        type: "MIRROR",
        startsAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const res = await usePowerup(alice.token, raceId, sneaky.id, {
      targetUserId: bob.userId,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.reflected, true);
    assert.equal(body.result.outcome, "REFLECTED");

    // Alice's only stealable powerup is now Bob's (SNEAKY_SWAP excluded by type).
    const stolen = await prisma.racePowerup.findUnique({ where: { id: aliceLoot.id } });
    assert.equal(stolen.participantId, bobParticipant.id);
    assert.equal(stolen.userId, bob.userId);
    assert.equal(stolen.earnedAtSteps, null);

    // Bob keeps his own powerup; the mirror is consumed; the sneaky swap is used.
    const bobRow = await prisma.racePowerup.findUnique({ where: { id: bobLoot.id } });
    assert.equal(bobRow.participantId, bobParticipant.id);
    const mirrorRow = await prisma.raceActiveEffect.findUnique({ where: { id: mirror.id } });
    assert.equal(mirrorRow.status, "EXPIRED");
    const usedSneaky = await prisma.racePowerup.findUnique({ where: { id: sneaky.id } });
    assert.equal(usedSneaky.status, "USED");
    // And Alice did not receive anything back.
    const aliceHeld = await prisma.racePowerup.count({
      where: { participantId: aliceParticipant.id, status: "HELD" },
    });
    assert.equal(aliceHeld, 0);
  });
});
