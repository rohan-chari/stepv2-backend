// Late-night race start must not silently disable buff scoring for the whole race.
//
// 2026-07-26 incident ("yeast infection", started 10:44 PM ET). `hasSampleData`
// is derived from samples in [effectiveStart, end of that RACE-LOCAL day]. A race
// that starts late at night gives a ~76-minute window, at night, when nobody
// walks — so the flag evaluates false and pins the ENTIRE race to
// computeEffectModifiersFallback, permanently, even once the player has rich
// 5-minute data days later.
//
// On that fallback a buff is `max(0, stepsAtExpiry - stepsAtBuffStart)`, but the
// two snapshots are written on DIFFERENT scales:
//   * stepsAtBuffStart = participant.totalSteps  (EFFECTIVE total, usePowerup.js)
//   * stepsAtExpiry    = baseAdjusted            (RAW total, getRaceProgress.js:338/353)
// so the subtraction goes negative and clamps to ZERO. Leech is worse: the
// fallback returns `leechTransfers: []` unconditionally.
//
// Net effect for affected players: Runner's High, Ghost Pepper and Leech are all
// worth nothing, while debuffs against them still land. 17 of 137 active
// participants were in this state when this was found.
//
// The existing scoring suites cannot catch it: their `createActiveRace` always
// sets `startedAt = Date.now() - 8h` (mid-day, wide window, samples seeded into
// it), so hasSampleData is ALWAYS true and the fallback branch never runs. Their
// fixtures also use `stepsAtBoostStart: 0`, which makes the subtraction positive
// and hides the scale mismatch a second time. This file deliberately does both
// of the things they don't.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;
let earnCounter = 0;
const HOUR_MS = 60 * 60 * 1000;
const P5 = { "X-Client-Features": "characters,powerups3,powerups4,powerups5" };

const alignedHoursAgo = (h) =>
  new Date(Math.floor((Date.now() - h * HOUR_MS) / HOUR_MS) * HOUR_MS);

async function createUser(displayName) {
  const appleId = `apple-night-${++nextAppleId}`;
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

// A race whose start is LATE AT NIGHT in the race timezone, several days back —
// the shape that breaks. Returns the raceId.
async function createNightStartRace(alice, opponents) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Night Start Race",
      targetSteps: 500000,
      maxDurationDays: 14,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: opponents.map((o) => o.userId) },
    token: alice.token,
  });
  for (const o of opponents) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });

  // 3 days ago at 02:44 UTC == 22:44 America/New_York the previous evening —
  // exactly the prod shape. The start-day window is then ~76 minutes of night.
  const d = new Date(Date.now() - 3 * 24 * HOUR_MS);
  d.setUTCHours(2, 44, 0, 0);
  await prisma.race.update({
    where: { id: raceId },
    data: { startedAt: d, endsAt: new Date(Date.now() + 7 * 24 * HOUR_MS), timezone: "America/New_York" },
  });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: d } });
  return raceId;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function giveEffect(raceId, targetUserId, sourceUserId, type, { startsAt, expiresAt, metadata } = {}) {
  const p = await participant(raceId, targetUserId);
  const src = await participant(raceId, sourceUserId);
  const pw = await prisma.racePowerup.create({
    data: {
      raceId,
      participantId: src.id,
      userId: sourceUserId,
      type,
      rarity: "UNCOMMON",
      status: "USED",
      earnedAtSteps: ++earnCounter,
    },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId,
      targetParticipantId: p.id,
      targetUserId,
      sourceUserId,
      powerupId: pw.id,
      type,
      status: "ACTIVE",
      startsAt,
      expiresAt,
      metadata: metadata || {},
    },
  });
}

async function giveHourlySamples(userId, hoursAgoStart, hourCount, stepsPerHour) {
  const now = Date.now();
  for (let i = 0; i < hourCount; i++) {
    const periodStart = new Date(
      Math.floor((now - (hoursAgoStart - i) * HOUR_MS) / HOUR_MS) * HOUR_MS
    );
    const periodEnd = new Date(periodStart.getTime() + HOUR_MS);
    await prisma.stepSample.upsert({
      where: { userId_periodStart: { userId, periodStart } },
      update: { steps: stepsPerHour, periodEnd },
      create: { userId, periodStart, periodEnd, steps: stepsPerHour, sourceName: "healthkit" },
    });
  }
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
    token,
    headers: P5,
  });
  return (await res.json()).progress;
}

