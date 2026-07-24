// Open (not-yet-closed) step buckets must not drive effect scoring.
//
// Prod incident (Maizehhh, "Bara Bracket — FINAL", 2026-07-24): the native iOS
// sidecar posts ONE hourly sample row for the IN-PROGRESS hour, stamped across
// the full hour but holding only the steps walked so far. A ghost pepper's
// boost->freeze boundary landed inside that row. Because prorateSamplesIntoWindow
// splits a sample linearly across its STAMPED duration, the row was cut
// ~48.8% boost / ~50% freeze regardless of when she actually walked, which gave
// two user-visible pathologies:
//
//   1. `frozen` = (elapsed freeze seconds / bucket duration) x bucketSteps. The
//      freeze window widens with wall-clock time while being applied to the whole
//      bucket -- including steps banked during the boost -- so her score BLED
//      DOWN every sync while she stood still.
//   2. Every step walked during the freeze grew the bucket, and ~48.8% of it
//      landed retroactively in the 3x boost window => ~+1.48 score per step
//      walked while "frozen".
//
// Fix (mirrors the Leech monotonicity rule, spec §3.4): the effect segment walk
// counts CLOSED buckets only. An open bucket contributes 0 to every effect term
// until it closes, then is allocated once, permanently.
//
// Real HTTP + real test Postgres, asserting the leaderboard total a client would
// actually receive from GET /races/:id/progress.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;
let earnCounter = 0;
const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const P5 = { "X-Client-Features": "characters,powerups3,powerups4,powerups5" };

async function createUser(displayName) {
  const appleId = `apple-obs-${++nextAppleId}`;
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

async function createActiveRace(alice, opponents) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Open Bucket Race",
      targetSteps: 500000,
      maxDurationDays: 7,
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
  const start = new Date(Date.now() - 8 * HOUR_MS);
  await prisma.race.update({
    where: { id: raceId },
    data: { startedAt: start, endsAt: new Date(Date.now() + 24 * HOUR_MS) },
  });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

async function giveEffect(raceId, targetUserId, sourceUserId, type, { startsAt, expiresAt, metadata }) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId: targetUserId } });
  const src = await prisma.raceParticipant.findFirst({ where: { raceId, userId: sourceUserId } });
  const pw = await prisma.racePowerup.create({
    data: {
      raceId, participantId: src.id, userId: sourceUserId, type,
      rarity: "UNCOMMON", status: "USED", earnedAtSteps: ++earnCounter,
    },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId, targetParticipantId: p.id, targetUserId, sourceUserId, powerupId: pw.id,
      type, status: "ACTIVE", startsAt, expiresAt, metadata: metadata || {},
    },
  });
}

// A single sample row spanning [start, end) with `steps`. Used for both the
// OPEN row (end in the future -- the sidecar's in-progress hour) and CLOSED rows.
async function putSample(userId, start, end, steps) {
  return prisma.stepSample.upsert({
    where: { userId_periodStart: { userId, periodStart: start } },
    update: { steps, periodEnd: end },
    create: { userId, periodStart: start, periodEnd: end, steps, sourceName: "healthkit" },
  });
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
    token, headers: P5,
  });
  return (await res.json()).progress;
}

function boardSteps(progress, userId) {
  return (progress.participants || []).find((p) => p.userId === userId)?.totalSteps;
}

const pepperMeta = (boostMs) => ({ boostMs, freezeMs: boostMs, multiplier: 3, stepsAtBoostStart: 0 });

