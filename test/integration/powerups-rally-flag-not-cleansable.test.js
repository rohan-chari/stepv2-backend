const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");

// ---------------------------------------------------------------------------
// Batch 2026-08-09 item 7 — Rally Flag and Uprising are BUFFS, not debuffs.
// Cleanse and Quick Rinse must never clear them.
//
// Root cause this pins: both powerups write ONE EFFECT ROW PER BENEFICIARY via
// upsertBuffWindow, sourced from the caster. So on every teammate EXCEPT the
// caster the row has sourceUserId = caster, targetUserId = teammate — exactly
// the shape `isOpponentInflicted()` reads as "a debuff someone else put on me".
// The caster's own copy is self-sourced and was always safe, which is why the
// bug read as "intermittent": whether your rally buff survived a Cleanse
// depended on whether YOU were the one who raised the flag.
//
// The fix is one entry each in NON_CLEANSABLE_TYPES, which is the shared
// predicate behind BOTH cleanse paths and behind the "nothing to cleanse"
// guards — so this file asserts all three consequences (survival, the 400, and
// the 409) rather than just the removal.
//
// Follows the powerups-bounty-not-cleansable.test.js precedent: real HTTP, real
// DB, real handler chain, real casts. The buff rows under test are produced by
// genuinely casting Uprising / Rally Flag, not hand-inserted, because the
// per-beneficiary fan-out IS the thing that creates the bug.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;
let earnCounter = 0;
const HOUR_MS = 60 * 60 * 1000;

// Rally Flag needs a team-race-capable AND powerups5-capable client.
const HEADERS = { "X-Client-Features": "characters,team_races,powerups5" };

async function createUser(displayName) {
  const appleId = `apple-rally-cleanse-${++nextAppleId}`;
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
    headers: HEADERS,
  });
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
    body: { accept: true },
    token: b.token,
    headers: HEADERS,
  });
}

async function backdate(raceId) {
  const start = new Date(Date.now() - 8 * HOUR_MS);
  await prisma.race.update({
    where: { id: raceId },
    data: { startedAt: start, endsAt: new Date(Date.now() + 24 * HOUR_MS) },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: start },
  });
}

// Ordinary (non-team) race — Uprising's solo bottom-half branch.
async function createSoloRace(creator, opponents) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Rally Cleanse Solo",
      targetSteps: 200000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: creator.token,
    headers: HEADERS,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: opponents.map((o) => o.userId) },
    token: creator.token,
    headers: HEADERS,
  });
  for (const o of opponents) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
      headers: HEADERS,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: creator.token,
    headers: HEADERS,
  });
  await backdate(raceId);
  return raceId;
}

// Started 2v2: alice+bob = TEAM_A, carol+dave = TEAM_B.
async function createTeamRace(alice, bob, carol, dave) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Rally Cleanse Team",
      targetSteps: 200000,
      maxDurationDays: 7,
      isTeamRace: true,
      teamSize: 2,
      isPublic: true,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: alice.token,
    headers: HEADERS,
  });
  const raceId = (await createRes.json()).race.id;
  for (const other of [bob, carol, dave]) await makeFriends(alice, other);
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: [bob.userId, carol.userId, dave.userId] },
    token: alice.token,
    headers: HEADERS,
  });
  for (const [user, team] of [
    [bob, "TEAM_A"],
    [carol, "TEAM_B"],
    [dave, "TEAM_B"],
  ]) {
    const res = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true, team },
      token: user.token,
      headers: HEADERS,
    });
    assert.equal(res.status, 200, `accept for ${team} should succeed`);
  }
  const startRes = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: alice.token,
    headers: HEADERS,
  });
  assert.equal(startRes.status, 200);
  await backdate(raceId);
  return raceId;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function setSteps(raceId, userId, totalSteps) {
  const p = await participant(raceId, userId);
  await prisma.raceParticipant.update({
    where: { id: p.id },
    data: { totalSteps },
  });
}

async function giveHeld(raceId, userId, type, rarity = "RARE") {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity,
      status: "HELD",
      earnedAtSteps: ++earnCounter,
    },
  });
}

