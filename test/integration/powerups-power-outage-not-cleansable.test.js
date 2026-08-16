const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// ---------------------------------------------------------------------------
// Batch 2026-08-15 item 6 — POWER_OUTAGE joins NON_CLEANSABLE_TYPES.
//
// Power Outage is an opponent-inflicted AoE jam whose rows have exactly the
// shape isOpponentInflicted() reads as "a debuff someone else put on me"
// (sourceUserId = caster, targetUserId = victim), so before this change both
// CLEANSE and QUICK_RINSE treated it as a cleansable debuff.
//
// IMPORTANT precedence note that shapes this whole file: a participant with a
// LIVE Power Outage on them cannot USE ANY POWERUP AT ALL — the Signal Jammer
// jam guard (usePowerup.js ~1043-1058) covers POWER_OUTAGE as well as
// SIGNAL_JAMMER and rejects 409 before Cleanse's own logic is ever reached. So
// the only state in which Cleanse could ever have eaten a Power Outage row is
// the one where the row is still status=ACTIVE but its expiresAt has already
// passed and lazy expiry has not swept it yet — findActiveForParticipant
// filters on status only, and CLEANSE (unlike QUICK_RINSE) does not check
// liveness. That stale-row state is what the exclusion actually changes, so
// this file pins BOTH: the live-outage jam precedence (unchanged, guarded
// against regression) and the stale-row cleanse behavior (the actual change).
//
// Follows the powerups-bounty-not-cleansable.test.js /
// powerups-rally-flag-not-cleansable.test.js pattern: real HTTP, real DB, real
// handler chain, and the outage rows under test are produced by genuinely
// casting Power Outage rather than hand-inserted.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;
let earnCounter = 0;
const HOUR_MS = 60 * 60 * 1000;

// Power Outage is a wave-5 store powerup — needs a powerups5-capable client.
const HEADERS = { "X-Client-Features": "characters,team_races,powerups5" };

