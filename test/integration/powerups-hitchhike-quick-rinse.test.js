const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
// The REAL settlement entry point (the cron job's exported function). Settlement
// has no HTTP surface, so this IS its public path — it is not a shortcut past
// one. Everything asserted below is read back through the API.
const { resolveExpiredRaces } = require("../../src/modules/races/jobs/raceExpiry");

// Integration coverage for the 2026-07-20 batch (§7, §8, §9.5) against a real DB:
//   * HITCHHIKE — a 60-minute 1:1 COPY of the target's raw steps into the
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

// Target's own steps after race-end truncation: 9 of 10 hourly samples.
const TARGET_TRUNCATED_TOTAL = 27000;

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

  it("copies the target's raw steps into the caster's score without touching the target", async () => {
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
    assert.equal(result.copyRatio, 1);

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

    assert.equal(aliceTotal, 6000, "two closed hours of Bob's 3,000/h were copied");
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
    assert.equal(first, 6000);
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
    assert.equal(totalFor(progress, alice.userId), 6000, "Alice copies Bob only");
    assert.equal(totalFor(progress, carol.userId), 2000, "Carol copies Dan only");
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
    }
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
    // ends ~3h ago, so the latest sample lies entirely outside the race window
    // and is correctly not counted. This 27000 is the baseline the hitchhike
    // case below must match EXACTLY.
    assert.equal(
      totalFor(settled, bob.userId),
      TARGET_TRUNCATED_TOTAL,
      "baseline: race-end truncation alone costs the target one hourly sample"
    );
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
      3000,
      "only the hour BEFORE race end is copied, not the full 2-hour window"
    );
    // Hitchhike is a 1:1 COPY — the target loses nothing to it. This asserts the
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
      6000,
      "the authoritative score is NOT withheld (the accepted §9.3 artifact)"
    );
  });

  it("GET /powerups/catalog serves copy for every user-renderable type", async () => {
    const {
      POWERUP_COPY_SEED,
    } = require("../../src/modules/powerups/constants/powerupCopySeed");
    for (const row of POWERUP_COPY_SEED) {
      await prisma.powerupCopy.upsert({
        where: { powerupType: row.powerupType },
        update: {},
        create: row,
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
