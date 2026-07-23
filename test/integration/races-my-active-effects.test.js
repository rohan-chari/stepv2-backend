const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// Integration coverage for the additive `myActiveEffects` field on ACTIVE race
// summaries in GET /races (races-tab effect badges feature). Real HTTP, real DB.

let server;
let nextAppleId = 0;
let nextEarnedAtSteps = 90000;

const ALL_TOKENS = "powerups3,powerups4,powerups5";

async function createUser(displayName) {
  const appleId = `apple-mae-${++nextAppleId}`;
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

// Create a race, invite + accept the given opponents. Does NOT start it.
async function createPendingRace(creator, opponents, opts = {}) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: opts.name || "My Active Effects Test",
      targetSteps: 200000,
      maxDurationDays: 7,
      powerupsEnabled: opts.powerupsEnabled !== false,
      powerupStepInterval: 5000,
    },
    token: creator.token,
  });
  const raceId = (await createRes.json()).race.id;
  for (const p of opponents) {
    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      body: { inviteeIds: [p.userId] },
      token: creator.token,
    });
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: p.token,
    });
  }
  return raceId;
}

// Create a race, accept opponents, START it (ACTIVE), backdate the start.
async function createActiveRace(creator, opponents, opts = {}) {
  const raceId = await createPendingRace(creator, opponents, opts);
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: creator.token });
  const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

// Create an ACTIVE effect row directly (with the required powerup FK), targeting
// `targetUser`, cast by `sourceUserId`, of the given powerup `type`.
async function createEffect(raceId, targetUser, sourceUserId, type, expiresAt = null) {
  const participant = await prisma.raceParticipant.findFirst({
    where: { raceId, userId: targetUser.userId },
  });
  const powerup = await prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId: sourceUserId,
      type,
      rarity: "COMMON",
      status: "USED",
      earnedAtSteps: ++nextEarnedAtSteps,
    },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId,
      targetParticipantId: participant.id,
      targetUserId: targetUser.userId,
      sourceUserId,
      powerupId: powerup.id,
      type,
      status: "ACTIVE",
      startsAt: new Date(Date.now() - 60 * 1000),
      expiresAt,
    },
  });
}

async function listRaces(token, features) {
  const res = await request(server.baseUrl, "GET", "/races", {
    token,
    headers: features ? { "X-Client-Features": features } : undefined,
  });
  return res.json();
}

function findInBucket(body, bucket, raceId) {
  return (body[bucket] || []).find((r) => r.id === raceId);
}

function findAnywhere(body, raceId) {
  for (const bucket of ["active", "pending", "completed"]) {
    const hit = findInBucket(body, bucket, raceId);
    if (hit) return { bucket, race: hit };
  }
  return null;
}