describe("open step buckets must not drive effect scoring", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); nextAppleId = 0; });

  // Maizehhh's exact shape: one OPEN 60-minute row whose span straddles the
  // pepper's boost->freeze boundary. The row is the ONLY step data in the effect
  // window, so every effect term must be zero and the total must be the raw steps.
  it("an open bucket straddling the boost/freeze boundary contributes no buff and no freeze", async () => {
    const a = await createUser("OpenA");
    const b = await createUser("OpenB");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);

    const now = Date.now();
    // Open row [now-40m, now+20m): 60 min stamped, but not yet closed.
    await putSample(a.userId, new Date(now - 40 * MIN_MS), new Date(now + 20 * MIN_MS), 600);
    // Pepper: boost [now-40m, now-20m), freeze [now-20m, now+20m).
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", {
      startsAt: new Date(now - 40 * MIN_MS),
      expiresAt: new Date(now + 20 * MIN_MS),
      metadata: pepperMeta(20 * MIN_MS),
    });

    const total = boardSteps(await getProgress(a.token, raceId), a.userId);
    // Buggy behavior credited 20/60 x 600 = 200 boost steps (+400 buffed) and
    // froze another 200 => 800. Closed-bucket scoring leaves the raw 600.
    assert.equal(total, 600, "open bucket must contribute 0 to buffed and 0 to frozen");
  });

  // Pathology 2: steps walked DURING the freeze grew the open bucket and ~half of
  // them were retroactively credited at 3x. A step walked while frozen must move
  // the leaderboard by exactly its raw value -- never more.
  it("steps added to the open bucket during a freeze earn no boosted credit", async () => {
    const a = await createUser("OpenC");
    const b = await createUser("OpenD");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);

    const now = Date.now();
    const openStart = new Date(now - 40 * MIN_MS);
    const openEnd = new Date(now + 20 * MIN_MS);
    await putSample(a.userId, openStart, openEnd, 600);
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", {
      startsAt: new Date(now - 40 * MIN_MS),
      expiresAt: new Date(now + 20 * MIN_MS),
      metadata: pepperMeta(20 * MIN_MS),
    });

    const before = boardSteps(await getProgress(a.token, raceId), a.userId);
    // She keeps walking while frozen: the open bucket grows by 300.
    await putSample(a.userId, openStart, openEnd, 900);
    const after = boardSteps(await getProgress(a.token, raceId), a.userId);

    // Buggy behavior moved this by +400 (300 raw + 200 extra boost - 100 extra
    // freeze). Walking while frozen must never beat walking unaffected.
    assert.equal(after - before, 300, "frozen steps must count at most 1x while the bucket is open");
  });

  // Regression guard: CLOSED buckets keep splitting exactly as before -- the
  // pepper still pays 3x on its boost hour and 0x on its freeze hour.
  it("closed buckets still take the full boost and freeze split", async () => {
    const a = await createUser("OpenE");
    const b = await createUser("OpenF");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);

    const now = Date.now();
    const boostStart = new Date(Math.floor((now - 3 * HOUR_MS) / HOUR_MS) * HOUR_MS);
    const freezeStart = new Date(boostStart.getTime() + HOUR_MS);
    const pepperEnd = new Date(freezeStart.getTime() + HOUR_MS);
    // Both rows are fully in the past => closed.
    await putSample(a.userId, boostStart, freezeStart, 100);
    await putSample(a.userId, freezeStart, pepperEnd, 100);
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", {
      startsAt: boostStart,
      expiresAt: pepperEnd,
      metadata: pepperMeta(HOUR_MS),
    });

    const total = boardSteps(await getProgress(a.token, raceId), a.userId);
    // base 200 + buffed (3-1)x100 - frozen 100 = 300.
    assert.equal(total, 300, "closed-bucket boost/freeze split is unchanged");
  });

  // The open bucket is not discarded -- it is deferred. Once it closes, its
  // steps are allocated by the ordinary fixed proration.
  it("an open bucket is counted once it closes", async () => {
    const a = await createUser("OpenG");
    const b = await createUser("OpenH");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);

    const now = Date.now();
    const openStart = new Date(now - 40 * MIN_MS);
    await putSample(a.userId, openStart, new Date(now + 20 * MIN_MS), 600);
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", {
      startsAt: new Date(now - 40 * MIN_MS),
      expiresAt: new Date(now + 20 * MIN_MS),
      metadata: pepperMeta(20 * MIN_MS),
    });
    assert.equal(boardSteps(await getProgress(a.token, raceId), a.userId), 600);

    // The bucket closes (its periodEnd moves into the past) with the same steps.
    await prisma.stepSample.updateMany({
      where: { userId: a.userId, periodStart: openStart },
      data: { periodEnd: new Date(now - 1 * MIN_MS) },
    });
    // Now [now-40m, now-1m) is closed: boost covers 20 of its 39 minutes.
    const total = boardSteps(await getProgress(a.token, raceId), a.userId);
    assert.ok(total > 600, `closed bucket must now feed the pepper, got ${total}`);
  });
});
