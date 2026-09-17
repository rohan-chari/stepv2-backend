// Focused Phase 2 worker benchmark. This is deliberately DB-backed and only
// permits the repository's isolated integration database.
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { performance } = require("node:perf_hooks");
const { Client } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || "";
const databaseName = new URL(DATABASE_URL).pathname.replace(/^\//, "");
assert.match(databaseName, /_test$/, "benchmark requires a *_test database");
assert.notEqual(databaseName, "steps_tracker", "benchmark must not use development database");
assert.notEqual(databaseName, "steps-tracker", "benchmark must not use development database");

let measuring = false;
let sqlCount = 0;
let sourceQueries = 0;
let contributionWrites = 0;
let correctionWrites = 0;
let participantWrites = 0;
let intentWrites = 0;
const originalClientQuery = Client.prototype.query;
Client.prototype.query = function measuredQuery(...args) {
  if (measuring) {
    const text = typeof args[0] === "string" ? args[0] : args[0]?.text || "";
    sqlCount += 1;
    if (/FROM\s+step_samples/i.test(text)) sourceQueries += 1;
    if (/historical_effect_contributions/i.test(text) && /INSERT|UPDATE|DELETE/i.test(text)) contributionWrites += 1;
    if (/historical_effect_corrections/i.test(text) && /INSERT|UPDATE|DELETE/i.test(text)) correctionWrites += 1;
    if (/race_participants/i.test(text) && /INSERT|UPDATE|DELETE/i.test(text)) participantWrites += 1;
    if (/historical_race_reconciliation_intents/i.test(text) && /INSERT|UPDATE|DELETE/i.test(text)) intentWrites += 1;
  }
  return originalClientQuery.apply(this, args);
};

const { cleanDatabase, createTestUser, prisma } = require("./setup");
const { buildHistoricalRaceReconciliationWorker } = require("../../src/modules/races/jobs/historicalRaceReconciliation");
const { coordinatedOptimizationMetrics } = require("../../src/shared/observability/coordinatedOptimizationMetrics");

const START = new Date("2026-09-16T10:00:00.000Z");
const EFFECT_END = new Date("2026-09-16T11:00:00.000Z");
const NOW = new Date("2026-09-16T23:00:00.000Z");

function resetCounters() {
  sqlCount = 0;
  sourceQueries = 0;
  contributionWrites = 0;
  correctionWrites = 0;
  participantWrites = 0;
  intentWrites = 0;
  coordinatedOptimizationMetrics.reset();
}

async function makeRace(index = 0) {
  const account = await createTestUser({ displayName: `Phase2 benchmark ${index}` });
  const race = await prisma.race.create({
    data: {
      creatorId: account.user.id,
      name: `Phase2 benchmark ${index}`,
      targetSteps: 100000,
      status: "COMPLETED",
      startedAt: START,
      endsAt: new Date("2026-09-16T22:00:00.000Z"),
      completedAt: new Date("2026-09-16T22:00:00.000Z"),
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
      totalSteps: 0,
      rawSteps: 0,
    },
  });
  await prisma.userScoringInputVersion.create({ data: { userId: account.user.id, generation: 2 } });
  return { account, race, participant };
}

async function addEffect(data, type, start, end, metadata = {}) {
  const powerup = await prisma.racePowerup.create({
    data: {
      raceId: data.race.id,
      participantId: data.participant.id,
      userId: data.account.user.id,
      type,
      rarity: "RARE",
      status: "USED",
    },
  });
  const effect = await prisma.raceActiveEffect.create({
    data: {
      raceId: data.race.id,
      targetParticipantId: data.participant.id,
      targetUserId: data.account.user.id,
      sourceUserId: data.account.user.id,
      powerupId: powerup.id,
      type,
      status: "EXPIRED",
      startsAt: start,
      expiresAt: end,
      metadata,
    },
  });
  await prisma.raceImpactEvent.create({
    data: {
      raceId: data.race.id,
      recipientUserId: data.account.user.id,
      sourceId: effect.id,
      sourceKind: type,
      powerupType: type,
      description: "Phase 2 performance fixture",
      deltaSteps: 1,
      resolvedAt: NOW,
    },
  });
}

async function prepare({ effectCount = 1, bucketCount = effectCount, raceCount = 1 } = {}) {
  const rows = [];
  for (let raceIndex = 0; raceIndex < raceCount; raceIndex += 1) {
    const data = await makeRace(raceIndex);
    for (let index = 0; index < effectCount; index += 1) {
      const start = new Date(START.getTime() + index * 5 * 60 * 1000);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      await addEffect(data, ["RUNNERS_HIGH", "RAINSTORM", "LEG_CRAMP", "QUICKSAND", "CAMPFIRE_REST", "UPRISING", "RALLY_FLAG", "COIN_FLIP", "GHOST_PEPPER", "WRONG_TURN"][index] || "RUNNERS_HIGH", start, end, index === 4 ? { freezeMs: 900000, boostMs: 900000, multiplier: 1.5 } : { multiplier: 1.25 });
    }
    await prisma.stepSample.createMany({
      data: Array.from({ length: bucketCount }, (_, index) => ({
        userId: data.account.user.id,
        periodStart: new Date(START.getTime() + index * 5 * 60 * 1000),
        periodEnd: new Date(START.getTime() + (index + 1) * 5 * 60 * 1000),
        steps: 100,
      })),
    });
    await prisma.historicalRaceReconciliationIntent.create({
      data: {
        raceId: data.race.id,
        userId: data.account.user.id,
        changedStart: START,
        changedEnd: EFFECT_END,
        requestedSourceGeneration: 2,
        phase2Eligible: true,
        availableAt: NOW,
      },
    });
    rows.push(data);
  }
  return rows;
}

async function runCase(options) {
  await cleanDatabase();
  resetCounters();
  await prepare(options);
  measuring = true;
  const started = performance.now();
  const result = await buildHistoricalRaceReconciliationWorker({
    now: () => NOW,
    logger: { warn() {}, error() {} },
  }).runOnce(NOW);
  const durationMs = performance.now() - started;
  measuring = false;
  const snapshot = coordinatedOptimizationMetrics.snapshot();
  return {
    ...options,
    sql: sqlCount,
    sourceQueries,
    sourceRows: Object.entries(snapshot.counters)
      .filter(([key]) => key.startsWith("historical_source_rows_read"))
      .reduce((sum, [, value]) => sum + value, 0),
    contributionWrites,
    correctionWrites,
    participantWrites,
    intentWrites,
    intents: await prisma.historicalRaceReconciliationIntent.count(),
    claimed: result.claimed,
    durationMs: Number(durationMs.toFixed(2)),
  };
}

describe("Phase 2 historical reconciliation performance", () => {
  it("keeps overlapping effects on one participant on the batched source path", async () => {
    const results = [];
    for (const effectCount of [1, 3, 10]) results.push(await runCase({ effectCount, bucketCount: 48 }));
    console.log("PHASE2_EFFECT_BENCHMARK", JSON.stringify(results));
    // The canonical scorer performs three bounded source reads for its
    // prefix/segment phases. That count is constant as effects increase.
    assert.deepEqual(results.map((row) => row.sourceQueries), [3, 3, 3]);
    assert.deepEqual(results.map((row) => row.intents), [1, 1, 1]);
  });

  it("keeps 48 buckets and five race/user intents bounded", async () => {
    const result = await runCase({ effectCount: 3, bucketCount: 48, raceCount: 5 });
    console.log("PHASE2_MULTI_RACE_BENCHMARK", JSON.stringify(result));
    assert.equal(result.intents, 5);
    assert.equal(result.claimed, 5);
    assert.equal(result.sourceQueries, 15);
  });

  it("measures no-op retry and downward correction without queue fan-out", async () => {
    const first = await runCase({ effectCount: 1, bucketCount: 48 });
    await prisma.historicalRaceReconciliationIntent.updateMany({ data: { status: "QUEUED", phase2Eligible: true, availableAt: NOW } });
    resetCounters();
    measuring = true;
    const started = performance.now();
    const retry = await buildHistoricalRaceReconciliationWorker({ now: () => NOW, logger: { warn() {}, error() {} } }).runOnce(NOW);
    const retryDurationMs = performance.now() - started;
    measuring = false;
    const snapshot = coordinatedOptimizationMetrics.snapshot();
    const noOp = { sql: sqlCount, durationMs: Number(retryDurationMs.toFixed(2)), claimed: retry.claimed, noop: snapshot.counters.historical_reconciliation_noop || 0 };
    console.log("PHASE2_RETRY_BENCHMARK", JSON.stringify({ first, noOp }));
    assert.equal(noOp.claimed, 1);
    assert.equal(noOp.noop, 1);
  });
});
