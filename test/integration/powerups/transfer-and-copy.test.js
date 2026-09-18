// Canonical powerup integration suite.


// ---- consolidated from powerups-hitchhike-quick-rinse.test.js ----
(function powerups_hitchhike_quick_rinse_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");
// The REAL settlement entry point (the cron job's exported function). Settlement
// has no HTTP surface, so this IS its public path — it is not a shortcut past
// one. Everything asserted below is read back through the API.
const { resolveExpiredRaces } = require("../../../src/modules/races/jobs/raceExpiry");

// Integration coverage for the 2026-07-20 batch (§7, §8, §9.5) against a real DB:
//   * HITCHHIKE — a 60-minute 50% COPY of the target's eligible steps into the
//     caster's score. The target loses nothing, the copy survives repeated reads,
//     Cleanse clamps it, Quick Rinse halves it, and race end truncates the window.
//   * QUICK_RINSE — halves every active timed opponent effect; 409 with none.
//   * GET /powerups/catalog — the copy source of truth.
//
// The copy MATH is exhaustively unit-tested (test/utils/hitchhikeCopies.test.js,
// test/queries/hitchhikeScoring.test.js, including live/settlement parity). Here
// we prove the HTTP wiring, the new enum values, and the gating end to end.

let server;
let nextAppleId = 0;

const POWERUPS3 = { "X-Client-Features": "characters,powerups2,powerups3" };
const HOUR_MS = 60 * 60 * 1000;

async function createUser(displayName) {
  const appleId = `apple-hh-${++nextAppleId}`;
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

// A race that started 4 hours ago, so a [-3h, -2h] effect window sits entirely
// inside CLOSED hour buckets (the in-progress hour is excluded by design).
async function createActiveRace(alice, others) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Hitchhike/QuickRinse",
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      // Max allowed interval, so no box rolls fire mid-test and perturb totals.
      powerupStepInterval: 50000,
    },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((o) => o.userId) },
    token: alice.token,
  });
  for (const other of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: other.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: alice.token,
  });
  const start = new Date(Date.now() - 12 * HOUR_MS);
  await prisma.race.update({
    where: { id: raceId },
    data: { startedAt: start, timezone: "UTC" },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: start },
  });
  return raceId;
}

async function createActiveTeamRace(alice, bob, carol, dave) {
  const headers = { ...POWERUPS3, "X-Client-Features": "characters,powerups3,team_races" };
  const created = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Hitchhike Team Integration",
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 50000,
      isPublic: true,
      isTeamRace: true,
      teamSize: 2,
    },
    token: alice.token,
    headers,
  });
  const raceId = (await created.json()).race.id;
  for (const other of [bob, carol, dave]) {
    const sent = await request(server.baseUrl, "POST", "/friends/request", {
      body: { addresseeId: other.userId }, token: alice.token, headers,
    });
    const friendshipId = (await sent.json()).friendship.id;
    await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
      body: { accept: true }, token: other.token, headers,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: [bob.userId, carol.userId, dave.userId] },
    token: alice.token, headers,
  });
  for (const [user, team] of [[bob, "TEAM_A"], [carol, "TEAM_B"], [dave, "TEAM_B"]]) {
    const response = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true, team }, token: user.token, headers,
    });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
  }
  const started = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: alice.token, headers,
  });
  assert.equal(started.status, 200, JSON.stringify(await started.json()));
  return raceId;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function giveHeld(raceId, userId, type) {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity: "UNCOMMON",
      status: "HELD",
    },
  });
}

// Hourly StepSample buckets, matching how the app uploads them.
async function giveHourlySamples(userId, hoursAgoStart, hourCount, stepsPerHour) {
  const now = Date.now();
  for (let i = 0; i < hourCount; i++) {
    const periodStart = new Date(
      Math.floor((now - (hoursAgoStart - i) * HOUR_MS) / HOUR_MS) * HOUR_MS
    );
    const periodEnd = new Date(periodStart.getTime() + HOUR_MS);
    await prisma.stepSample.create({
      data: {
        userId,
        periodStart,
        periodEnd,
        steps: stepsPerHour,
        sourceName: "healthkit",
      },
    });
  }
}

// Target's own steps after race-end truncation: 8 of 10 hourly samples.
const TARGET_TRUNCATED_TOTAL = 24000;

function windowStartFor(hoursAgo) {
  return new Date(
    Math.floor((Date.now() - hoursAgo * HOUR_MS) / HOUR_MS) * HOUR_MS
  );
}

