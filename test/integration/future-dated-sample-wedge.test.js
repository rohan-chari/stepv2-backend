// Future-dated (open-hour) sample wedge — 2026-07-26 incident.
//
// The iOS background sidecar posts ANCHORED full-clock-hour rows. Mid-hour that
// yields a row whose period_end is in the FUTURE (e.g. posted 14:15, claiming
// 14:00→15:00). The reconcile span guard (stepSample.js rule 2) then refuses to
// let any finer sample replace it, because the un-spanned overhang
// (coveredEnd→15:00) prorates to >0 steps and looks like real credit worth
// protecting. It isn't — that time hasn't happened yet.
//
// Effect in prod: the Dart 5-min sync is rejected for the whole hour, the
// player's total sits frozen, and live powerup windows score nothing until a
// sync finally runs past the top of the next hour.
//
// Real HTTP + real test Postgres, through POST /steps/samples and
// POST /steps/sync-v2 — the two write call sites that reach reconcileBatch.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

async function createUser() {
  const appleId = `apple-wedge-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  return { userId: body.user.id, token: body.sessionToken };
}

async function postSamples(token, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", {
    body: { samples },
    token,
  });
}

async function storedSamples(userId) {
  return prisma.stepSample.findMany({
    where: { userId },
    orderBy: { periodStart: "asc" },
    select: { periodStart: true, periodEnd: true, steps: true },
  });
}

const MIN = 60 * 1000;

// Top of the current hour, so "the open hour" in these tests is genuinely open
// relative to the server's own clock (the fix reads server now()).
function topOfCurrentHour() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return d;
}

// A 60-minute row that STARTED 30 minutes ago and therefore ENDS 30 minutes in
// the future — the sidecar's anchored-open-hour shape, but pinned relative to
// now so the test behaves identically wherever in the clock hour it runs.
function openHourWindow() {
  const now = Date.now();
  const start = Math.floor((now - 30 * MIN) / (5 * MIN)) * (5 * MIN);
  return { start: new Date(start), end: new Date(start + 60 * MIN) };
}

// Fine buckets from `hourStart` up to (approximately) NOW — which is what the
// Dart client actually sends: it reads HealthKit over [startOfDay, now]. The
// batch therefore never reaches the anchored hour end, but it also never leaves
// elapsed time uncovered. Both properties matter to the guard.
// The final bucket is CLAMPED TO NOW, exactly like the Dart client
// (`buildBucketWindows(start, end=now, …)` truncates its last window). Stopping
// at the last whole 5-minute boundary instead would leave up to 5 minutes of
// ELAPSED-but-uncovered time, which the span guard rightly protects — making
// this test pass or fail depending on where in the 5-minute cycle it ran.
function fineBucketsToNow(hourStart, stepsPerBucket = 100) {
  const now = Date.now();
  const out = [];
  let t = hourStart.getTime();
  while (t < now) {
    const end = Math.min(t + 5 * MIN, now);
    out.push({
      periodStart: new Date(t).toISOString(),
      periodEnd: new Date(end).toISOString(),
      steps: stepsPerBucket,
    });
    t += 5 * MIN;
  }
  return out;
}

describe("future-dated sample wedge", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("lets 5-min samples replace an open-hour row posted by the sidecar", async () => {
    const user = await createUser();
    const { start: hourStart, end: hourEnd } = openHourWindow(); // hourEnd is FUTURE

    // 1. Sidecar posts the anchored full clock hour mid-hour. period_end is
    //    ahead of now; steps is small because only a straddling chunk counted.
    const sidecar = await postSamples(user.token, [
      {
        periodStart: hourStart.toISOString(),
        periodEnd: hourEnd.toISOString(),
        steps: 7,
      },
    ]);
    assert.equal(sidecar.status, 200);

    // 2. Dart 5-min sync over the elapsed part of that window. Its coverage runs
    //    to ~now, so it leaves NO elapsed time uncovered — but it can never
    //    reach the anchored hourEnd. That gap is the entire wedge.
    const fine = fineBucketsToNow(hourStart, 100);
    assert.ok(fine.length >= 5, `expected >=5 elapsed buckets, got ${fine.length}`);
    const fineRes = await postSamples(user.token, fine);
    assert.equal(fineRes.status, 200);

    const rows = await storedSamples(user.userId);

    // The fine rows must have landed...
    assert.equal(
      rows.length,
      fine.length,
      `expected the ${fine.length} fine rows, got ${JSON.stringify(rows)}`
    );
    // ...and the stale open-hour row must be gone, not sitting alongside them.
    assert.ok(
      !rows.some((r) => r.periodEnd.getTime() === hourEnd.getTime()),
      "the future-dated open-hour row should have been replaced"
    );

    // No inflation: the total is exactly the fine reads, NOT fine + the stale 7.
    const total = rows.reduce((a, r) => a + r.steps, 0);
    assert.equal(total, fine.length * 100);
  });

  it("does the same through POST /steps/sync-v2", async () => {
    const user = await createUser();
    const { start: hourStart, end: hourEnd } = openHourWindow();

    await postSamples(user.token, [
      {
        periodStart: hourStart.toISOString(),
        periodEnd: hourEnd.toISOString(),
        steps: 7,
      },
    ]);

    const fine = fineBucketsToNow(hourStart, 150);
    const res = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: {
        steps: fine.length * 150,
        date: new Date().toISOString().slice(0, 10),
        samples: fine,
      },
      token: user.token,
    });
    assert.ok(res.status < 400, `sync-v2 failed: ${res.status}`);

    const rows = await storedSamples(user.userId);
    assert.equal(rows.length, fine.length);
    assert.equal(
      rows.reduce((a, r) => a + r.steps, 0),
      fine.length * 150
    );
    assert.ok(!rows.some((r) => r.periodEnd.getTime() === hourEnd.getTime()));
  });

  // The span guard's real purpose must survive: a stored row extending past the
  // batch into the PAST still carries genuine credit and must NOT be destroyed.
  it("still protects a stored row whose overhang is in the past", async () => {
    const user = await createUser();
    // A fully-elapsed hour from earlier today.
    const hourStart = new Date(topOfCurrentHour().getTime() - 3 * 60 * MIN);
    const hourEnd = new Date(hourStart.getTime() + 60 * MIN); // already in the PAST

    await postSamples(user.token, [
      {
        periodStart: hourStart.toISOString(),
        periodEnd: hourEnd.toISOString(),
        steps: 600,
      },
    ]);

    // A narrow batch covering only the first 10 minutes. The remaining 50
    // minutes are real, elapsed, step-carrying time — dropping them would lose
    // credit, so the guard must reject this batch exactly as it does today.
    const res = await postSamples(user.token, [
      {
        periodStart: hourStart.toISOString(),
        periodEnd: new Date(hourStart.getTime() + 5 * MIN).toISOString(),
        steps: 50,
      },
      {
        periodStart: new Date(hourStart.getTime() + 5 * MIN).toISOString(),
        periodEnd: new Date(hourStart.getTime() + 10 * MIN).toISOString(),
        steps: 50,
      },
    ]);
    assert.equal(res.status, 200);

    const rows = await storedSamples(user.userId);
    assert.equal(rows.length, 1, "the elapsed hourly row must be preserved");
    assert.equal(rows[0].steps, 600);
  });

  // Pure-hourly clients (frozen old builds) must keep working unchanged: a
  // completed hour replaced by a re-read of the same completed hour.
  it("is a no-op for pure-hourly traffic on a completed hour", async () => {
    const user = await createUser();
    const hourStart = new Date(topOfCurrentHour().getTime() - 2 * 60 * MIN);
    const hourEnd = new Date(hourStart.getTime() + 60 * MIN);

    await postSamples(user.token, [
      { periodStart: hourStart.toISOString(), periodEnd: hourEnd.toISOString(), steps: 300 },
    ]);
    await postSamples(user.token, [
      { periodStart: hourStart.toISOString(), periodEnd: hourEnd.toISOString(), steps: 450 },
    ]);

    const rows = await storedSamples(user.userId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].steps, 450, "same-start re-read should overwrite");
  });
});
