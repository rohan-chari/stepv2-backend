// Canonical lean integration suite.


// ---- consolidated from future-dated-sample-wedge.test.js ----
(function future_dated_sample_wedge_test_js(){
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
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

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

})();


// ---- consolidated from historical-effect-reconciliation.test.js ----
(function historical_effect_reconciliation_test_js(){
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { cleanDatabase, createTestUser, prisma } = require("../setup");
const {
  buildHistoricalRaceReconciliationWorker,
} = require("../../../src/modules/races/jobs/historicalRaceReconciliation");
const { coordinatedOptimizationMetrics } = require("../../../src/shared/observability/coordinatedOptimizationMetrics");

const START = new Date("2026-09-16T10:00:00.000Z");
const END = new Date("2026-09-16T23:00:00.000Z");

async function fixture({ status = "COMPLETED", totalSteps = 8 } = {}) {
  const account = await createTestUser({ displayName: "Historical scorer" });
  const race = await prisma.race.create({
    data: {
      creatorId: account.user.id,
      name: "Historical effect reconciliation",
      targetSteps: 100000,
      status,
      startedAt: START,
      endsAt: END,
      completedAt: status === "COMPLETED" ? END : null,
      timezone: "UTC",
      powerupsEnabled: true,
      timeBased: true,
      maxDurationDays: 1,
    },
  });
  const participant = await prisma.raceParticipant.create({
    data: {
      raceId: race.id,
      userId: account.user.id,
      status: "ACCEPTED",
      joinedAt: START,
      totalSteps,
      rawSteps: totalSteps,
    },
  });
  await prisma.userScoringInputVersion.create({
    data: { userId: account.user.id, generation: 2 },
  });
  return { account, race, participant };
}

async function addEffect(fixtureData, type, startsAt, expiresAt, metadata = {}) {
  const powerup = await prisma.racePowerup.create({
    data: {
      raceId: fixtureData.race.id,
      participantId: fixtureData.participant.id,
      userId: fixtureData.account.user.id,
      type,
      rarity: "RARE",
      status: "USED",
    },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId: fixtureData.race.id,
      targetParticipantId: fixtureData.participant.id,
      targetUserId: fixtureData.account.user.id,
      sourceUserId: fixtureData.account.user.id,
      powerupId: powerup.id,
      type,
      status: "EXPIRED",
      startsAt,
      expiresAt,
      metadata,
    },
  });
}

async function addSamples(userId, rows) {
  await prisma.stepSample.createMany({
    data: rows.map((row) => ({
      userId,
      periodStart: row[0],
      periodEnd: row[1],
      steps: row[2],
    })),
  });
}

async function enqueue(fixtureData, changedStart, changedEnd, generation = 2) {
  return prisma.historicalRaceReconciliationIntent.upsert({
    where: { raceId_userId: { raceId: fixtureData.race.id, userId: fixtureData.account.user.id } },
    create: {
        raceId: fixtureData.race.id,
        userId: fixtureData.account.user.id,
        changedStart,
        changedEnd,
        requestedSourceGeneration: generation,
        phase2Eligible: true,
        createdAt: new Date("2026-09-16T23:01:00.000Z"),
    },
    update: {
        changedStart,
        changedEnd,
        requestedSourceGeneration: generation,
        phase2Eligible: true,
        status: "QUEUED",
        availableAt: new Date("2026-09-16T23:01:00.000Z"),
    },
  });
}

function worker(options = {}) {
  return buildHistoricalRaceReconciliationWorker({
    now: () => new Date("2026-09-16T23:02:00.000Z"),
    logger: { log() {}, warn() {}, error(error) { throw error; } },
    ...options,
  });
}

describe("historical late event-time effect reconciliation", () => {
  beforeEach(async () => {
    coordinatedOptimizationMetrics.reset();
    await cleanDatabase();
  });

  it("corrects Runner's High from +8 to the canonical +2,668 and is retry-safe", async () => {
    const data = await fixture({ totalSteps: 8 });
    const effect = await addEffect(
      data,
      "RUNNERS_HIGH",
      new Date("2026-09-16T10:00:00.000Z"),
      new Date("2026-09-16T11:00:00.000Z"),
      { stepsAtBuffStart: 0 },
    );
    await addSamples(data.account.user.id, [[
      new Date("2026-09-16T10:00:00.000Z"),
      new Date("2026-09-16T11:00:00.000Z"),
      2668,
    ]]);
    await prisma.raceEffectImpact.create({
      data: {
        raceId: data.race.id,
        userId: data.account.user.id,
        effectId: effect.id,
        powerupType: "RUNNERS_HIGH",
        deltaSteps: 8,
      },
    });
    await enqueue(data, START, new Date("2026-09-16T11:01:00.000Z"));

    const invalidated = [];
    const processed = await worker({
      invalidateRaceProgress: async (raceId) => invalidated.push(["progress", raceId]),
      invalidateRaceList: async (raceId) => invalidated.push(["list", raceId]),
    }).runOnce();
    assert.equal(processed.corrected, 1);

    const projection = await prisma.historicalEffectContribution.findUniqueOrThrow({
      where: {
        raceId_userId_effectId_calculationVersion: {
          raceId: data.race.id,
          userId: data.account.user.id,
          effectId: effect.id,
          calculationVersion: 1,
        },
      },
    });
    assert.equal(projection.currentDeltaSteps, 2668);
    assert.equal(projection.sourceGeneration, 2n);
    assert.equal((await prisma.raceParticipant.findUniqueOrThrow({ where: { id: data.participant.id } })).totalSteps, 2668);
    assert.equal(await prisma.historicalEffectCorrection.count({ where: { projectionId: projection.id } }), 1);
    assert.deepEqual(invalidated, [["progress", data.race.id], ["list", data.race.id]]);
    const correctedMetrics = coordinatedOptimizationMetrics.snapshot();
    assert.equal(correctedMetrics.counters["historical_effects_checked{race_status=completed}"], 1);
    assert.equal(correctedMetrics.counters["historical_effects_corrected{race_status=completed}"], 1);
    assert.equal(correctedMetrics.counters.historical_corrections_created, 1);
    assert.equal(correctedMetrics.counters["historical_source_rows_read{race_status=completed}"], 1);
    assert.ok(correctedMetrics.histograms["historical_reconciliation_duration_ms{result=completed}"].count >= 1);
    assert.ok(correctedMetrics.histograms.correction_delta_steps_absolute.sum >= 2660);

    const samplesBefore = await prisma.stepSample.findMany({ where: { userId: data.account.user.id } });
    const second = await enqueue(data, START, new Date("2026-09-16T11:01:00.000Z"));
    assert.equal(second.id, (await prisma.historicalRaceReconciliationIntent.findFirstOrThrow()).id);
    const retry = await worker().runOnce();
    assert.equal(retry.noop, 1);
    assert.equal(coordinatedOptimizationMetrics.snapshot().counters.historical_reconciliation_noop, 1);
    assert.equal(await prisma.historicalEffectCorrection.count({ where: { projectionId: projection.id } }), 1);
    assert.deepEqual(await prisma.stepSample.findMany({ where: { userId: data.account.user.id } }), samplesBefore);
  });

  it("converges after a downward source correction with one negative transition", async () => {
    const data = await fixture({ totalSteps: 8 });
    const effect = await addEffect(data, "RUNNERS_HIGH", START, new Date("2026-09-16T11:00:00.000Z"));
    await addSamples(data.account.user.id, [[START, new Date("2026-09-16T11:00:00.000Z"), 2668]]);
    await prisma.raceEffectImpact.create({
      data: { raceId: data.race.id, userId: data.account.user.id, effectId: effect.id, powerupType: "RUNNERS_HIGH", deltaSteps: 8 },
    });
    await enqueue(data, START, new Date("2026-09-16T11:01:00.000Z"));
    await worker().runOnce();

    await prisma.stepSample.updateMany({ where: { userId: data.account.user.id, periodStart: START }, data: { steps: 1000 } });
    await prisma.userScoringInputVersion.update({ where: { userId: data.account.user.id }, data: { generation: 3 } });
    await prisma.historicalRaceReconciliationIntent.updateMany({ where: { raceId: data.race.id, userId: data.account.user.id }, data: { status: "QUEUED", requestedSourceGeneration: 3, availableAt: new Date("2026-09-16T23:03:00.000Z") } });
    const result = await worker().runOnce(new Date("2026-09-16T23:04:00.000Z"));
    assert.equal(result.corrected, 1);
    const projection = await prisma.historicalEffectContribution.findFirstOrThrow();
    assert.equal(projection.currentDeltaSteps, 1000);
    assert.equal((await prisma.raceParticipant.findUniqueOrThrow({ where: { id: data.participant.id } })).totalSteps, 1000);
    const corrections = await prisma.historicalEffectCorrection.findMany({ orderBy: { createdAt: "asc" } });
    assert.equal(corrections.length, 2);
    assert.equal(corrections[1].correctionDeltaSteps, -1668);
    assert.ok(coordinatedOptimizationMetrics.snapshot().histograms.correction_delta_steps_absolute.sum >= 1668);
  });

  it("uses canonical phase and signed modifier behavior for supported active families", async () => {
    const data = await fixture({ totalSteps: 10000 });
    const effects = [];
    const samples = [];
    const addWindow = async (type, start, end, steps, metadata = {}) => {
      effects.push(await addEffect(data, type, start, end, metadata));
      samples.push([start, end, steps]);
    };
    await addWindow("LEG_CRAMP", new Date("2026-09-16T10:00:00Z"), new Date("2026-09-16T10:30:00Z"), 1000);
    await addWindow("QUICKSAND", new Date("2026-09-16T10:30:00Z"), new Date("2026-09-16T11:00:00Z"), 1000);
    await addWindow("WRONG_TURN", new Date("2026-09-16T11:00:00Z"), new Date("2026-09-16T11:30:00Z"), 1000);
    await addWindow("RAINSTORM", new Date("2026-09-16T11:30:00Z"), new Date("2026-09-16T12:00:00Z"), 1000, { multiplier: 0.5 });
    await addWindow("CAMPFIRE_REST", new Date("2026-09-16T12:00:00Z"), new Date("2026-09-16T13:30:00Z"), 1000, { freezeMs: 1800000, multiplier: 1.5, boostMs: 1800000 });
    await addWindow("RALLY_FLAG", new Date("2026-09-16T14:00:00Z"), new Date("2026-09-16T14:30:00Z"), 1000, { multiplier: 1.25 });
    await addWindow("COIN_FLIP", new Date("2026-09-16T14:30:00Z"), new Date("2026-09-16T15:00:00Z"), 1000, { multiplier: 2 });
    await addWindow("COIN_FLIP", new Date("2026-09-16T15:00:00Z"), new Date("2026-09-16T15:30:00Z"), 1000, { multiplier: 0.5 });
    await addWindow("GHOST_PEPPER", new Date("2026-09-16T16:00:00Z"), new Date("2026-09-16T17:00:00Z"), 2000, { boostMs: 1800000, freezeMs: 1800000, multiplier: 3 });
    await addSamples(data.account.user.id, samples);
    await enqueue(data, START, new Date("2026-09-16T17:01:00Z"));
    const result = await worker().runOnce();
    assert.equal(result.corrected, 9);
    const projections = await prisma.historicalEffectContribution.findMany({ orderBy: { effectId: "asc" } });
    assert.equal(projections.length, 9);
    assert.deepEqual(new Map(effects.map((effect) => [effect.id, effect.type])).size, 9);
    assert.equal(await prisma.raceImpactEvent.count(), 0);
    assert.equal(await prisma.stepSample.count({ where: { userId: data.account.user.id } }), 9);
  });

  it("reconciles Rally Flag per materialized team beneficiary", async () => {
    const data = await fixture({ totalSteps: 100 });
    const teammate = await createTestUser({ displayName: "Rally teammate" });
    const teammateParticipant = await prisma.raceParticipant.create({
      data: {
        raceId: data.race.id,
        userId: teammate.user.id,
        status: "ACCEPTED",
        joinedAt: START,
        totalSteps: 100,
        rawSteps: 100,
      },
    });
    await prisma.userScoringInputVersion.create({
      data: { userId: teammate.user.id, generation: 2 },
    });
    const teammateData = {
      ...data,
      account: teammate,
      participant: teammateParticipant,
    };
    const ownEffect = await addEffect(data, "RALLY_FLAG", START, new Date("2026-09-16T10:30:00Z"), { multiplier: 1.25 });
    const teammateEffect = await addEffect(teammateData, "RALLY_FLAG", START, new Date("2026-09-16T10:30:00Z"), { multiplier: 1.25 });
    await addSamples(teammate.user.id, [[START, new Date("2026-09-16T10:30:00Z"), 1000]]);
    for (const effect of [ownEffect, teammateEffect]) {
      await prisma.raceImpactEvent.create({
        data: {
          raceId: data.race.id,
          recipientUserId: effect.targetUserId,
          sourceId: effect.id,
          sourceKind: "RALLY_FLAG",
          powerupType: "RALLY_FLAG",
          description: "Rally Flag beneficiary correction fixture",
          deltaSteps: 100,
          resolvedAt: new Date("2026-09-16T23:00:00.000Z"),
        },
      });
    }
    await enqueue(teammateData, START, new Date("2026-09-16T10:31:00Z"));
    assert.equal((await worker().runOnce()).corrected, 1);
    const teammateProjection = await prisma.historicalEffectContribution.findUniqueOrThrow({
      where: {
        raceId_userId_effectId_calculationVersion: {
          raceId: data.race.id,
          userId: teammate.user.id,
          effectId: teammateEffect.id,
          calculationVersion: 1,
        },
      },
    });
    assert.equal(teammateProjection.currentDeltaSteps, 250);
    assert.equal(await prisma.historicalEffectContribution.count({ where: { effectId: ownEffect.id } }), 0);
    assert.equal(await prisma.historicalEffectCorrection.count({ where: { effectId: teammateEffect.id } }), 1);
    assert.equal(await prisma.historicalRaceReconciliationIntent.count({ where: { raceId: data.race.id } }), 1);
  });

  it("corrects a late Quicksand freeze contribution", async () => {
    const data = await fixture({ totalSteps: 100 });
    const effect = await addEffect(data, "QUICKSAND", START, new Date("2026-09-16T10:30:00Z"));
    await addSamples(data.account.user.id, [[START, new Date("2026-09-16T10:30:00Z"), 1900]]);
    await prisma.raceImpactEvent.create({
      data: { raceId: data.race.id, recipientUserId: data.account.user.id, sourceId: effect.id, sourceKind: "QUICKSAND", powerupType: "QUICKSAND", description: "Quicksand correction fixture", deltaSteps: -100, resolvedAt: new Date("2026-09-16T23:00:00.000Z") },
    });
    await enqueue(data, START, new Date("2026-09-16T10:31:00Z"));
    assert.equal((await worker().runOnce()).corrected, 1);
    const projection = await prisma.historicalEffectContribution.findFirstOrThrow();
    assert.equal(projection.currentDeltaSteps, -1900);
    assert.equal((await prisma.raceParticipant.findUniqueOrThrow({ where: { id: data.participant.id } })).totalSteps, -1700);
    assert.equal(await prisma.historicalEffectCorrection.count({ where: { projectionId: projection.id } }), 1);
    assert.equal((await worker().runOnce()).claimed, 0);
  });

  it("corrects late Campfire Rest samples in its freeze phase", async () => {
    const data = await fixture({ totalSteps: 100 });
    const effect = await addEffect(data, "CAMPFIRE_REST", START, new Date("2026-09-16T11:00:00Z"), { freezeMs: 1800000, boostMs: 1800000, multiplier: 1.5 });
    await addSamples(data.account.user.id, [[START, new Date("2026-09-16T10:30:00Z"), 1900]]);
    await prisma.raceImpactEvent.create({
      data: { raceId: data.race.id, recipientUserId: data.account.user.id, sourceId: effect.id, sourceKind: "CAMPFIRE_REST", powerupType: "CAMPFIRE_REST", description: "Campfire freeze correction fixture", deltaSteps: -100, resolvedAt: new Date("2026-09-16T23:00:00.000Z") },
    });
    await enqueue(data, START, new Date("2026-09-16T10:31:00Z"));
    assert.equal((await worker().runOnce()).corrected, 1);
    const projection = await prisma.historicalEffectContribution.findFirstOrThrow();
    assert.equal(projection.currentDeltaSteps, -1900);
    assert.equal(await prisma.historicalEffectCorrection.count({ where: { projectionId: projection.id } }), 1);
  });

  it("corrects late Campfire Rest samples in its boost phase", async () => {
    const data = await fixture({ totalSteps: 100 });
    const effect = await addEffect(data, "CAMPFIRE_REST", START, new Date("2026-09-16T11:00:00Z"), { freezeMs: 1800000, boostMs: 1800000, multiplier: 1.5 });
    await addSamples(data.account.user.id, [[new Date("2026-09-16T10:30:00Z"), new Date("2026-09-16T11:00:00Z"), 1900]]);
    await prisma.raceImpactEvent.create({
      data: { raceId: data.race.id, recipientUserId: data.account.user.id, sourceId: effect.id, sourceKind: "CAMPFIRE_REST", powerupType: "CAMPFIRE_REST", description: "Campfire boost correction fixture", deltaSteps: 100, resolvedAt: new Date("2026-09-16T23:00:00.000Z") },
    });
    await enqueue(data, new Date("2026-09-16T10:30:00Z"), new Date("2026-09-16T11:01:00Z"));
    assert.equal((await worker().runOnce()).corrected, 1);
    const projection = await prisma.historicalEffectContribution.findFirstOrThrow();
    assert.equal(projection.currentDeltaSteps, 950);
    assert.equal(await prisma.historicalEffectCorrection.count({ where: { projectionId: projection.id } }), 1);
  });

  it("does not consume an active-race intent or create work by deployment alone", async () => {
    const data = await fixture({ status: "ACTIVE", totalSteps: 8 });
    await addEffect(data, "RUNNERS_HIGH", START, new Date("2026-09-16T11:00:00Z"));
    await addSamples(data.account.user.id, [[START, new Date("2026-09-16T11:00:00Z"), 2668]]);
    const result = await worker().runOnce();
    assert.equal(result.claimed, 0);
    assert.equal(await prisma.historicalEffectContribution.count(), 0);
  });

  it("fences a stale generation before any projection, score, or audit write", async () => {
    const data = await fixture({ totalSteps: 8 });
    await addEffect(data, "RUNNERS_HIGH", START, new Date("2026-09-16T11:00:00Z"));
    await addSamples(data.account.user.id, [[START, new Date("2026-09-16T11:00:00Z"), 2668]]);
    await enqueue(data, START, new Date("2026-09-16T11:00:00Z"), 1);
    const result = await worker().runOnce();
    assert.equal(result.stale, 1);
    assert.equal(coordinatedOptimizationMetrics.snapshot().counters["historical_reconciliation_generation_stale{reason=SOURCE_GENERATION_ADVANCED}"], 1);
    assert.equal(await prisma.historicalEffectContribution.count(), 0);
    assert.equal((await prisma.raceParticipant.findUniqueOrThrow({ where: { id: data.participant.id } })).totalSteps, 8);
  });
});

})();