async function useHitchhike(raceId, caster, targetUserId, headers = POWERUPS3) {
  const pw = await giveHeld(raceId, caster.userId, "HITCHHIKE");
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${pw.id}/use`,
    { body: { targetUserId }, token: caster.token, headers }
  );
}

async function progressFor(raceId, user, headers = POWERUPS3) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
    token: user.token,
    headers,
  });
  return res.json();
}

function totalFor(progress, userId) {
  const row = progress.progress.participants.find((p) => p.userId === userId);
  return row ? row.totalSteps : null;
}

describe("hitchhike / quick rinse — integration", () => {
  before(async () => {
    server = await getSharedServer();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("copies half of the target's eligible steps without touching the target", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    // Bob walks 3,000/hour for the whole race; Alice walks nothing.
    await giveHourlySamples(bob.userId, 11, 10, 3000);

    const res = await useHitchhike(raceId, alice, bob.userId);
    assert.equal(res.status, 200);
    const { result } = await res.json();
    assert.equal(result.outcome, "APPLIED");
    assert.equal(result.effect.type, "HITCHHIKE");
    assert.equal(result.effect.sourceUserId, alice.userId);
    assert.equal(result.effect.targetUserId, bob.userId);
    assert.equal(result.durationMs, HOUR_MS);
    assert.equal(result.copyRatio, 0.5);

    // Backdate the link so its window covers two CLOSED hour buckets.
    const start = windowStartFor(4);
    await prisma.raceActiveEffect.updateMany({
      where: { raceId, type: "HITCHHIKE" },
      data: { startsAt: start, expiresAt: new Date(start.getTime() + 2 * HOUR_MS) },
    });

    const bobBefore = (await participant(raceId, bob.userId)).totalSteps;
    const progress = await progressFor(raceId, alice);
    const aliceTotal = totalFor(progress, alice.userId);
    const bobTotal = totalFor(progress, bob.userId);

    assert.equal(aliceTotal, 3000, "two closed hours of Bob's 3,000/h contribute 50%");
    assert.equal(bobTotal, 30000, "the target keeps every one of their own steps");
    assert.ok(bobTotal >= bobBefore, "the target's total is never reduced");
  });

  it("repeated progress reads never double-credit the caster", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);
    await giveHourlySamples(bob.userId, 11, 10, 3000);
    await useHitchhike(raceId, alice, bob.userId);
    const start = windowStartFor(4);
    await prisma.raceActiveEffect.updateMany({
      where: { raceId, type: "HITCHHIKE" },
      data: { startsAt: start, expiresAt: new Date(start.getTime() + 2 * HOUR_MS) },
    });

    const first = totalFor(await progressFor(raceId, alice), alice.userId);
    await progressFor(raceId, alice);
    const third = totalFor(await progressFor(raceId, alice), alice.userId);
    assert.equal(third, first, "the copy is recomputed, never accumulated");
    assert.equal(first, 3000);
  });

  it("allows Hitchhike to target an eligible teammate in a team race", async () => {
    const [alice, bob, carol, dave] = await Promise.all([
      createUser("Alice Team Hitch"), createUser("Bob Team Hitch"),
      createUser("Carol Team Hitch"), createUser("Dave Team Hitch"),
    ]);
    const raceId = await createActiveTeamRace(alice, bob, carol, dave);
    const result = await useHitchhike(raceId, alice, bob.userId);
    assert.equal(result.status, 200, JSON.stringify(await result.json()));
    const effect = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "HITCHHIKE" },
    });
    assert.deepEqual(
      [effect.sourceUserId, effect.targetUserId],
      [alice.userId, bob.userId],
    );
    const startedAt = new Date(Date.now() - 12 * HOUR_MS);
    await prisma.race.update({ where: { id: raceId }, data: { startedAt, timezone: "UTC" } });
    await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: startedAt } });
    await giveHourlySamples(bob.userId, 11, 10, 1000);
    const windowStart = windowStartFor(4);
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: { startsAt: windowStart, expiresAt: new Date(windowStart.getTime() + 2 * HOUR_MS) },
    });
    const progress = await progressFor(raceId, alice);
    assert.equal(totalFor(progress, alice.userId), 1000);
    assert.equal(totalFor(progress, bob.userId), 10000);
  });

  it("rejects self, cross-race, and non-participant Hitchhike targets", async () => {
    const alice = await createUser("Alice Target Guards");
    const bob = await createUser("Bob Target Guards");
    const outsider = await createUser("Outsider Target Guards");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    const self = await useHitchhike(raceId, alice, alice.userId);
    assert.equal(self.status, 400);
    await self.json();

    const outsiderTarget = await useHitchhike(raceId, alice, outsider.userId);
    assert.equal(outsiderTarget.status, 400);
    await outsiderTarget.json();

    const nonParticipantItem = await giveHeld(raceId, alice.userId, "HITCHHIKE");
    const nonParticipantUse = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${nonParticipantItem.id}/use`,
      { body: { targetUserId: bob.userId }, token: outsider.token, headers: POWERUPS3 },
    );
    assert.equal(nonParticipantUse.status, 403);
    await nonParticipantUse.json();
  });

  it("rejects a second link from the same caster and a second link on the same target", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const carol = await createUser("Carol");
    await makeFriends(alice, bob);
    await makeFriends(alice, carol);
    const raceId = await createActiveRace(alice, [bob, carol]);

    assert.equal((await useHitchhike(raceId, alice, bob.userId)).status, 200);

    // Same caster, different target.
    const second = await useHitchhike(raceId, alice, carol.userId);
    assert.equal(second.status, 409);
    assert.equal((await second.json()).code, "HITCHHIKE_ALREADY_ACTIVE");

    // Different caster, already-linked target.
    const third = await useHitchhike(raceId, carol, bob.userId);
    assert.equal(third.status, 409);
    assert.equal((await third.json()).code, "HITCHHIKE_TARGET_FULL");

    // A rejected use consumes nothing.
    const held = await prisma.racePowerup.count({
      where: { raceId, type: "HITCHHIKE", status: "HELD" },
    });
    assert.equal(held, 2, "both rejected Hitchhikes stay HELD");
  });

  it("two casters on DIFFERENT targets copy independently, with no recursive copying", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const carol = await createUser("Carol");
    const dan = await createUser("Dan");
    for (const other of [bob, carol, dan]) await makeFriends(alice, other);
    const raceId = await createActiveRace(alice, [bob, carol, dan]);

    // Bob and Dan walk; Alice and Carol walk nothing of their own.
    await giveHourlySamples(bob.userId, 11, 10, 3000);
    await giveHourlySamples(dan.userId, 11, 10, 1000);

    await useHitchhike(raceId, alice, bob.userId); // Alice copies Bob
    await useHitchhike(raceId, carol, dan.userId); // Carol copies Dan

    const start = windowStartFor(4);
    await prisma.raceActiveEffect.updateMany({
      where: { raceId, type: "HITCHHIKE" },
      data: { startsAt: start, expiresAt: new Date(start.getTime() + 2 * HOUR_MS) },
    });

    const progress = await progressFor(raceId, alice);
    assert.equal(totalFor(progress, alice.userId), 3000, "Alice copies half of Bob only");
    assert.equal(totalFor(progress, carol.userId), 1000, "Carol copies half of Dan only");
    assert.equal(
      totalFor(progress, dan.userId),
      10000,
      "Dan is unaffected by Alice's link on Bob — copies never chain"
    );
  });

  it("Cleanse clamps a live link (never deletes it) and never reduces the caster's credited total", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);
    await giveHourlySamples(bob.userId, 11, 10, 3000);
    await useHitchhike(raceId, alice, bob.userId);

    const start = windowStartFor(4);
    await prisma.raceActiveEffect.updateMany({
      where: { raceId, type: "HITCHHIKE" },
      data: { startsAt: start, expiresAt: new Date(Date.now() + HOUR_MS) },
    });
    const before = totalFor(await progressFor(raceId, alice), alice.userId);
    assert.ok(before > 0, "some copy has already been credited");

    const cleanse = await giveHeld(raceId, bob.userId, "CLEANSE");
    const res = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${cleanse.id}/use`,
      { token: bob.token, headers: POWERUPS3 }
    );
    assert.equal(res.status, 200);

    const row = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "HITCHHIKE" },
    });
    assert.ok(row, "the effect row is CLAMPED, never deleted");
    assert.equal(row.status, "EXPIRED");
    assert.ok(
      row.expiresAt.getTime() <= Date.now() + 1000,
      "expiresAt is clamped to now"
    );

    const after = totalFor(await progressFor(raceId, alice), alice.userId);
    assert.ok(
      after >= before,
      "already-credited copies survive the cleanse — clamping is never retroactive"
    );
  });

  it("Quick Rinse halves every timed opponent effect (including a live link) and 409s with none", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    // Nothing on Bob yet — Quick Rinse must reject WITHOUT consuming the item.
    const empty = await giveHeld(raceId, bob.userId, "QUICK_RINSE");
    const emptyRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${empty.id}/use`,
      { token: bob.token, headers: POWERUPS3 }
    );
    assert.equal(emptyRes.status, 409);
    assert.equal((await emptyRes.json()).code, "NO_TIMED_DEBUFFS");
    assert.equal(
      (await prisma.racePowerup.findUnique({ where: { id: empty.id } })).status,
      "HELD",
      "the item is retained"
    );

    // Now put a Hitchhike and a Leg Cramp on Bob.
    await useHitchhike(raceId, alice, bob.userId);
    const cramp = await giveHeld(raceId, alice.userId, "LEG_CRAMP");
    await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${cramp.id}/use`,
      { body: { targetUserId: bob.userId }, token: alice.token, headers: POWERUPS3 }
    );

    const before = await prisma.raceActiveEffect.findMany({
      where: { raceId, targetUserId: bob.userId, status: "ACTIVE" },
    });
    const remainingBefore = new Map(
      before.map((e) => [e.id, e.expiresAt.getTime() - Date.now()])
    );

    const rinseRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${empty.id}/use`,
      { token: bob.token, headers: POWERUPS3 }
    );
    assert.equal(rinseRes.status, 200);
    const { result } = await rinseRes.json();
    assert.equal(result.shortened, 2, "both the link and the cramp are halved");
    assert.equal(result.reductionFraction, 0.5);
    assert.equal(result.affectedEffects.length, 2);

    const after = await prisma.raceActiveEffect.findMany({
      where: { raceId, targetUserId: bob.userId, status: "ACTIVE" },
    });
    assert.equal(after.length, 2, "rows stay ACTIVE with a nearer expiry");
    for (const row of after) {
      const remainingAfter = row.expiresAt.getTime() - Date.now();
      const remainingOriginal = remainingBefore.get(row.id);
      assert.ok(
        remainingAfter < remainingOriginal,
        `${row.type} remaining time was cut`
      );
      assert.ok(
        remainingAfter > 0,
        `${row.type} halved expiry is still in the FUTURE — never retroactive`
      );
      assert.ok(
        Math.abs(remainingAfter - remainingOriginal / 2) < 5000,
        `${row.type} remaining time is halved`
      );
      assert.equal(
        row.metadata?.impactBoundaryV1?.endReason,
        "QUICK_RINSE",
        `${row.type} records that its edited boundary is not natural expiry`,
      );
      assert.ok(
        Date.parse(row.metadata?.impactBoundaryV1?.originalExpiresAt || ""),
        `${row.type} preserves its immutable original expiry`,
      );
    }
    assert.ok(
      new Date(result.nextAvailableAt).getTime() > Date.now(),
      "the response advertises when the next rinse unlocks"
    );
  });

  // Owner decision 2026-08-17: one rinse per user per race per hour, derived
  // from the POWERUP_USED feed event the successful rinse wrote.
  it("Quick Rinse is limited to once an hour per race", async () => {
    const alice = await createUser("RinseCdA");
    const bob = await createUser("RinseCdB");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    // One long debuff on Bob. Halving it leaves plenty of remaining time, so it
    // stays rinsable for every attempt below — the only thing that can reject a
    // later attempt is the cooldown itself.
    const cramp = await giveHeld(raceId, alice.userId, "LEG_CRAMP");
    const crampRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${cramp.id}/use`,
      { body: { targetUserId: bob.userId }, token: alice.token, headers: POWERUPS3 }
    );
    assert.equal(crampRes.status, 200);

    const first = await giveHeld(raceId, bob.userId, "QUICK_RINSE");
    const firstRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${first.id}/use`,
      { token: bob.token, headers: POWERUPS3 }
    );
    assert.equal(firstRes.status, 200);

    // A second rinse minutes later is refused, and the item is NOT consumed.
    const second = await giveHeld(raceId, bob.userId, "QUICK_RINSE");
    const secondRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${second.id}/use`,
      { token: bob.token, headers: POWERUPS3 }
    );
    assert.equal(secondRes.status, 409);
    const secondBody = await secondRes.json();
    assert.equal(secondBody.code, "QUICK_RINSE_COOLDOWN");
    assert.match(secondBody.error || secondBody.message || "", /once an hour/i);
    const raceEarnedAfterRejection = await prisma.racePowerup.findUnique({
      where: { id: second.id },
    });
    assert.equal(
      raceEarnedAfterRejection.status,
      "HELD",
      "the item is retained"
    );
    assert.equal(
      raceEarnedAfterRejection.redeemedFromInventory,
      false,
      "a race-earned item is never marked as inventory-redeemed"
    );

    // A store item enters the tray only as an intermediate redemption step.
    // If that immediate use is rejected by the same cooldown, it must return
    // to the account-wide stash rather than becoming stuck in this race.
    await prisma.userPowerupItem.upsert({
      where: {
        userId_powerupType: {
          userId: bob.userId,
          powerupType: "QUICK_RINSE",
        },
      },
      create: {
        userId: bob.userId,
        powerupType: "QUICK_RINSE",
        quantity: 1,
      },
      update: { quantity: { increment: 1 } },
    });
    const redeemRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/redeem`,
      {
        body: { powerupType: "QUICK_RINSE" },
        token: bob.token,
        headers: POWERUPS3,
      }
    );
    assert.equal(redeemRes.status, 200);
    const redeemed = (await redeemRes.json()).result.powerup;
    assert.equal(
      redeemed.redeemedFromInventory,
      true,
      "the redeem path stamps exact inventory provenance"
    );

    const redeemedUseRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${redeemed.id}/use`,
      { token: bob.token, headers: POWERUPS3 }
    );
    assert.equal(redeemedUseRes.status, 409);
    assert.equal((await redeemedUseRes.json()).code, "QUICK_RINSE_COOLDOWN");
    assert.equal(
      (await prisma.racePowerup.findUnique({ where: { id: redeemed.id } })).status,
      "DISCARDED",
      "a rejected redeemed item leaves the race tray"
    );
    assert.equal(
      (
        await prisma.userPowerupItem.findUnique({
          where: {
            userId_powerupType: {
              userId: bob.userId,
              powerupType: "QUICK_RINSE",
            },
          },
        })
      ).quantity,
      1,
      "the rejected redeemed item returns to the global stash"
    );

    // A rinse in a DIFFERENT race is unaffected by this race's cooldown.
    const otherRaceId = await createActiveRace(alice, [bob]);
    const otherCramp = await giveHeld(otherRaceId, alice.userId, "LEG_CRAMP");
    await request(
      server.baseUrl,
      "POST",
      `/races/${otherRaceId}/powerups/${otherCramp.id}/use`,
      { body: { targetUserId: bob.userId }, token: alice.token, headers: POWERUPS3 }
    );
    const otherRinse = await giveHeld(otherRaceId, bob.userId, "QUICK_RINSE");
    const otherRes = await request(
      server.baseUrl,
      "POST",
      `/races/${otherRaceId}/powerups/${otherRinse.id}/use`,
      { token: bob.token, headers: POWERUPS3 }
    );
    assert.equal(otherRes.status, 200, "the cooldown is scoped per race");

    // Backdate the first race's rinse event past the hour: the window reopens.
    await prisma.racePowerupEvent.updateMany({
      where: {
        raceId,
        actorUserId: bob.userId,
        eventType: "POWERUP_USED",
        powerupType: "QUICK_RINSE",
      },
      data: { createdAt: new Date(Date.now() - 61 * 60 * 1000) },
    });
    const thirdRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${second.id}/use`,
      { token: bob.token, headers: POWERUPS3 }
    );
    assert.equal(thirdRes.status, 200, "usable again once the hour has passed");
    assert.equal(
      (await prisma.racePowerup.findUnique({ where: { id: second.id } })).status,
      "USED"
    );
  });

  it("a concurrent Sneaky Swap transfer cannot refund or discard the thief's item", async () => {
    const originalOwner = await createUser("RefundRaceOriginal");
    const thief = await createUser("RefundRaceThief");
    await makeFriends(originalOwner, thief);
    const raceId = await createActiveRace(originalOwner, [thief]);
    const originalParticipant = await participant(raceId, originalOwner.userId);
    const thiefParticipant = await participant(raceId, thief.userId);

    await prisma.userPowerupItem.create({
      data: {
        userId: originalOwner.userId,
        powerupType: "QUICK_RINSE",
        quantity: 1,
      },
    });
    const redeemResponse = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/redeem`,
      {
        body: { powerupType: "QUICK_RINSE" },
        token: originalOwner.token,
        headers: POWERUPS3,
      }
    );
    assert.equal(redeemResponse.status, 200);
    const redeemed = (await redeemResponse.json()).result.powerup;
    assert.equal(redeemed.redeemedFromInventory, true);

    let releaseParticipantLock;
    let markParticipantLocked;
    const participantLocked = new Promise((resolve) => {
      markParticipantLocked = resolve;
    });
    const holdParticipant = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT id
          FROM race_participants
          WHERE id = ${originalParticipant.id}
          FOR UPDATE
        `;
        markParticipantLocked();
        await new Promise((resolve) => {
          releaseParticipantLock = resolve;
        });
      },
      { timeout: 15_000 }
    );
    await participantLocked;

    // The public request locks race -> item -> participants. Holding the final
    // participant lock pins it after it owns the item row but before the
    // NO_TIMED_DEBUFFS rejection rolls its transaction back.
    const rejectedUse = request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${redeemed.id}/use`,
      { token: originalOwner.token, headers: POWERUPS3 }
    );
    const useFinishedBeforeTransferQueued = await Promise.race([
      rejectedUse.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(
      useFinishedBeforeTransferQueued,
      false,
      "the public use is pinned on the participant lock"
    );

    let markTransferred;
    let releaseTransfer;
    const transferred = new Promise((resolve) => {
      markTransferred = resolve;
    });
    const keepTransferOpen = new Promise((resolve) => {
      releaseTransfer = resolve;
    });
    const transfer = prisma.$transaction(
      async (tx) => {
        // Exact ownership mutation used by stealRandomHeldPowerup. This queues
        // behind the public use's item lock, then wins before the refund claim.
        const moved = await tx.racePowerup.updateMany({
          where: {
            id: redeemed.id,
            participantId: originalParticipant.id,
            status: "HELD",
          },
          data: {
            participantId: thiefParticipant.id,
            userId: thief.userId,
            earnedAtSteps: null,
          },
        });
        assert.equal(moved.count, 1);
        markTransferred();
        await keepTransferOpen;
      },
      { timeout: 15_000 }
    );

    const transferredBeforeUseReleased = await Promise.race([
      transferred.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(
      transferredBeforeUseReleased,
      false,
      "the transfer is queued behind the public use's item lock"
    );

    releaseParticipantLock();
    await holdParticipant;
    await transferred;

    // While the transfer is uncommitted, the refund pre-read sees the old
    // committed owner and its subsequent conditional claim queues on this row.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const useFinishedBeforeTransferCommit = await Promise.race([
      rejectedUse.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    assert.equal(useFinishedBeforeTransferCommit, false);

    releaseTransfer();
    await transfer;
    const rejectedResponse = await rejectedUse;
    assert.equal(rejectedResponse.status, 409);
    assert.equal((await rejectedResponse.json()).code, "NO_TIMED_DEBUFFS");

    const after = await prisma.racePowerup.findUnique({
      where: { id: redeemed.id },
    });
    assert.equal(after.status, "HELD", "the thief keeps the transferred item");
    assert.equal(after.userId, thief.userId);
    assert.equal(after.participantId, thiefParticipant.id);
    assert.equal(after.type, "QUICK_RINSE");
    assert.equal(after.redeemedFromInventory, true);
    assert.equal(
      (
        await prisma.userPowerupItem.findUnique({
          where: {
            userId_powerupType: {
              userId: originalOwner.userId,
              powerupType: "QUICK_RINSE",
            },
          },
        })
      ).quantity,
      0,
      "the stale original owner receives no inventory credit"
    );
  });

  // CONTROL: identical setup, but NO hitchhike is ever cast. Whatever Bob scores
  // here is purely race-end truncation of his OWN steps. If this equals what Bob
  // scores in the hitchhike test below, then hitchhike is not taking anything
  // from him and the "target keeps all their own steps" expectation is wrong.
  it("CONTROL: target total with no hitchhike at all", async () => {
    const alice = await createUser("Ctrl");
    const bob = await createUser("CtrlBob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);
    await giveHourlySamples(bob.userId, 11, 10, 3000);

    const start = windowStartFor(4);
    await prisma.race.update({
      where: { id: raceId },
      data: { endsAt: new Date(start.getTime() + HOUR_MS) },
    });

    await resolveExpiredRaces();
    const settled = await progressFor(raceId, alice);
    // 10 hourly samples of 3000 were written at hours-ago 11..2, but the race
    // ends at the top of the hour ~3h ago. The two latest samples begin at or
    // after that half-open boundary, so neither counts. This 24000 is the
    // baseline the hitchhike case below must match EXACTLY.
    assert.equal(
      totalFor(settled, bob.userId),
      TARGET_TRUNCATED_TOTAL,
      "baseline: race-end truncation excludes both post-end hourly samples"
    );
  });

  it("settlement ignores a final-day daily row updated after the deadline", async () => {
    const alice = await createUser("DailyCutoffA");
    const bob = await createUser("DailyCutoffB");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);
    await giveHourlySamples(bob.userId, 11, 10, 3000);

    const endsAt = new Date(windowStartFor(4).getTime() + HOUR_MS);
    const startedAt = new Date(endsAt.getTime() - 36 * HOUR_MS);
    await prisma.race.update({
      where: { id: raceId },
      data: { startedAt, endsAt, timezone: "UTC" },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId },
      data: { joinedAt: startedAt },
    });
    await prisma.step.create({
      data: {
        userId: bob.userId,
        date: new Date(`${endsAt.toISOString().slice(0, 10)}T00:00:00.000Z`),
        steps: 99999,
      },
    });

    await resolveExpiredRaces();
    const settled = await progressFor(raceId, alice);
    assert.equal(settled.progress.status, "COMPLETED");
    assert.equal(totalFor(settled, bob.userId), TARGET_TRUNCATED_TOTAL);
  });

  it("race end truncates the scoring window, as seen in the settled result", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);
    await giveHourlySamples(bob.userId, 11, 10, 3000);
    await useHitchhike(raceId, alice, bob.userId);

    // A 2-hour link window, but the race ends ONE hour into it — so only the
    // first hour of Bob's walking may ever be copied.
    const start = windowStartFor(4);
    await prisma.raceActiveEffect.updateMany({
      where: { raceId, type: "HITCHHIKE" },
      data: { startsAt: start, expiresAt: new Date(start.getTime() + 2 * HOUR_MS) },
    });
    await prisma.race.update({
      where: { id: raceId },
      data: { endsAt: new Date(start.getTime() + HOUR_MS) },
    });

    // Settle through the REAL settlement entry point, then read the result the
    // way a client does. Asserting the scorer's return value directly would only
    // prove the helper clamps; this proves the number a user is finally shown is
    // the clamped one.
    await resolveExpiredRaces();

    const settled = await progressFor(raceId, alice);
    assert.equal(settled.progress.status, "COMPLETED");
    assert.equal(
      totalFor(settled, alice.userId),
      1500,
      "only the hour BEFORE race end is copied, not the full 2-hour window"
    );
    // Hitchhike is a 50% COPY — the target loses nothing to it. This asserts the
    // target's total is byte-identical to the no-hitchhike CONTROL above, which
    // is the actual property worth pinning. It previously asserted 30000 (the
    // raw sample sum), which conflated "hitchhike took nothing" with "the race
    // window took nothing" and failed for a reason that had nothing to do with
    // hitchhike: one of the target's own samples falls after the race ended.
    assert.equal(
      totalFor(settled, bob.userId),
      TARGET_TRUNCATED_TOTAL,
      "the target loses nothing TO THE COPY (same total as with no hitchhike)"
    );
  });

  it("a client without powerups3 sees no Hitchhike effect entry, but the score still applies", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);
    await giveHourlySamples(bob.userId, 11, 10, 3000);
    await useHitchhike(raceId, alice, bob.userId);
    const start = windowStartFor(4);
    await prisma.raceActiveEffect.updateMany({
      where: { raceId, type: "HITCHHIKE" },
      data: { startsAt: start, expiresAt: new Date(start.getTime() + 2 * HOUR_MS) },
    });

    const legacy = await progressFor(raceId, bob, {
      "X-Client-Features": "characters,powerups2",
    });
    const types = (legacy.progress.powerupData?.activeEffects || []).map(
      (e) => e.type
    );
    assert.ok(!types.includes("HITCHHIKE"), "the entry is withheld");
    assert.equal(
      totalFor(legacy, alice.userId),
      3000,
      "the authoritative score is NOT withheld (the accepted §9.3 artifact)"
    );
  });

  it("GET /powerups/catalog serves copy for every user-renderable type", async () => {
    const {
      POWERUP_COPY_SEED,
    } = require("../../../src/modules/powerups/constants/powerupCopySeed");
    for (const row of POWERUP_COPY_SEED) {
      const {
        powerupType,
        name,
        description,
        shortDescription,
        upgradeTierLabels,
      } = row;
      const canonicalCopy = {
        name,
        description,
        shortDescription,
        upgradeTierLabels,
      };
      await prisma.powerupCopy.upsert({
        where: { powerupType },
        update: canonicalCopy,
        create: { powerupType, ...canonicalCopy },
      });
    }

    const res = await request(server.baseUrl, "GET", "/powerups/catalog");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.powerups.length, 39);
    assert.ok(body.version, "version is the max updatedAt");
    const types = body.powerups.map((p) => p.type);
    assert.ok(!types.includes("MYSTERY_BOX"));
    assert.ok(types.includes("HITCHHIKE"));
    assert.ok(types.includes("QUICK_RINSE"));
    const leech = body.powerups.find((p) => p.type === "LEECH");
    assert.match(leech.description, /^For 60 min, /);
    const redCard = body.powerups.find((p) => p.type === "RED_CARD");
    assert.equal(redCard.shortDescription, null);
    assert.deepEqual(redCard.upgradeTierLabels, []);
  });
});

})();


// ---- consolidated from step-sample-leech-granularity.test.js ----
(function step_sample_leech_granularity_test_js(){
// Leech granularity generalization (spec §3.4 / §7 item 4).
//
// The Leech clamp used to exclude the whole in-progress HOUR bucket. It now
// prorates only samples whose periodEnd <= now (exclude any not-yet-closed
// bucket, whatever its size). With 5-min buckets the transfer credits closed
// 5-min buckets of the leecher's walking within the current hour — steps the old
// hour clamp would have wholly deferred — while still excluding a bucket that
// straddles `now`, and stays monotonic as buckets close.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");
const {
  resolveExpiredRaces,
} = require("../../../src/modules/races/jobs/raceExpiry");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-leechgran-${++nextAppleId}`;
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

