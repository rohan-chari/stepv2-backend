// Canonical lean integration suite.


// ---- consolidated from five-minute-step-samples.test.js ----
(function five_minute_step_samples_test_js(){
// Five-Minute Step Samples (spec §7 items 1, 2, 3, 6).
//
// Real HTTP + real test Postgres. Proves the server-side overlap-resolution
// rules (§3.3), the finer-grained scoring win (emersonz replay, §7.2), and that
// the reconcile is a behavioral NO-OP for pure-hourly traffic (old clients keep
// uploading hourly forever). Exercises BOTH write call sites: the legacy
// POST /steps/samples (recordStepSamples) and POST /steps/sync-v2 (Transaction A).
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { describe, it, before, after, beforeEach } = require("node:test");
const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
} = require("../setup");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-5min-${++nextAppleId}`;
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
      name: "5-min samples",
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

async function postSamples(token, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", {
    body: { samples },
    token,
  });
}

async function syncV2(token, samples, steps) {
  return request(server.baseUrl, "POST", "/steps/sync-v2", {
    token,
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: { date: "2026-07-17", steps, samples },
  });
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token });
  return (await res.json()).progress;
}

function findUser(progress, userId) {
  return progress.participants.find((p) => p.userId === userId);
}

function minutesAgo(m) {
  return new Date(Date.now() - m * 60 * 1000).toISOString();
}
function minutesFromNow(m) {
  return new Date(Date.now() + m * 60 * 1000).toISOString();
}

async function storedRows(userId) {
  return prisma.stepSample.findMany({
    where: { userId },
    orderBy: { periodStart: "asc" },
  });
}

// Core invariant (§8): after ANY sync sequence, a user never has two stored
// samples overlapping in time.
async function assertNoOverlaps(userId) {
  const rows = await storedRows(userId);
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      const overlap =
        a.periodEnd.getTime() > b.periodStart.getTime() &&
        a.periodStart.getTime() < b.periodEnd.getTime();
      assert.ok(
        !overlap,
        `overlap between [${a.periodStart.toISOString()},${a.periodEnd.toISOString()}] and [${b.periodStart.toISOString()},${b.periodEnd.toISOString()}]`
      );
    }
  }
}

// Absolute anchor for the overlap-matrix persistence tests (no race needed —
// they assert on stored rows only). Uses fixed UTC instants for determinism.
const H = "2026-07-17T15:";
const s = (mmss) => `${H}${mmss}.000Z`; // e.g. s("05:00") -> 15:05:00Z

describe("five-minute step samples — overlap resolution (§3.3)", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); nextAppleId = 0; });

  it("Case A: fine buckets covering a stored coarse bucket delete the coarse row", async () => {
    const u = await createUser("MatrixA");
    await postSamples(u.token, [{ periodStart: s("00:00"), periodEnd: s("15:00"), steps: 300 }]);
    let rows = await storedRows(u.userId);
    assert.equal(rows.length, 1);

    // Three 5-min buckets fully covering [15:00,15:15].
    await postSamples(u.token, [
      { periodStart: s("00:00"), periodEnd: s("05:00"), steps: 100 },
      { periodStart: s("05:00"), periodEnd: s("10:00"), steps: 100 },
      { periodStart: s("10:00"), periodEnd: s("15:00"), steps: 100 },
    ]);

    rows = await storedRows(u.userId);
    assert.equal(rows.length, 3, "coarse row deleted, three fine rows remain");
    assert.deepEqual(rows.map((r) => r.steps), [100, 100, 100]);
    await assertNoOverlaps(u.userId);
  });

  it("Case B: a coarse bucket is dropped when finer rows already cover it (rule 1)", async () => {
    const u = await createUser("MatrixB");
    await postSamples(u.token, [
      { periodStart: s("00:00"), periodEnd: s("05:00"), steps: 100 },
      { periodStart: s("05:00"), periodEnd: s("10:00"), steps: 100 },
      { periodStart: s("10:00"), periodEnd: s("15:00"), steps: 100 },
    ]);
    // Old-build hourly upload for the same span must NOT clobber the finer rows.
    await postSamples(u.token, [{ periodStart: s("00:00"), periodEnd: s("15:00"), steps: 900 }]);

    const rows = await storedRows(u.userId);
    assert.equal(rows.length, 3, "finer rows survive; coarse dropped");
    assert.deepEqual(rows.map((r) => r.steps), [100, 100, 100]);
    await assertNoOverlaps(u.userId);
  });

  it("Case C: an in-progress partial bucket maturing replaces the stored partial", async () => {
    const u = await createUser("MatrixC");
    await postSamples(u.token, [{ periodStart: s("35:00"), periodEnd: s("37:00"), steps: 20 }]);
    await postSamples(u.token, [{ periodStart: s("35:00"), periodEnd: s("40:00"), steps: 50 }]);

    const rows = await storedRows(u.userId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].steps, 50);
    assert.equal(rows[0].periodEnd.toISOString(), s("40:00"));
    await assertNoOverlaps(u.userId);
  });

  it("Case D: identical re-sync updates the value in place", async () => {
    const u = await createUser("MatrixD");
    await postSamples(u.token, [{ periodStart: s("00:00"), periodEnd: s("05:00"), steps: 100 }]);
    await postSamples(u.token, [{ periodStart: s("00:00"), periodEnd: s("05:00"), steps: 150 }]);
    const rows = await storedRows(u.userId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].steps, 150);
  });

  it("Case E: pure-hourly re-sync is a behavioral no-op", async () => {
    const u = await createUser("MatrixE");
    const hourly = [
      { periodStart: "2026-07-17T13:00:00.000Z", periodEnd: "2026-07-17T14:00:00.000Z", steps: 500 },
      { periodStart: "2026-07-17T14:00:00.000Z", periodEnd: "2026-07-17T15:00:00.000Z", steps: 600 },
    ];
    await postSamples(u.token, hourly);
    const before = await storedRows(u.userId);
    await postSamples(u.token, hourly);
    const afterRows = await storedRows(u.userId);

    assert.equal(afterRows.length, 2);
    assert.deepEqual(
      afterRows.map((r) => [r.periodStart.toISOString(), r.periodEnd.toISOString(), r.steps]),
      before.map((r) => [r.periodStart.toISOString(), r.periodEnd.toISOString(), r.steps])
    );
    await assertNoOverlaps(u.userId);
  });

  it("Case F: span guard keeps a stored bucket that extends before the batch range", async () => {
    const u = await createUser("MatrixF");
    // A coarse bucket that starts BEFORE the fine batch's covered range (the
    // day-start-after-timezone-travel case). Deleting it would destroy credit
    // outside what the batch replaces.
    await postSamples(u.token, [{ periodStart: "2026-07-17T14:45:00.000Z", periodEnd: "2026-07-17T15:30:00.000Z", steps: 450 }]);
    // Fine buckets colliding with the coarse row but NOT spanning it.
    await postSamples(u.token, [
      { periodStart: s("00:00"), periodEnd: s("05:00"), steps: 100 },
      { periodStart: s("05:00"), periodEnd: s("10:00"), steps: 100 },
    ]);

    const rows = await storedRows(u.userId);
    assert.equal(rows.length, 1, "coarse row survives; colliding incoming dropped");
    assert.equal(rows[0].steps, 450);
    await assertNoOverlaps(u.userId);
  });
});

describe("five-minute step samples — sync-v2 Transaction A (§7 item 1)", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); nextAppleId = 0; });

  it("persists 5-min samples verbatim and race totals reflect fine proration", async () => {
    const alice = await createUser("SyncAlice");
    const bob = await createUser("SyncBob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // Four contiguous 5-min buckets in the last 20 minutes.
    const samples = [
      { periodStart: minutesAgo(20), periodEnd: minutesAgo(15), steps: 250 },
      { periodStart: minutesAgo(15), periodEnd: minutesAgo(10), steps: 250 },
      { periodStart: minutesAgo(10), periodEnd: minutesAgo(5), steps: 250 },
      { periodStart: minutesAgo(5), periodEnd: minutesAgo(1), steps: 250 },
    ];
    const res = await syncV2(alice.token, samples, 1000);
    assert.equal(res.status, 202);

    const rows = await storedRows(alice.userId);
    assert.equal(rows.length, 4, "all four fine buckets persisted verbatim");
    assert.equal(rows.reduce((a, r) => a + r.steps, 0), 1000);
    await assertNoOverlaps(alice.userId);

    const progress = await getProgress(alice.token, raceId);
    assert.equal(findUser(progress, alice.userId).totalSteps, 1000);
  });

  it("sync-v2 fine buckets delete an earlier stored coarse bucket (Transaction A reconcile)", async () => {
    const alice = await createUser("SyncAlice2");
    const bob = await createUser("SyncBob2");
    await makeFriends(alice, bob);
    await createActiveRace(alice, bob);

    await syncV2(alice.token, [
      { periodStart: s("00:00"), periodEnd: s("15:00"), steps: 300 },
    ], 300);
    await syncV2(alice.token, [
      { periodStart: s("00:00"), periodEnd: s("05:00"), steps: 100 },
      { periodStart: s("05:00"), periodEnd: s("10:00"), steps: 100 },
      { periodStart: s("10:00"), periodEnd: s("15:00"), steps: 100 },
    ], 300);

    const rows = await storedRows(alice.userId);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.steps), [100, 100, 100]);
    await assertNoOverlaps(alice.userId);
  });
});

// The 2026-07-22 emersonz incident: a walking burst during the 2x event,
// immediately after a Wrong Turn expired. Hourly proration smears the burst into
// the expired Wrong Turn (reversed x2); 5-min buckets score it correctly.
describe("five-minute step samples — emersonz replay (§7 item 2)", () => {
  before(async () => { server = await getSharedServer(); });
  after(async () => { await prisma.globalStepEvent.deleteMany(); });
  beforeEach(async () => {
    await cleanDatabase();
    await prisma.globalStepEvent.deleteMany();
    nextAppleId = 0;
  });

  async function seedWrongTurnAndEvent(alice, bob, raceId) {
    // Wrong Turn on alice, expired 30 min ago (covered [now-90, now-30]).
    const wt = await prisma.racePowerup.create({
      data: {
        raceId,
        participantId: (await prisma.raceParticipant.findFirst({ where: { raceId, userId: alice.userId } })).id,
        userId: bob.userId,
        type: "WRONG_TURN",
        rarity: "UNCOMMON",
        status: "USED",
      },
    });
    const aliceP = await prisma.raceParticipant.findFirst({ where: { raceId, userId: alice.userId } });
    await prisma.raceActiveEffect.create({
      data: {
        raceId,
        targetParticipantId: aliceP.id,
        targetUserId: alice.userId,
        sourceUserId: bob.userId,
        powerupId: wt.id,
        type: "WRONG_TURN",
        status: "ACTIVE",
        startsAt: new Date(Date.now() - 90 * 60 * 1000),
        expiresAt: new Date(Date.now() - 30 * 60 * 1000),
      },
    });
    // Global 2x event covering [now-30, now+5].
    await prisma.globalStepEvent.create({
      data: {
        startsAt: new Date(Date.now() - 30 * 60 * 1000),
        endsAt: new Date(Date.now() + 5 * 60 * 1000),
        multiplier: 2,
        label: "emersonz 2x",
      },
    });
  }

  it("fine-grained buckets score the burst under the event, not the expired Wrong Turn", async () => {
    const alice = await createUser("EmersonzFine");
    const bob = await createUser("EmersonzBobF");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await seedWrongTurnAndEvent(alice, bob, raceId);

    // 2400 steps entirely inside the event window (last 30 min), 6 x 5-min buckets.
    await postSamples(alice.token, [
      { periodStart: minutesAgo(30), periodEnd: minutesAgo(25), steps: 400 },
      { periodStart: minutesAgo(25), periodEnd: minutesAgo(20), steps: 400 },
      { periodStart: minutesAgo(20), periodEnd: minutesAgo(15), steps: 400 },
      { periodStart: minutesAgo(15), periodEnd: minutesAgo(10), steps: 400 },
      { periodStart: minutesAgo(10), periodEnd: minutesAgo(5), steps: 400 },
      { periodStart: minutesAgo(5), periodEnd: minutesAgo(1), steps: 400 },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    // Base 2400 + full 2x event boost 2400 = 4800, NO Wrong Turn reversal.
    assert.equal(aliceP.totalSteps, 4800);
  });

  it("a single hourly bucket reproduces the smeared (buggy) total — regression contrast", async () => {
    const alice = await createUser("EmersonzHour");
    const bob = await createUser("EmersonzBobH");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await seedWrongTurnAndEvent(alice, bob, raceId);

    // The SAME 2400 steps as one hourly bucket [now-60, now]. Half overlaps the
    // expired Wrong Turn window [now-60,now-30] (reversed x2); half overlaps the
    // event [now-30,now] (boosted). This is the smeared behavior the fix avoids.
    await postSamples(alice.token, [
      { periodStart: minutesAgo(60), periodEnd: minutesAgo(0), steps: 2400 },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    // base 2400 - 2*1200 (reversed half) + 1200 (event half) = 1200.
    assert.equal(aliceP.totalSteps, 1200);
    assert.ok(
      aliceP.totalSteps < 4800,
      "hourly proration under-scores the burst vs 5-min buckets (proves the fix)"
    );
  });
});

// 2026-07-23 prod incident: MAX_SAMPLES was 48 (sized for 24 hourly buckets),
// so a 5-min day (up to 288 non-zero buckets) started 400-ing every sync for
// any user active >4h — a total sync outage for that user, not a granularity
// downgrade. The cap must admit a full 5-min day plus tz-shift slack (spec
// §3.2: payload shape is granularity-agnostic).
describe("five-minute step samples — full-day payload fits the sample cap", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); nextAppleId = 0; });

  // 288 contiguous 5-min buckets = a complete 24h day at the finest granularity.
  it("accepts a complete 288-bucket 5-min day (the incident payload)", async () => {
    const alice = await createUser("FullDayAlice");
    const samples = [];
    for (let i = 288; i > 0; i--) {
      samples.push({
        periodStart: minutesAgo(i * 5 + 1),
        periodEnd: minutesAgo((i - 1) * 5 + 1),
        steps: 10,
      });
    }
    const res = await syncV2(alice.token, samples, 2880);
    assert.equal(res.status, 202, `full 5-min day must sync (got ${res.status})`);
    const rows = await storedRows(alice.userId);
    assert.equal(rows.length, 288, "all 288 fine buckets persisted");
    await assertNoOverlaps(alice.userId);
  });

  it("still rejects a payload beyond the cap (bound stays enforced)", async () => {
    const alice = await createUser("OverCapAlice");
    const samples = Array.from({ length: 337 }, (_, i) => ({
      periodStart: minutesAgo(i * 5 + 2),
      periodEnd: minutesAgo(i * 5 + 1),
      steps: 1,
    }));
    const res = await syncV2(alice.token, samples, 337);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "INVALID_STEP_SYNC");
  });
});

// 2026-07-23 incident #2 backstop: builds below 1.7.1 read fine buckets with
// the inflating per-window HealthKit query, and a device that PERSISTED
// bucketMinutes=5 from an earlier flag window keeps sending fine payloads on
// cold-start syncs no matter what /auth/me now serves. Server-side guard:
// sync-v2 rejects a below-floor client's payload carrying MORE THAN ONE
// sub-hourly sample (one is allowed — the legitimate trailing partial bucket
// of an hourly read). Fail-open on absent/garbled versions: builds that old
// cannot produce fine buckets at all.
describe("five-minute step samples — sub-hourly payloads gated at app 1.7.1", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); nextAppleId = 0; });

  function fineSamples(n) {
    return Array.from({ length: n }, (_, i) => ({
      periodStart: minutesAgo((n - i) * 5 + 1),
      periodEnd: minutesAgo((n - i - 1) * 5 + 1),
      steps: 100,
    }));
  }

  async function syncV2Versioned(token, samples, steps, version) {
    return request(server.baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        ...(version === undefined ? {} : { "X-App-Version": version }),
      },
      body: { date: "2026-07-17", steps, samples },
    });
  }

  it("rejects fine samples from a below-floor build (1.7.0)", async () => {
    const alice = await createUser("GateAlice");
    const res = await syncV2Versioned(alice.token, fineSamples(6), 600, "1.7.0");
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "INVALID_STEP_SYNC");
  });

  it("accepts an hourly payload with ONE trailing partial from a below-floor build", async () => {
    const alice = await createUser("GateBob");
    const samples = [
      { periodStart: minutesAgo(120), periodEnd: minutesAgo(60), steps: 300 },
      // trailing in-progress partial (< 60min) — every hourly client sends one
      { periodStart: minutesAgo(60), periodEnd: minutesAgo(20), steps: 200 },
    ];
    const res = await syncV2Versioned(alice.token, samples, 500, "1.7.0");
    assert.equal(res.status, 202);
  });

  it("accepts fine samples at the floor (1.7.1, normalized reader)", async () => {
    const alice = await createUser("GateCarol");
    const res = await syncV2Versioned(alice.token, fineSamples(6), 600, "1.7.1");
    assert.equal(res.status, 202);
  });

  it("fails open when the version header is absent", async () => {
    const alice = await createUser("GateDave");
    const res = await syncV2Versioned(alice.token, fineSamples(6), 600, undefined);
    assert.equal(res.status, 202);
  });
});

})();


// ---- consolidated from open-bucket-effect-scoring.test.js ----
(function open_bucket_effect_scoring_test_js(){
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
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

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

})();
