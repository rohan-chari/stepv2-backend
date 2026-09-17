const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { cleanDatabase, createTestUser, prisma } = require("./setup");
const {
  buildHistoricalRaceReconciliationWorker,
} = require("../../src/modules/races/jobs/historicalRaceReconciliation");
const { coordinatedOptimizationMetrics } = require("../../src/shared/observability/coordinatedOptimizationMetrics");

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

  it("uses canonical phase and signed modifier behavior for all ten supported families", async () => {
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
    await addWindow("UPRISING", new Date("2026-09-16T13:30:00Z"), new Date("2026-09-16T14:00:00Z"), 1000, { multiplier: 2 });
    await addWindow("RALLY_FLAG", new Date("2026-09-16T14:00:00Z"), new Date("2026-09-16T14:30:00Z"), 1000, { multiplier: 1.25 });
    await addWindow("COIN_FLIP", new Date("2026-09-16T14:30:00Z"), new Date("2026-09-16T15:00:00Z"), 1000, { multiplier: 2 });
    await addWindow("COIN_FLIP", new Date("2026-09-16T15:00:00Z"), new Date("2026-09-16T15:30:00Z"), 1000, { multiplier: 0.5 });
    await addWindow("GHOST_PEPPER", new Date("2026-09-16T16:00:00Z"), new Date("2026-09-16T17:00:00Z"), 2000, { boostMs: 1800000, freezeMs: 1800000, multiplier: 3 });
    await addSamples(data.account.user.id, samples);
    await enqueue(data, START, new Date("2026-09-16T17:01:00Z"));
    const result = await worker().runOnce();
    assert.equal(result.corrected, 10);
    const projections = await prisma.historicalEffectContribution.findMany({ orderBy: { effectId: "asc" } });
    assert.equal(projections.length, 10);
    assert.deepEqual(new Map(effects.map((effect) => [effect.id, effect.type])).size, 10);
    assert.equal(await prisma.raceImpactEvent.count(), 0);
    assert.equal(await prisma.stepSample.count({ where: { userId: data.account.user.id } }), 10);
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