async function createActiveRace(alice, bob) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Leech granularity",
      targetSteps: 500000,
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
  const start = new Date(Date.now() - 7 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

async function seedSample(userId, startMs, endMs, steps) {
  return prisma.stepSample.create({
    data: {
      userId,
      periodStart: new Date(startMs),
      periodEnd: new Date(endMs),
      steps,
    },
  });
}

// LEECH effect: alice (leecher/source) drains bob (victim/target).
async function seedLeech(raceId, alice, bob, startsAt, expiresAt) {
  const victimP = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
  const backing = await prisma.racePowerup.create({
    data: { raceId, participantId: victimP.id, userId: bob.userId, type: "LEECH", rarity: "UNCOMMON", status: "USED" },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId,
      targetParticipantId: victimP.id,
      targetUserId: bob.userId,
      sourceUserId: alice.userId,
      powerupId: backing.id,
      type: "LEECH",
      status: "ACTIVE",
      startsAt,
      expiresAt,
      metadata: { ratio: 2, scoringVersion: 2 },
    },
  });
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token });
  return (await res.json()).progress;
}
function findUser(progress, userId) {
  return progress.participants.find((p) => p.userId === userId);
}

const MIN = 60 * 1000;

describe("leech granularity — closed-bucket generalization", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); nextAppleId = 0; });

  it("credits closed 5-min buckets and excludes a bucket straddling now", async () => {
    const alice = await createUser("LeechAlice");
    const bob = await createUser("LeechBob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const now = Date.now();
    // Leech active: started 35 min ago, expires 40 min in the future.
    await seedLeech(raceId, alice, bob, new Date(now - 35 * MIN), new Date(now + 40 * MIN));

    // Leecher (alice) closed 5-min buckets — all periodEnd <= now, all inside the
    // current hour that the OLD hour-clamp would have deferred entirely.
    await seedSample(alice.userId, now - 30 * MIN, now - 25 * MIN, 500);
    await seedSample(alice.userId, now - 25 * MIN, now - 20 * MIN, 500);
    await seedSample(alice.userId, now - 20 * MIN, now - 15 * MIN, 500);
    await seedSample(alice.userId, now - 15 * MIN, now - 10 * MIN, 500);
    // A bucket straddling `now` (periodEnd in the future) — must be excluded.
    await seedSample(alice.userId, now - 3 * MIN, now + 7 * MIN, 2000);

    // Victim (bob) has plenty of drainable balance from an old closed bucket.
    await seedSample(bob.userId, now - 5 * 60 * MIN, now - 4 * 60 * MIN, 10000);

    const progress = await getProgress(bob.token, raceId);
    const bobP = findUser(progress, bob.userId);
    // Closed leecher steps = 2000 -> earnedTransfer = floor(2000/2) = 1000.
    // The straddling bucket (2000) is EXCLUDED, so bob is drained by exactly 1000.
    assert.equal(bobP.totalSteps, 10000 - 1000);
  });

  it("is monotonic: as the straddling bucket closes, the transfer does not shrink", async () => {
    const alice = await createUser("LeechAlice2");
    const bob = await createUser("LeechBob2");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const now = Date.now();
    await seedLeech(raceId, alice, bob, new Date(now - 35 * MIN), new Date(now + 40 * MIN));
    await seedSample(alice.userId, now - 30 * MIN, now - 25 * MIN, 500);
    await seedSample(alice.userId, now - 25 * MIN, now - 20 * MIN, 500);
    await seedSample(alice.userId, now - 20 * MIN, now - 15 * MIN, 500);
    await seedSample(alice.userId, now - 15 * MIN, now - 10 * MIN, 500);
    const straddler = await seedSample(alice.userId, now - 3 * MIN, now + 7 * MIN, 2000);
    await seedSample(bob.userId, now - 5 * 60 * MIN, now - 4 * 60 * MIN, 10000);

    const first = findUser(await getProgress(bob.token, raceId), bob.userId).totalSteps;

    // The straddling bucket matures into a closed bucket (periodEnd now in the
    // past) — as would happen on the next sync. Its steps now count.
    await prisma.stepSample.update({
      where: { id: straddler.id },
      data: { periodEnd: new Date(Date.now() - 1000) },
    });

    const second = findUser(await getProgress(bob.token, raceId), bob.userId).totalSteps;
    // Victim's total is non-increasing (the leech transfer is non-decreasing).
    assert.ok(second <= first, `transfer must not shrink: first drain->${first}, second->${second}`);
    assert.ok(second < first, "the now-closed bucket increases the transfer");
  });

  it("settles an expired race when a Leech reads a different participant's samples", async () => {
    const alice = await createUser("LeechSettlementSource");
    const bob = await createUser("LeechSettlementTarget");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const now = Date.now();
    const windowStart = new Date(now - 4 * 60 * MIN);
    const windowEnd = new Date(now - 2 * 60 * MIN);
    await seedLeech(raceId, alice, bob, windowStart, windowEnd);
    await seedSample(
      alice.userId,
      now - 4 * 60 * MIN,
      now - 3 * 60 * MIN,
      2000,
    );
    await seedSample(
      bob.userId,
      now - 5 * 60 * MIN,
      now - 4 * 60 * MIN,
      10000,
    );
    await prisma.race.update({
      where: { id: raceId },
      data: { endsAt: new Date(now - MIN) },
    });

    await resolveExpiredRaces();

    const settled = await getProgress(bob.token, raceId);
    assert.equal(
      settled.status,
      "COMPLETED",
      "settlement must prepare the Leech source while scoring its target",
    );
    assert.equal(findUser(settled, bob.userId).totalSteps, 9000);
    const impact = await prisma.raceEffectImpact.findFirst({
      where: { raceId, userId: bob.userId, powerupType: "LEECH" },
    });
    assert.equal(
      impact?.deltaSteps,
      -1000,
      "the same prepared source must remain available to settlement attribution",
    );
  });
});

})();

