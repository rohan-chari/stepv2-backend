// §3.3 regression (promoted from the 2026-07-24 empirical probe): legacy Pocket
// Watch only extends effects whose REMAINING tail is favorable to the caster.
// A Ghost Pepper's tail is a burnout FREEZE, so extending it would silently
// lengthen the caster's own freeze — proven by the original probe. The
// favorable-tail filter (isPocketWatchExtendable) now excludes GHOST_PEPPER (and
// losing Coin Flips) in BOTH the validation pre-check and the application loop.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;
const FEATS = { "X-Client-Features": "characters,powerups3,powerups4,powerups5" };

async function createUser(displayName) {
  const appleId = `apple-pwgp-${++nextAppleId}`;
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

async function createActiveRace(alice, bob) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "PW+GP Regression",
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

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity: "COMMON",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function usePowerup(token, raceId, powerupId, body = {}) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body,
    token,
    headers: FEATS,
  });
}

async function activeEffects(raceId, userId) {
  return prisma.raceActiveEffect.findMany({
    where: { raceId, targetUserId: userId, status: "ACTIVE" },
    orderBy: { startsAt: "asc" },
  });
}

describe("§3.3 Pocket Watch × Ghost Pepper favorable-tail filter", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("legacy Pocket Watch does NOT extend a Ghost Pepper but DOES extend a Runner's High in the same call", async () => {
    const alice = await createUser("PW Alice");
    const bob = await createUser("PW Bob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const rh = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 4000);
    const pepper = await giveHeldPowerup(raceId, alice.userId, "GHOST_PEPPER", 5000);
    const watch = await giveHeldPowerup(raceId, alice.userId, "POCKET_WATCH", 10000);

    assert.equal((await usePowerup(alice.token, raceId, rh.id)).status, 200);
    assert.equal((await usePowerup(alice.token, raceId, pepper.id)).status, 200);

    const before = await activeEffects(raceId, alice.userId);
    const pepperBefore = before.find((e) => e.type === "GHOST_PEPPER");
    const rhBefore = before.find((e) => e.type === "RUNNERS_HIGH");
    assert.ok(pepperBefore, "ghost pepper should be active");
    assert.ok(rhBefore, "runner's high should be active");

    const watchRes = await usePowerup(alice.token, raceId, watch.id);
    assert.equal(watchRes.status, 200);
    const watchBody = await watchRes.json();
    // Only the Runner's High was favorable — the pepper is skipped.
    assert.equal(watchBody.result.extendedEffects, 1);

    const after = await activeEffects(raceId, alice.userId);
    const pepperAfter = after.find((e) => e.type === "GHOST_PEPPER");
    const rhAfter = after.find((e) => e.type === "RUNNERS_HIGH");

    assert.equal(
      new Date(pepperAfter.expiresAt).getTime(),
      new Date(pepperBefore.expiresAt).getTime(),
      "Ghost Pepper expiry must be UNCHANGED (its tail is a freeze)"
    );
    assert.ok(
      new Date(rhAfter.expiresAt).getTime() > new Date(rhBefore.expiresAt).getTime(),
      "Runner's High expiry must be extended"
    );
  });

  it("legacy Pocket Watch is REJECTED and NOT consumed when a Ghost Pepper is the only timed effect", async () => {
    const alice = await createUser("PW Alice2");
    const bob = await createUser("PW Bob2");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const pepper = await giveHeldPowerup(raceId, alice.userId, "GHOST_PEPPER", 5000);
    const watch = await giveHeldPowerup(raceId, alice.userId, "POCKET_WATCH", 10000);

    assert.equal((await usePowerup(alice.token, raceId, pepper.id)).status, 200);

    const watchRes = await usePowerup(alice.token, raceId, watch.id);
    assert.equal(watchRes.status, 400);
    assert.match((await watchRes.json()).error, /active timed buff/i);

    // The watch must still be HELD (nothing consumed).
    const stillHeld = await prisma.racePowerup.findUnique({ where: { id: watch.id } });
    assert.equal(stillHeld.status, "HELD");
  });

  it("Campfire Rest stays extendable (its tail is a boost)", async () => {
    const alice = await createUser("PW Alice3");
    const bob = await createUser("PW Bob3");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const campfire = await giveHeldPowerup(raceId, alice.userId, "CAMPFIRE_REST", 4000);
    const watch = await giveHeldPowerup(raceId, alice.userId, "POCKET_WATCH", 10000);

    assert.equal((await usePowerup(alice.token, raceId, campfire.id)).status, 200);

    const before = await activeEffects(raceId, alice.userId);
    const cfBefore = before.find((e) => e.type === "CAMPFIRE_REST");
    assert.ok(cfBefore);

    const watchRes = await usePowerup(alice.token, raceId, watch.id);
    assert.equal(watchRes.status, 200);
    assert.equal((await watchRes.json()).result.extendedEffects, 1);

    const after = await activeEffects(raceId, alice.userId);
    const cfAfter = after.find((e) => e.type === "CAMPFIRE_REST");
    assert.ok(
      new Date(cfAfter.expiresAt).getTime() > new Date(cfBefore.expiresAt).getTime(),
      "Campfire Rest expiry must be extended"
    );
  });

  it("targeted Pocket Watch cannot be pointed at a self Ghost Pepper (rejected, not consumed)", async () => {
    const alice = await createUser("PW Alice4");
    const bob = await createUser("PW Bob4");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const pepper = await giveHeldPowerup(raceId, alice.userId, "GHOST_PEPPER", 5000);
    const watch = await giveHeldPowerup(raceId, alice.userId, "POCKET_WATCH", 10000);

    assert.equal((await usePowerup(alice.token, raceId, pepper.id)).status, 200);
    const pepperEffect = (await activeEffects(raceId, alice.userId)).find(
      (e) => e.type === "GHOST_PEPPER"
    );

    const watchRes = await usePowerup(alice.token, raceId, watch.id, {
      targetEffectId: pepperEffect.id,
    });
    assert.equal(watchRes.status, 400);
    assert.match((await watchRes.json()).error, /debuff you placed on a rival/i);

    const stillHeld = await prisma.racePowerup.findUnique({ where: { id: watch.id } });
    assert.equal(stillHeld.status, "HELD");
  });
});