describe("GET /races myActiveEffects", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // Test 1
  it("returns exactly the viewer's own effects (self-cast + rival-cast); a rival's effect on a third racer is excluded", async () => {
    const alice = await createUser("AliceMAE1AAA");
    const bob = await createUser("BobMAE1AAAAA");
    const charlie = await createUser("CharlieMAE1A");
    await makeFriends(alice, bob);
    await makeFriends(alice, charlie);
    const raceId = await createActiveRace(alice, [bob, charlie]);

    const buffExpiry = new Date("2026-07-24T01:00:00.000Z");
    const crampExpiry = new Date("2026-07-24T02:00:00.000Z");
    // Self-cast buff on alice (created first → createdAt-asc first).
    await createEffect(raceId, alice, alice.userId, "RUNNERS_HIGH", buffExpiry);
    // Rival-cast debuff on alice.
    await createEffect(raceId, alice, bob.userId, "LEG_CRAMP", crampExpiry);
    // Rival-cast effect on a THIRD racer — must not appear in alice's list.
    await createEffect(raceId, charlie, bob.userId, "LEG_CRAMP", crampExpiry);

    const body = await listRaces(alice.token, ALL_TOKENS);
    const race = findInBucket(body, "active", raceId);
    assert.ok(race, "active race present");
    assert.ok(Array.isArray(race.myActiveEffects), "myActiveEffects is an array");
    assert.equal(race.myActiveEffects.length, 2, "only the viewer's two effects");

    const [first, second] = race.myActiveEffects;
    assert.equal(first.type, "RUNNERS_HIGH");
    assert.equal(first.sourceUserId, alice.userId);
    assert.equal(new Date(first.expiresAt).toISOString(), buffExpiry.toISOString());

    assert.equal(second.type, "LEG_CRAMP");
    assert.equal(second.sourceUserId, bob.userId);
    assert.equal(new Date(second.expiresAt).toISOString(), crampExpiry.toISOString());

    // Contract: no onSelf / targetUserId / id keys on the entries.
    for (const e of race.myActiveEffects) {
      assert.ok(!("onSelf" in e), "no onSelf key");
      assert.ok(!("targetUserId" in e), "no targetUserId key");
      assert.ok(!("id" in e), "no id key");
      assert.deepEqual(Object.keys(e).sort(), ["expiresAt", "sourceUserId", "type"]);
    }
  });

  // Test 2
  it("omits myActiveEffects on PENDING, COMPLETED, powerups-disabled, and declined races", async () => {
    const alice = await createUser("AliceMAE2AAA");
    const bob = await createUser("BobMAE2AAAAA");
    await makeFriends(alice, bob);

    // PENDING race (never started).
    const pendingId = await createPendingRace(alice, [bob], { name: "Pending" });

    // COMPLETED race — even with an ACTIVE effect on the viewer, the field is gated on status.
    const completedId = await createActiveRace(alice, [bob], { name: "Completed" });
    await createEffect(completedId, alice, bob.userId, "LEG_CRAMP");
    await prisma.race.update({
      where: { id: completedId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    // powerups-disabled ACTIVE race.
    const noPowerupsId = await createActiveRace(alice, [bob], {
      name: "NoPowerups",
      powerupsEnabled: false,
    });

    // Declined race — alice declines bob's invite; race never appears in her list.
    const declinedRes = await request(server.baseUrl, "POST", "/races", {
      body: {
        name: "Declined",
        targetSteps: 200000,
        maxDurationDays: 7,
        powerupsEnabled: true,
        powerupStepInterval: 5000,
      },
      token: bob.token,
    });
    const declinedId = (await declinedRes.json()).race.id;
    await request(server.baseUrl, "POST", `/races/${declinedId}/invite`, {
      body: { inviteeIds: [alice.userId] },
      token: bob.token,
    });
    await request(server.baseUrl, "PUT", `/races/${declinedId}/respond`, {
      body: { accept: false },
      token: alice.token,
    });

    const body = await listRaces(alice.token, ALL_TOKENS);

    const pending = findInBucket(body, "pending", pendingId);
    assert.ok(pending, "pending race present");
    assert.ok(!("myActiveEffects" in pending), "no field on PENDING");

    const completed = findInBucket(body, "completed", completedId);
    assert.ok(completed, "completed race present");
    assert.ok(!("myActiveEffects" in completed), "no field on COMPLETED");

    const noPowerups = findInBucket(body, "active", noPowerupsId);
    assert.ok(noPowerups, "powerups-disabled active race present");
    assert.ok(!("myActiveEffects" in noPowerups), "no field when powerups disabled");

    assert.equal(findAnywhere(body, declinedId), null, "declined race absent from list");
  });

  // Test 3
  it("applies X-Client-Features downcast/withhold gating to the effect types", async () => {
    const alice = await createUser("AliceMAE3AAA");
    const bob = await createUser("BobMAE3AAAAA");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    await createEffect(raceId, alice, bob.userId, "QUICKSAND");
    await createEffect(raceId, alice, bob.userId, "BOUNTY");
    await createEffect(raceId, alice, bob.userId, "UPRISING");

    // Full-capability client: all three render as their real types.
    const full = findInBucket(await listRaces(alice.token, ALL_TOKENS), "active", raceId);
    const fullTypes = full.myActiveEffects.map((e) => e.type).sort();
    assert.deepEqual(fullTypes, ["BOUNTY", "QUICKSAND", "UPRISING"]);

    // Tokenless client: QUICKSAND→LEG_CRAMP, UPRISING→RUNNERS_HIGH, BOUNTY withheld.
    const old = findInBucket(await listRaces(alice.token, undefined), "active", raceId);
    const oldTypes = old.myActiveEffects.map((e) => e.type).sort();
    assert.deepEqual(oldTypes, ["LEG_CRAMP", "RUNNERS_HIGH"]);
    assert.ok(!oldTypes.includes("BOUNTY"), "BOUNTY withheld without powerups5");
  });

  // Test 4 — Detour regression: mask still derives from the shared bulk query.
  it("keeps Detour placement masking while also exposing the DETOUR_SIGN effect", async () => {
    const alice = await createUser("AliceMAE4AAA");
    const bob = await createUser("BobMAE4AAAAA");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    // Alice detours bob.
    await createEffect(raceId, bob, alice.userId, "DETOUR_SIGN");

    const bobRace = findInBucket(await listRaces(bob.token, ALL_TOKENS), "active", raceId);
    assert.equal(bobRace.myPlacement, null, "detoured viewer placement hidden");
    assert.equal(bobRace.myPlacementHidden, true);
    const detour = bobRace.myActiveEffects.find((e) => e.type === "DETOUR_SIGN");
    assert.ok(detour, "DETOUR_SIGN present in myActiveEffects");
    assert.equal(detour.sourceUserId, alice.userId);

    // Attacker (alice) unaffected: placement visible, no DETOUR_SIGN on her.
    const aliceRace = findInBucket(await listRaces(alice.token, ALL_TOKENS), "active", raceId);
    assert.equal(typeof aliceRace.myPlacement, "number");
    assert.equal(aliceRace.myPlacementHidden, false);
    assert.deepEqual(aliceRace.myActiveEffects, []);
  });
});