// ---- consolidated from hitchhike-settlement-parity.test.js ----
(function hitchhike_settlement_parity_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");
const { appSettings } = require("../../../src/shared/config/appSettings");
// The REAL settlement entry point (the cron job's exported function). Settlement
// has no HTTP surface, so this IS its public path. Every number asserted below is
// read back through the API — the scorer is never called directly.
const { resolveExpiredRaces } = require("../../../src/modules/races/jobs/raceExpiry");

// ---------------------------------------------------------------------------
// §12 — HITCHHIKE display and final settlement agree for the same fixture.
//
// WHY THIS CANNOT BE A UNIT TEST. Two other guards already exist and neither
// covers this:
//   * the STRUCTURAL guard proves every assembly site CALLS applyHitchhikeCopies;
//   * the unit parity test proves the scorer is DETERMINISTIC given identical
//     inputs.
// Neither proves the settlement path invokes it with the same ARGUMENTS, MODELS
// and CLOCK the live path uses. A site could pass both while handing the scorer
// a different timezone, a different `now`, an unscoped effect model, or an
// endsAt-clamped window the live path doesn't apply — and the failure would
// surface to a user as their score visibly CHANGING the instant their race ends.
// Only running a real race to settlement can catch that.
//
// The fixture is deliberately sized so that BOTH failure modes are detectable:
//   Alice walks 2,000 and hitchhikes Bob, copying 4,000  -> pre-leech 6,000
//   Carol leeches Alice, earning floor(10,000 / 2) = 5,000 -> Alice settles at 1,000
// If settlement dropped the copy:        max(0, 2,000 - 5,000)          = 0
// If settlement applied it AFTER leech:  max(0, 2,000 - 5,000) + 4,000  = 4,000
// Only the correct ordering — copy folded into preLeechTotal BEFORE the leech
// resolution — yields 1,000.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

const FEAT = {
  // team_races is needed for the mid-race forfeit case below (forfeit is a
  // team-race feature and its create path is capability-gated).
  "X-Client-Features": "characters,powerups2,powerups3,team_races",
};
const HEADERS = { ...FEAT, "X-Timezone": "UTC" };
const HOUR_MS = 60 * 60 * 1000;

async function createUser(displayName) {
  const appleId = `apple-parity-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  // TR-706: any authed request carrying the header records the user's last-seen
  // capability tokens. Without this an invite to a team race is rejected with
  // INVITEE_NEEDS_UPDATE, because the invitee has nothing recorded.
  await request(server.baseUrl, "GET", "/auth/me", {
    token: body.sessionToken,
    headers: HEADERS,
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

// Whole hourly buckets, exactly as the app uploads them, aligned to hour
// boundaries so every bucket in the effect window is CLOSED.
async function giveHourlyBucket(userId, hoursAgo, steps) {
  const periodStart = new Date(
    Math.floor((Date.now() - hoursAgo * HOUR_MS) / HOUR_MS) * HOUR_MS
  );
  await prisma.stepSample.create({
    data: {
      userId,
      periodStart,
      periodEnd: new Date(periodStart.getTime() + HOUR_MS),
      steps,
      sourceName: "healthkit",
    },
  });
}

function hourFloor(hoursAgo) {
  return new Date(
    Math.floor((Date.now() - hoursAgo * HOUR_MS) / HOUR_MS) * HOUR_MS
  );
}

async function giveHeld(raceId, userId, type) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity: "UNCOMMON",
      status: "HELD",
    },
  });
}

async function usePowerup(raceId, actor, powerupId, body) {
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/use`,
    { body, token: actor.token, headers: HEADERS }
  );
}

