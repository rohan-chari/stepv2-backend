const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// ---------------------------------------------------------------------------
// Only ONE Ghost Pepper at a time.
//
// Ghost Pepper is a two-phase self-buff: 3x for 30 minutes, then a 30-minute
// burnout freeze. Nothing stopped a user from eating a second one, and both
// outcomes of stacking are wrong:
//
//   * Two peppers lit together SUM their multipliers (effectMultiplier.js sums
//     every active buff row — pepper 3 + pepper 3 = 6x), doubling the intended
//     ceiling for anyone holding two.
//   * A pepper eaten during the first one's burnout is simply destroyed —
//     the freeze check runs before the buff sum and returns 0 regardless.
//
// So the second pepper is either an exploit or a coin-burning trap. It must be
// rejected while one is live, and — because Ghost Pepper is a store-bought
// wave-5 item paid for with real coins — the rejected item must stay HELD in
// the race rather than being consumed (the transient "already active" pattern
// used by Rainstorm/Hitchhike/Piggy Bank).
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-ghp-${++nextAppleId}`;
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
      name: "Ghost Pepper Stack Test",
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
  const start = new Date(Date.now() - 8 * 60 * 60 * 1000);
  await prisma.race.update({
    where: { id: raceId },
    data: { startedAt: start },
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

async function usePowerup(token, raceId, powerupId) {
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/use`,
    {
      body: {},
      token,
      headers: { "X-Client-Features": "powerups5" },
    }
  );
}

describe("Ghost Pepper cannot be stacked", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("rejects a second pepper during the BOOST phase and keeps it HELD", async () => {
    const alice = await createUser("AlicePepper");
    const bob = await createUser("BobBystander");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const first = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99701
    );
    const firstRes = await usePowerup(alice.token, raceId, first.id);
    assert.equal(firstRes.status, 200, "the first pepper lights normally");

    // Second pepper while the first is still in its 3x boost window.
    const second = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99702
    );
    const secondRes = await usePowerup(alice.token, raceId, second.id);
    assert.equal(secondRes.status, 400, "a second pepper is rejected");

    // Exactly one pepper effect exists — no 3+3=6x window was created.
    const effects = await prisma.raceActiveEffect.findMany({
      where: { raceId, type: "GHOST_PEPPER" },
    });
    assert.equal(effects.length, 1, "only one Ghost Pepper effect exists");

    // The rejected pepper was PAID FOR — it must still be usable later.
    const stillHeld = await prisma.racePowerup.findUnique({
      where: { id: second.id },
    });
    assert.equal(
      stillHeld.status,
      "HELD",
      "the rejected pepper is not consumed"
    );
  });

  it("rejects a second pepper during the BURNOUT freeze phase too", async () => {
    const alice = await createUser("AlicePepper2");
    const bob = await createUser("BobBystander2");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const first = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99703
    );
    assert.equal((await usePowerup(alice.token, raceId, first.id)).status, 200);

    // Advance past the boost into the burnout: backdate startsAt by 40 minutes
    // so the boost (30m) is over but the row is still ACTIVE until 60m.
    const effect = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "GHOST_PEPPER" },
    });
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: {
        startsAt: new Date(Date.now() - 40 * 60 * 1000),
        expiresAt: new Date(Date.now() + 20 * 60 * 1000),
      },
    });

    const second = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99704
    );
    const secondRes = await usePowerup(alice.token, raceId, second.id);
    assert.equal(
      secondRes.status,
      400,
      "a pepper eaten during burnout is rejected, not silently wasted"
    );

    const stillHeld = await prisma.racePowerup.findUnique({
      where: { id: second.id },
    });
    assert.equal(stillHeld.status, "HELD");
  });

  it("allows a new pepper once the previous one has fully expired", async () => {
    const alice = await createUser("AlicePepper3");
    const bob = await createUser("BobBystander3");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const first = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99705
    );
    assert.equal((await usePowerup(alice.token, raceId, first.id)).status, 200);

    // Retire the first pepper the way the expiry job would.
    const effect = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "GHOST_PEPPER" },
    });
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: {
        startsAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        status: "EXPIRED",
      },
    });

    const second = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99706
    );
    const secondRes = await usePowerup(alice.token, raceId, second.id);
    assert.equal(
      secondRes.status,
      200,
      "the guard is transient — a fresh pepper works once the last one ended"
    );

    const effects = await prisma.raceActiveEffect.findMany({
      where: { raceId, type: "GHOST_PEPPER" },
    });
    assert.equal(effects.length, 2, "a second, separate pepper window exists");
  });

  it("a stale ACTIVE row past its window does not block a new pepper", async () => {
    const alice = await createUser("AlicePepper5");
    const bob = await createUser("BobBystander5");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const first = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99709
    );
    assert.equal((await usePowerup(alice.token, raceId, first.id)).status, 200);

    // The expireEffects cron flips status ACTIVE -> EXPIRED, but it runs on a
    // timer. Between the real end of the burnout and that tick, the row is
    // still ACTIVE — the guard must go by the WINDOW, not the status, or a lagging
    // cron would keep the user locked out after their pepper actually wore off.
    const effect = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "GHOST_PEPPER" },
    });
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: {
        startsAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        status: "ACTIVE",
      },
    });

    const second = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99710
    );
    assert.equal(
      (await usePowerup(alice.token, raceId, second.id)).status,
      200,
      "an un-retired but time-expired pepper must not block"
    );
  });

  it("one user's pepper does not block another user's", async () => {
    const alice = await createUser("AlicePepper4");
    const bob = await createUser("BobPepper4");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const alicePepper = await giveHeldPowerup(
      raceId,
      alice.userId,
      "GHOST_PEPPER",
      99707
    );
    const bobPepper = await giveHeldPowerup(
      raceId,
      bob.userId,
      "GHOST_PEPPER",
      99708
    );

    assert.equal(
      (await usePowerup(alice.token, raceId, alicePepper.id)).status,
      200
    );
    assert.equal(
      (await usePowerup(bob.token, raceId, bobPepper.id)).status,
      200,
      "the guard is per-participant, not per-race"
    );
  });
});