async function usePU(token, raceId, powerupId, body = {}) {
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/use`,
    { body, token, headers: HEADERS }
  );
}

async function buffRowFor(raceId, type, userId) {
  const p = await participant(raceId, userId);
  return prisma.raceActiveEffect.findFirst({
    where: { raceId, type, targetParticipantId: p.id },
  });
}

describe("Rally Flag and Uprising survive Cleanse and Quick Rinse", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    await appSettings.setFlag("teamRacesEnabled", true);
  });

  // ── Rally Flag (team race) ────────────────────────────────────────────────

  // Alice raises the flag; Bob is her teammate, so BOB's copy is the
  // caster-sourced row that used to look cleansable.
  async function raisedFlag() {
    const alice = await createUser("AliceFlag");
    const bob = await createUser("BobFlag");
    const carol = await createUser("CarolFlag");
    const dave = await createUser("DaveFlag");
    const raceId = await createTeamRace(alice, bob, carol, dave);

    const flag = await giveHeld(raceId, alice.userId, "RALLY_FLAG", "UNCOMMON");
    const res = await usePU(alice.token, raceId, flag.id);
    assert.equal(res.status, 200, "Alice can raise a Rally Flag in a team race");

    const bobFlag = await buffRowFor(raceId, "RALLY_FLAG", bob.userId);
    assert.ok(bobFlag, "Bob got a Rally Flag row");
    // The exact shape that makes this bug possible: teammate-targeted,
    // caster-sourced. If this ever stops being true the bug is gone for a
    // different reason and these tests would silently stop testing anything.
    assert.equal(bobFlag.sourceUserId, alice.userId);
    assert.equal(bobFlag.targetUserId, bob.userId);
    assert.notEqual(bobFlag.sourceUserId, bobFlag.targetUserId);

    return { alice, bob, carol, dave, raceId, bobFlag };
  }

  it("Cleanse with ONLY a teammate's Rally Flag on you is rejected 400 and leaves it ACTIVE", async () => {
    const { bob, raceId, bobFlag } = await raisedFlag();

    const cleanse = await giveHeld(raceId, bob.userId, "CLEANSE");
    const res = await usePU(bob.token, raceId, cleanse.id);
    assert.equal(res.status, 400, "a rally buff is not a cleansable debuff");
    assert.match((await res.json()).error, /no debuffs to cleanse/i);

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: bobFlag.id },
    });
    assert.equal(after.status, "ACTIVE", "Rally Flag untouched by Cleanse");
    assert.equal(
      after.expiresAt.getTime(),
      bobFlag.expiresAt.getTime(),
      "Rally Flag window is not truncated"
    );
  });

  it("Quick Rinse with ONLY a teammate's Rally Flag on you is rejected 409 NO_TIMED_DEBUFFS", async () => {
    const { bob, raceId, bobFlag } = await raisedFlag();

    const rinse = await giveHeld(raceId, bob.userId, "QUICK_RINSE");
    const res = await usePU(bob.token, raceId, rinse.id);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "NO_TIMED_DEBUFFS");

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: bobFlag.id },
    });
    assert.equal(after.status, "ACTIVE", "Rally Flag untouched by Quick Rinse");
  });

  it("Cleanse clears a real debuff alongside a surviving Rally Flag", async () => {
    const { bob, carol, raceId, bobFlag } = await raisedFlag();

    // Carol (an actual opponent) leg-cramps Bob — a genuine debuff.
    const cramp = await giveHeld(raceId, carol.userId, "LEG_CRAMP", "UNCOMMON");
    const crampRes = await usePU(carol.token, raceId, cramp.id, {
      targetUserId: bob.userId,
    });
    assert.equal(crampRes.status, 200);

    const cleanse = await giveHeld(raceId, bob.userId, "CLEANSE");
    const res = await usePU(bob.token, raceId, cleanse.id);
    assert.equal(res.status, 200);
    assert.equal(
      (await res.json()).result.cleared,
      1,
      "only the leg cramp is cleared — the Rally Flag is not counted"
    );

    const crampEffect = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "LEG_CRAMP" },
    });
    assert.equal(crampEffect.status, "EXPIRED", "the real debuff is cleared");

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: bobFlag.id },
    });
    assert.equal(after.status, "ACTIVE", "Rally Flag survives the cleanse");
  });

  it("the caster's own Rally Flag copy is unaffected too", async () => {
    const { alice, carol, raceId } = await raisedFlag();

    const aliceFlag = await buffRowFor(raceId, "RALLY_FLAG", alice.userId);
    assert.ok(aliceFlag);
    // Self-sourced — this copy was always safe; pinned so a future refactor of
    // the exclusion can't regress it while "fixing" the teammate case.
    assert.equal(aliceFlag.sourceUserId, aliceFlag.targetUserId);

    const cramp = await giveHeld(raceId, carol.userId, "LEG_CRAMP", "UNCOMMON");
    await usePU(carol.token, raceId, cramp.id, { targetUserId: alice.userId });
    const cleanse = await giveHeld(raceId, alice.userId, "CLEANSE");
    const res = await usePU(alice.token, raceId, cleanse.id);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result.cleared, 1);

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: aliceFlag.id },
    });
    assert.equal(after.status, "ACTIVE");
  });

  // ── Uprising (solo race, bottom-half branch) ──────────────────────────────

  // Four runners; Carol (3rd) sparks the Uprising, so beneficiaries are Carol
  // and Dave. DAVE's copy is the caster-sourced one under test.
  async function sparkedUprising() {
    const alice = await createUser("AliceUp");
    const bob = await createUser("BobUp");
    const carol = await createUser("CarolUp");
    const dave = await createUser("DaveUp");
    for (const other of [bob, carol, dave]) await makeFriends(alice, other);
    const raceId = await createSoloRace(alice, [bob, carol, dave]);

    // Standings: alice 8000 > bob 6000 > carol 2000 > dave 1000. Bottom half of
    // four is index 2..3 = carol, dave.
    await setSteps(raceId, alice.userId, 8000);
    await setSteps(raceId, bob.userId, 6000);
    await setSteps(raceId, carol.userId, 2000);
    await setSteps(raceId, dave.userId, 1000);

    const up = await giveHeld(raceId, carol.userId, "UPRISING");
    const res = await usePU(carol.token, raceId, up.id);
    assert.equal(res.status, 200, "Carol is in the bottom half");
    assert.equal((await res.json()).result.affected, 2);

    const daveUp = await buffRowFor(raceId, "UPRISING", dave.userId);
    assert.ok(daveUp, "Dave got an Uprising row");
    assert.equal(daveUp.sourceUserId, carol.userId);
    assert.equal(daveUp.targetUserId, dave.userId);

    return { alice, bob, carol, dave, raceId, daveUp };
  }

  it("Cleanse with ONLY a teammate's Uprising on you is rejected 400 and leaves it ACTIVE", async () => {
    const { dave, raceId, daveUp } = await sparkedUprising();

    const cleanse = await giveHeld(raceId, dave.userId, "CLEANSE");
    const res = await usePU(dave.token, raceId, cleanse.id);
    assert.equal(res.status, 400);

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: daveUp.id },
    });
    assert.equal(after.status, "ACTIVE", "Uprising untouched by Cleanse");
    assert.equal(after.expiresAt.getTime(), daveUp.expiresAt.getTime());
  });

  it("Quick Rinse with ONLY an Uprising on you is rejected 409 NO_TIMED_DEBUFFS", async () => {
    const { dave, raceId, daveUp } = await sparkedUprising();

    const rinse = await giveHeld(raceId, dave.userId, "QUICK_RINSE");
    const res = await usePU(dave.token, raceId, rinse.id);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "NO_TIMED_DEBUFFS");

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: daveUp.id },
    });
    assert.equal(after.status, "ACTIVE");
  });

  it("Quick Rinse shortens a real timed debuff but not the Uprising alongside it", async () => {
    const { alice, dave, raceId, daveUp } = await sparkedUprising();

    const cramp = await giveHeld(raceId, alice.userId, "LEG_CRAMP", "UNCOMMON");
    const crampRes = await usePU(alice.token, raceId, cramp.id, {
      targetUserId: dave.userId,
    });
    assert.equal(crampRes.status, 200);
    const crampBefore = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "LEG_CRAMP" },
    });

    const rinse = await giveHeld(raceId, dave.userId, "QUICK_RINSE");
    const res = await usePU(dave.token, raceId, rinse.id);
    assert.equal(res.status, 200);
    const body = await res.json();
    // Quick Rinse HALVES the remaining window (rows stay ACTIVE with a nearer
    // expiry) rather than expiring anything — so the property under test is the
    // COUNT it touched and WHOSE expiry moved, not a status flip.
    assert.equal(
      body.result.shortened,
      1,
      "only the leg cramp is rinsed — the Uprising is not counted"
    );
    assert.deepEqual(
      body.result.affectedEffects.map((e) => e.type),
      ["LEG_CRAMP"]
    );

    const crampAfter = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "LEG_CRAMP" },
    });
    assert.ok(
      crampAfter.expiresAt.getTime() < crampBefore.expiresAt.getTime(),
      "the real debuff's window was cut"
    );

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: daveUp.id },
    });
    assert.equal(after.status, "ACTIVE", "Uprising survives the rinse");
    assert.equal(
      after.expiresAt.getTime(),
      daveUp.expiresAt.getTime(),
      "Uprising's window is not cut either"
    );
  });
});