async function totalsViaApi(raceId, viewer) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
    token: viewer.token,
    headers: HEADERS,
  });
  const body = await res.json();
  const totals = {};
  for (const p of body.progress.participants) totals[p.userId] = p.totalSteps;
  return { status: body.progress.status, totals };
}

describe("hitchhike live-vs-settlement parity — integration", () => {
  before(async () => {
    server = await getSharedServer();
  });
  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    await appSettings.setFlag("teamRacesEnabled", true);
  });

  it("the caster's live total survives settlement unchanged, with hitchhike ordered before leech", async () => {
    const alice = await createUser("Alice"); // hitchhikes Bob, leeched by Carol
    const bob = await createUser("Bob"); // walked on
    const carol = await createUser("Carol"); // leeches Alice
    await makeFriends(alice, bob);
    await makeFriends(alice, carol);

    const createRes = await request(server.baseUrl, "POST", "/races", {
      body: {
        name: "Parity",
        targetSteps: 500000,
        maxDurationDays: 7,
        powerupsEnabled: true,
        powerupStepInterval: 50000,
      },
      token: alice.token,
      headers: HEADERS,
    });
    const raceId = (await createRes.json()).race.id;
    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      body: { inviteeIds: [bob.userId, carol.userId] },
      token: alice.token,
      headers: HEADERS,
    });
    for (const user of [bob, carol]) {
      await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        body: { accept: true },
        token: user.token,
        headers: HEADERS,
      });
    }
    await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
      token: alice.token,
      headers: HEADERS,
    });

    // Race started 12h ago in a canonical UTC tz, so live and settlement bucket
    // days identically (raceTimeZone(race, ...) resolves to UTC on both paths).
    const start = hourFloor(12);
    await prisma.race.update({
      where: { id: raceId },
      data: { startedAt: start, timezone: "UTC" },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId },
      data: { joinedAt: start },
    });

    // Steps, all inside CLOSED hourly buckets in [-4h, -2h].
    await giveHourlyBucket(bob.userId, 4, 2000); // Bob: 4,000 total, all in-window
    await giveHourlyBucket(bob.userId, 3, 2000);
    await giveHourlyBucket(alice.userId, 6, 2000); // Alice: 2,000 of her own
    await giveHourlyBucket(carol.userId, 4, 5000); // Carol: 10,000, all in-window
    await giveHourlyBucket(carol.userId, 3, 5000);

    // Alice hitchhikes Bob; Carol leeches Alice. Both through the real endpoint.
    const hh = await giveHeld(raceId, alice.userId, "HITCHHIKE");
    const hhRes = await usePowerup(raceId, alice, hh.id, {
      targetUserId: bob.userId,
    });
    assert.equal(hhRes.status, 200);

    const leech = await giveHeld(raceId, carol.userId, "LEECH");
    const leechRes = await usePowerup(raceId, carol, leech.id, {
      targetUserId: alice.userId,
    });
    assert.equal(leechRes.status, 200);

    // Align both effect windows to the same closed 2-hour span.
    const windowStart = hourFloor(4);
    const windowEnd = hourFloor(2);
    await prisma.raceActiveEffect.updateMany({
      where: { raceId, type: { in: ["HITCHHIKE", "LEECH"] } },
      data: { startsAt: windowStart, expiresAt: windowEnd },
    });

    // ── LIVE: the number the client is shown mid-race ──────────────────────
    const live = await totalsViaApi(raceId, alice);
    assert.equal(live.status, "ACTIVE");
    assert.equal(
      live.totals[alice.userId],
      0,
      "2,000 walked + 2,000 copied = 4,000 pre-leech, then Carol drains 4,000 to the floor"
    );
    assert.equal(live.totals[bob.userId], 4000, "the target loses nothing");
    assert.equal(
      live.totals[carol.userId],
      14000,
      "10,000 walked + 4,000 drained from Alice after her Hitchhike copy"
    );

    // ── SETTLE through the real settlement path ───────────────────────────
    await prisma.race.update({
      where: { id: raceId },
      data: { endsAt: new Date(Date.now() - 60 * 1000) },
    });
    await resolveExpiredRaces();

    // ── SETTLED: the number the client is shown after the race ends ───────
    const settled = await totalsViaApi(raceId, alice);
    assert.equal(settled.status, "COMPLETED", "the race really settled");

    assert.deepEqual(
      settled.totals,
      live.totals,
      "PARITY: every settled total must equal the live total a client was already shown. A mismatch here is a user watching their score change the moment the race ended."
    );

    // Pin the exact ordering, so a regression that reorders the terms fails with
    // a specific number rather than only as a parity mismatch.
    assert.equal(
      settled.totals[alice.userId],
      0,
      "Alice settles at the same floor as live scoring; Carol's 14,000 total above proves the 2,000 Hitchhike copy entered preLeechTotal before the drain resolved"
    );

    // And the persisted row agrees with what the API reports.
    const persisted = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: alice.userId },
    });
    assert.equal(persisted.totalSteps, settled.totals[alice.userId]);
  });

  it("a caster who forfeits keeps the copy already accrued in their frozen total", async () => {
    // forfeitRace freezes a final total that feeds standings and payouts, so a
    // dropped copy there would silently delete steps the caster had already been
    // shown. Team race, because mid-race forfeit is a team-race feature.
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await makeFriends(alice, bob);

    const createRes = await request(server.baseUrl, "POST", "/races", {
      body: {
        name: "Forfeit parity",
        targetSteps: 500000,
        maxDurationDays: 7,
        powerupsEnabled: true,
        powerupStepInterval: 50000,
        isTeamRace: true,
        teamSize: 1,
      },
      token: alice.token,
      headers: HEADERS,
    });
    const created = await createRes.json();
    assert.ok(created.race, `team race created: ${JSON.stringify(created)}`);
    const raceId = created.race.id;
    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      body: { inviteeIds: [bob.userId] },
      token: alice.token,
      headers: HEADERS,
    });
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: bob.token,
      headers: HEADERS,
    });
    await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
      token: alice.token,
      headers: HEADERS,
    });

    const start = hourFloor(12);
    await prisma.race.update({
      where: { id: raceId },
      data: { startedAt: start, timezone: "UTC" },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId },
      data: { joinedAt: start },
    });

    await giveHourlyBucket(bob.userId, 4, 3000);
    await giveHourlyBucket(alice.userId, 6, 1000);

    const hh = await giveHeld(raceId, alice.userId, "HITCHHIKE");
    assert.equal(
      (await usePowerup(raceId, alice, hh.id, { targetUserId: bob.userId }))
        .status,
      200
    );
    await prisma.raceActiveEffect.updateMany({
      where: { raceId, type: "HITCHHIKE" },
      data: { startsAt: hourFloor(4), expiresAt: hourFloor(2) },
    });

    const live = await totalsViaApi(raceId, alice);
    assert.equal(
      live.totals[alice.userId],
      2500,
      "1,000 walked + 1,500 copied"
    );

    // Alice forfeits — her total is frozen at this instant, through the real
    // endpoint.
    const forfeitRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/forfeit`,
      { token: alice.token, headers: HEADERS }
    );
    const fbody = await forfeitRes.json();
    assert.equal(forfeitRes.status, 200, JSON.stringify(fbody));

    const frozen = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: alice.userId },
    });
    assert.ok(frozen.forfeitedAt, "she really forfeited");
    assert.equal(
      frozen.totalSteps,
      2500,
      "the frozen total RETAINS the accrued 50% copy — dropping it would silently delete steps she had already been shown"
    );
  });
});

})();

// ---- consolidated from powerups-batch-leech-xray.test.js ----
(function powerups_batch_leech_xray_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");
const { buildDomainEventProjectionJob } = require("../../../src/modules/domainEvents");
const { appSettings } = require("../../../src/shared/config/appSettings");

// Integration coverage for the 2026-07-17 backend batch:
//   * Item 1 — POST /races/:id/powerups/open-batch ("Open All Boxes")
//   * Item 2 — LEECH use (effect + victim visibility + feed) and X-Ray
//     (DEFENSE_SCAN) recon response.
// Leech/X-Ray scoring math is exhaustively unit-tested (test/queries/
// leechScoring.test.js, with settlement parity); here we prove the HTTP wiring,
// the new enum values, and the powerups2 gating work end-to-end on a real DB.

let server;
let nextAppleId = 0;

const POWERUPS2 = { "X-Client-Features": "characters,powerups2" };

async function createUser(displayName) {
  const appleId = `apple-blx-${++nextAppleId}`;
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

async function createActiveRace(alice, bob) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Batch/Leech/XRay",
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
  const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function giveBox(raceId, userId, status, earnedAtSteps) {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: { raceId, participantId: p.id, userId, type: null, rarity: null, status, earnedAtSteps },
  });
}

async function giveHeld(raceId, userId, type) {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: { raceId, participantId: p.id, userId, type, rarity: "UNCOMMON", status: "HELD" },
  });
}

async function giveActiveEffect(raceId, targetUserId, type) {
  const p = await participant(raceId, targetUserId);
  // raceActiveEffect.powerupId is a required FK — back it with a USED powerup row.
  const backing = await prisma.racePowerup.create({
    data: { raceId, participantId: p.id, userId: targetUserId, type, rarity: "UNCOMMON", status: "USED" },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId, targetParticipantId: p.id, targetUserId, sourceUserId: targetUserId,
      powerupId: backing.id,
      type, status: "ACTIVE", startsAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
}

describe("open-batch / leech / x-ray — integration", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => {
    await cleanDatabase();
    await appSettings.setFlag("apiInboxV1Enabled", true);
  });

  it("open-batch opens all slot boxes + queued overflow in one call", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // Fill the 3 slots with mystery boxes + 2 queued overflow boxes.
    const b1 = await giveBox(raceId, alice.userId, "MYSTERY_BOX", 5000);
    const b2 = await giveBox(raceId, alice.userId, "MYSTERY_BOX", 10000);
    const b3 = await giveBox(raceId, alice.userId, "MYSTERY_BOX", 15000);
    await giveBox(raceId, alice.userId, "QUEUED", 20000);
    await giveBox(raceId, alice.userId, "QUEUED", 25000);

    const res = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/open-batch`, {
      body: { powerupIds: [b1.id, b2.id, b3.id], includeQueued: true, maxCount: 20 },
      token: alice.token,
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.results.length, 5, "3 slot + 2 queued boxes opened");
    assert.equal(body.results.filter((r) => r.queued).length, 2);
    assert.ok(body.results.every((r) => typeof r.type === "string"));
    assert.equal(body.remainingQueuedBoxCount, 0);
    assert.equal(body.powerupSlots, 3);

    // Every box row is now opened (HELD or auto-activated USED) — none left QUEUED/MYSTERY_BOX.
    const leftover = await prisma.racePowerup.count({
      where: { raceId, userId: alice.userId, status: { in: ["MYSTERY_BOX", "QUEUED"] } },
    });
    assert.equal(leftover, 0);
  });

  it("open-batch never opens another user's boxes", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const bobBox = await giveBox(raceId, bob.userId, "MYSTERY_BOX", 5000);
    const res = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/open-batch`, {
      body: { powerupIds: [bobBox.id], includeQueued: false },
      token: alice.token,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.results.length, 0, "alice cannot open bob's box");
    const bobBoxRow = await prisma.racePowerup.findUnique({ where: { id: bobBox.id } });
    assert.equal(bobBoxRow.status, "MYSTERY_BOX", "bob's box is untouched");
  });

  it("LEECH use: effect targets the victim, is visible on their row, and posts a feed event", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const leech = await giveHeld(raceId, alice.userId, "LEECH");
    const useRes = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${leech.id}/use`, {
      body: { targetUserId: bob.userId },
      token: alice.token,
      headers: POWERUPS2,
    });
    assert.equal(useRes.status, 200);

    // Effect row targets the victim, sourced by the leecher, ~30 min window.
    const eff = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEECH", status: "ACTIVE" } });
    assert.ok(eff, "a LEECH effect exists");
    assert.equal(eff.targetUserId, bob.userId);
    assert.equal(eff.sourceUserId, alice.userId);
    const windowMin = Math.round((new Date(eff.expiresAt) - new Date(eff.startsAt)) / 60000);
    assert.equal(windowMin, 30);

    // NOT stealthy: the victim sees the LEECH badge in their activeEffects.
    const progRes = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token: bob.token });
    const prog = (await progRes.json()).progress;
    const leechBadge = (prog.powerupData?.activeEffects || []).find((e) => e.type === "LEECH");
    assert.ok(leechBadge, "victim sees the LEECH effect on their row");
    assert.equal(leechBadge.onSelf, true);

    // A feed event is written (drives the push).
    const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: bob.token });
    const feed = await feedRes.json();
    assert.ok(feed.events.find((e) => e.eventType === "POWERUP_USED" && e.powerupType === "LEECH"));

    assert.equal(await prisma.domainEventOutbox.count({
      where: { eventType: "POWERUP_USED_V1", aggregateId: leech.id },
    }), 1, "the real HTTP powerup command commits its durable notification event");
    await buildDomainEventProjectionJob({
      logger: { log() {}, warn() {}, error() {} },
    })();
    const alert = await prisma.inboxAlert.findFirstOrThrow({
      where: { userId: bob.userId, type: "POWERUP_USED" },
    });
    assert.deepEqual(alert.destination, { route: "raceDetail", raceId });
  });

  it("X-Ray (DEFENSE_SCAN) use returns each opponent's active defenses at the top level", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    await giveActiveEffect(raceId, bob.userId, "COMPRESSION_SOCKS");
    await giveActiveEffect(raceId, bob.userId, "DECOY");
    const xray = await giveHeld(raceId, alice.userId, "DEFENSE_SCAN");

    const res = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${xray.id}/use`, {
      body: {},
      token: alice.token,
      headers: POWERUPS2,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.scan, "scan present at the top level");
    const bobEntry = body.scan.opponents.find((o) => o.userId === bob.userId);
    assert.ok(bobEntry);
    assert.deepEqual(bobEntry.defenses.map((d) => d.type), ["COMPRESSION_SOCKS", "DECOY"]);

    // Consumed, and silent recon => no LEECH/scan effect leaked to others.
    const used = await prisma.racePowerup.findUnique({ where: { id: xray.id } });
    assert.equal(used.status, "USED");
  });

  it("open-batch persists MYSTERY_BOX_OPENED audit rows (Item 9) but hides them from the feed", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const b1 = await giveBox(raceId, alice.userId, "MYSTERY_BOX", 5000);
    await request(server.baseUrl, "POST", `/races/${raceId}/powerups/open-batch`, {
      body: { powerupIds: [b1.id] },
      token: alice.token,
    });

    const opened = await prisma.racePowerupEvent.count({ where: { raceId, eventType: "MYSTERY_BOX_OPENED" } });
    assert.ok(opened >= 1, "a MYSTERY_BOX_OPENED audit row is written");

    const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
    const feed = await feedRes.json();
    assert.ok(!feed.events.find((e) => e.eventType === "MYSTERY_BOX_OPENED"), "audit rows are hidden from the feed");
  });
});

})();