function boardSteps(progress, userId) {
  return (progress.participants || []).find((p) => p.userId === userId)?.totalSteps;
}

describe("late-night race start — buff scoring must still work", () => {
  before(async () => {
    server = await getSharedServer();
  });
  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("scores Runner's High even though the race started at night with no start-day samples", async () => {
    const a = await createUser("NightA");
    const b = await createUser("NightB");
    await makeFriends(a, b);
    const raceId = await createNightStartRace(a, [b]);

    // Steps TODAY only — deliberately nothing on the race's start day, which is
    // what a sleeping player looks like.
    await giveHourlySamples(a.userId, 4, 1, 100); // [4h, 3h)

    await giveEffect(raceId, a.userId, a.userId, "RUNNERS_HIGH", {
      startsAt: alignedHoursAgo(4),
      expiresAt: alignedHoursAgo(3),
      // Realistic non-zero snapshot on the EFFECTIVE scale, as usePowerup writes it.
      metadata: { stepsAtBuffStart: 50000 },
    });

    const total = boardSteps(await getProgress(a.token, raceId), a.userId);
    // 100 real steps at 2x = 200. The exact figure matters less than the buff
    // being worth SOMETHING — a zero here is the bug.
    assert.ok(
      total > 100,
      `Runner's High scored nothing: total=${total} (expected >100 for 100 steps at 2x)`
    );
    assert.equal(total, 200, "100 steps at 2x should be 200");
  });

  it("scores Ghost Pepper's boost half on a night-started race", async () => {
    const a = await createUser("NightC");
    const b = await createUser("NightD");
    await makeFriends(a, b);
    const raceId = await createNightStartRace(a, [b]);

    await giveHourlySamples(a.userId, 4, 1, 100); // boost hour [4h,3h)

    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", {
      startsAt: alignedHoursAgo(4),
      expiresAt: alignedHoursAgo(2),
      metadata: {
        boostMs: HOUR_MS,
        freezeMs: HOUR_MS,
        multiplier: 3,
        stepsAtBoostStart: 50000, // non-zero, effective scale
      },
    });

    const total = boardSteps(await getProgress(a.token, raceId), a.userId);
    assert.ok(total > 100, `Ghost Pepper scored nothing: total=${total}`);
    assert.equal(total, 300, "100 steps at 3x should be 300");
  });

  // The asymmetry that makes this actively unfair: on the broken path debuffs
  // still landed while the victim's own buffs were worth zero. Pin that a freeze
  // and a buff are BOTH honoured on a night-started race.
  it("applies a debuff and a buff consistently on a night-started race", async () => {
    const a = await createUser("NightE");
    const b = await createUser("NightF");
    await makeFriends(a, b);
    const raceId = await createNightStartRace(a, [b]);

    // Deliberately UNEQUAL hours. With 100/100 the broken path (buff 0 AND
    // freeze 0 => raw 200) coincidentally matches the correct path
    // (100x2 + 100x0 = 200) and the test passes while the bug is present.
    // 100 in the buff hour and 300 in the frozen hour separates them:
    //   correct => 100*2 + 300*0 = 200
    //   broken  => raw 400, nothing applied = 400
    await giveHourlySamples(a.userId, 4, 1, 100); // [4h,3h) buff hour
    await giveHourlySamples(a.userId, 3, 1, 300); // [3h,2h) frozen hour

    await giveEffect(raceId, a.userId, a.userId, "RUNNERS_HIGH", {
      startsAt: alignedHoursAgo(4),
      expiresAt: alignedHoursAgo(3),
      metadata: { stepsAtBuffStart: 50000 },
    });
    await giveEffect(raceId, a.userId, b.userId, "LEG_CRAMP", {
      startsAt: alignedHoursAgo(3),
      expiresAt: alignedHoursAgo(2),
      metadata: { stepsAtFreezeStart: 50000 },
    });

    const total = boardSteps(await getProgress(a.token, raceId), a.userId);
    assert.equal(total, 200, "buff hour doubles (200), frozen hour zeroes (0)");
  });
});