async function createUser(displayName) {
  const appleId = `apple-outage-cleanse-${++nextAppleId}`;
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

async function createSoloRace(creator, opponents) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Outage Cleanse Solo",
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

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
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

async function effectRowFor(raceId, type, userId) {
  const p = await participant(raceId, userId);
  return prisma.raceActiveEffect.findFirst({
    where: { raceId, type, targetParticipantId: p.id },
  });
}

describe("Power Outage survives Cleanse and Quick Rinse", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // Bob triggers a Power Outage; Alice is a rival, so ALICE carries the
  // caster-sourced row that used to look cleansable.
  async function outageOnAlice() {
    const alice = await createUser("AliceOutage");
    const bob = await createUser("BobOutage");
    const carol = await createUser("CarolOutage");
    for (const other of [bob, carol]) await makeFriends(alice, other);
    const raceId = await createSoloRace(alice, [bob, carol]);

    const outage = await giveHeld(raceId, bob.userId, "POWER_OUTAGE");
    const res = await usePU(bob.token, raceId, outage.id);
    assert.equal(res.status, 200, "Bob can trigger a Power Outage");
    assert.equal((await res.json()).result.affected, 2);

    const aliceOutage = await effectRowFor(raceId, "POWER_OUTAGE", alice.userId);
    assert.ok(aliceOutage, "Alice got a Power Outage row");
    // The exact shape that made this cleansable. If it ever stops being true,
    // these tests would silently stop testing anything.
    assert.equal(aliceOutage.sourceUserId, bob.userId);
    assert.equal(aliceOutage.targetUserId, alice.userId);
    assert.notEqual(aliceOutage.sourceUserId, aliceOutage.targetUserId);

    return { alice, bob, carol, raceId, aliceOutage };
  }

  // Move the outage row's expiry into the past WITHOUT touching its status.
  // This is the ordinary steady state between a Power Outage lapsing and lazy
  // expiry sweeping the row, and it is the only state in which the victim can
  // fire a Cleanse at all (the jam guard no longer blocks them).
  async function lapseOutage(effectId) {
    return prisma.raceActiveEffect.update({
      where: { id: effectId },
      data: { expiresAt: new Date(Date.now() - 60 * 1000) },
    });
  }

  // ── Live outage: the jam guard wins, nothing is even attempted ────────────

  it("a LIVE Power Outage blocks the victim's Cleanse outright (409 jam) and survives", async () => {
    const { alice, raceId, aliceOutage } = await outageOnAlice();

    const cleanse = await giveHeld(raceId, alice.userId, "CLEANSE");
    const res = await usePU(alice.token, raceId, cleanse.id);
    assert.equal(res.status, 409, "jammed players cannot use any powerup");
    assert.match((await res.json()).error, /jammed/i);

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: aliceOutage.id },
    });
    assert.equal(after.status, "ACTIVE", "Power Outage untouched");
    assert.equal(
      after.expiresAt.getTime(),
      aliceOutage.expiresAt.getTime(),
      "Power Outage window is not truncated"
    );

    const heldAfter = await prisma.racePowerup.findUnique({
      where: { id: cleanse.id },
    });
    assert.equal(heldAfter.status, "HELD", "the Cleanse is not consumed");
  });

  it("a LIVE Power Outage blocks the victim's Quick Rinse outright (409 jam) and survives", async () => {
    const { alice, raceId, aliceOutage } = await outageOnAlice();

    const rinse = await giveHeld(raceId, alice.userId, "QUICK_RINSE");
    const res = await usePU(alice.token, raceId, rinse.id);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /jammed/i);

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: aliceOutage.id },
    });
    assert.equal(after.status, "ACTIVE", "Power Outage untouched");
    assert.equal(
      after.expiresAt.getTime(),
      aliceOutage.expiresAt.getTime()
    );
  });

  // ── Lapsed-but-ACTIVE outage row: the state the exclusion actually changes ─

  it("Cleanse clears a real debuff and leaves the Power Outage row alone", async () => {
    const { alice, bob, raceId, aliceOutage } = await outageOnAlice();

    // Bob (a real opponent) also leg-cramps Alice — a genuine cleansable debuff.
    const cramp = await giveHeld(raceId, bob.userId, "LEG_CRAMP", "UNCOMMON");
    const crampRes = await usePU(bob.token, raceId, cramp.id, {
      targetUserId: alice.userId,
    });
    assert.equal(crampRes.status, 200);

    const lapsed = await lapseOutage(aliceOutage.id);

    const cleanse = await giveHeld(raceId, alice.userId, "CLEANSE");
    const res = await usePU(alice.token, raceId, cleanse.id);
    assert.equal(res.status, 200);
    assert.equal(
      (await res.json()).result.cleared,
      1,
      "only the leg cramp is cleared — the Power Outage is not counted"
    );

    const crampEffect = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "LEG_CRAMP" },
    });
    assert.equal(crampEffect.status, "EXPIRED", "the real debuff is cleared");

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: aliceOutage.id },
    });
    assert.equal(after.status, "ACTIVE", "Power Outage survives the cleanse");
    assert.equal(
      after.expiresAt.getTime(),
      lapsed.expiresAt.getTime(),
      "Power Outage window is not rewritten by the cleanse"
    );
  });

  it("Cleanse with ONLY a Power Outage on you is rejected 400 and consumes nothing", async () => {
    const { alice, raceId, aliceOutage } = await outageOnAlice();
    const lapsed = await lapseOutage(aliceOutage.id);

    const cleanse = await giveHeld(raceId, alice.userId, "CLEANSE");
    const res = await usePU(alice.token, raceId, cleanse.id);
    assert.equal(res.status, 400, "a Power Outage is not a cleansable debuff");
    assert.match((await res.json()).error, /no debuffs to cleanse/i);

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: aliceOutage.id },
    });
    assert.equal(after.status, "ACTIVE", "Power Outage untouched by Cleanse");
    assert.equal(after.expiresAt.getTime(), lapsed.expiresAt.getTime());

    const heldAfter = await prisma.racePowerup.findUnique({
      where: { id: cleanse.id },
    });
    assert.equal(heldAfter.status, "HELD", "the Cleanse is not consumed");
  });

  it("Quick Rinse with ONLY a Power Outage on you is rejected 409 NO_TIMED_DEBUFFS", async () => {
    const { alice, raceId, aliceOutage } = await outageOnAlice();
    const lapsed = await lapseOutage(aliceOutage.id);

    const rinse = await giveHeld(raceId, alice.userId, "QUICK_RINSE");
    const res = await usePU(alice.token, raceId, rinse.id);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "NO_TIMED_DEBUFFS");

    const after = await prisma.raceActiveEffect.findUnique({
      where: { id: aliceOutage.id },
    });
    assert.equal(after.status, "ACTIVE", "Power Outage untouched by Quick Rinse");
    assert.equal(after.expiresAt.getTime(), lapsed.expiresAt.getTime());
  });
});
