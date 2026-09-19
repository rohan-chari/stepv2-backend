const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { beforeEach, describe, it } = require("node:test");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("../setup");
const {
  buildHistoricalRaceReconciliationWorker,
} = require("../../../src/modules/races/jobs/historicalRaceReconciliation");
const {
  RaceImpactEvent,
  activityProjection,
  popupProjection,
} = require("../../../src/modules/races/models/raceImpactEvent");

const RACE_START = new Date("2026-09-16T09:00:00.000Z");
const EFFECT_START = new Date("2026-09-16T10:00:00.000Z");
const EFFECT_END = new Date("2026-09-16T11:00:00.000Z");
const NOW = new Date("2026-09-16T12:00:00.000Z");
const RACE_END = new Date("2026-09-17T09:00:00.000Z");

async function fixture() {
  const account = await createTestUser({ displayName: "Impact reconciliation" });
  const race = await prisma.race.create({
    data: {
      creatorId: account.user.id,
      name: "Active impact receipt reconciliation",
      targetSteps: 100000,
      status: "ACTIVE",
      startedAt: RACE_START,
      endsAt: RACE_END,
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
      joinedAt: RACE_START,
      totalSteps: 8,
      rawSteps: 8,
    },
  });
  await prisma.userScoringInputVersion.create({
    data: { userId: account.user.id, generation: 2 },
  });
  const powerup = await prisma.racePowerup.create({
    data: {
      raceId: race.id,
      participantId: participant.id,
      userId: account.user.id,
      type: "RUNNERS_HIGH",
      rarity: "RARE",
      status: "USED",
    },
  });
  const effect = await prisma.raceActiveEffect.create({
    data: {
      raceId: race.id,
      targetParticipantId: participant.id,
      targetUserId: account.user.id,
      sourceUserId: account.user.id,
      powerupId: powerup.id,
      type: "RUNNERS_HIGH",
      status: "EXPIRED",
      startsAt: EFFECT_START,
      expiresAt: EFFECT_END,
      metadata: { multiplier: 2, stepsAtBuffStart: 0 },
    },
  });
  const receipt = await prisma.raceImpactEvent.create({
    data: {
      raceId: race.id,
      recipientUserId: account.user.id,
      sourceKind: "ACTIVE_EFFECT",
      sourceId: effect.id,
      powerupType: "RUNNERS_HIGH",
      deltaSteps: 8,
      description: "Runner’s High wore off. You gained 8 steps.",
      valueStatus: "SYNCED_SNAPSHOT",
      calculationVersion: 2,
      resolvedAt: EFFECT_END,
    },
  });
  return { account, race, participant, effect, receipt };
}

async function addLateSample(userId, {
  start = EFFECT_START,
  end = EFFECT_END,
  steps = 2668,
} = {}) {
  await prisma.stepSample.create({
    data: {
      userId,
      periodStart: start,
      periodEnd: end,
      steps,
    },
  });
}

async function enqueue(data, changedStart, changedEnd, generation = 2) {
  await prisma.historicalRaceReconciliationIntent.create({
    data: {
      raceId: data.race.id,
      userId: data.account.user.id,
      changedStart,
      changedEnd,
      requestedSourceGeneration: generation,
      phase2Eligible: true,
      status: "QUEUED",
      availableAt: NOW,
      createdAt: NOW,
    },
  });
}

function worker() {
  return buildHistoricalRaceReconciliationWorker({
    logger: { log() {}, warn() {}, error(error) { throw error; } },
    invalidateRaceProgress: async () => {},
    invalidateRaceList: async () => {},
  });
}

describe("timed impact receipt reconciliation", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("exposes the expiry snapshot as provisional before any late correction", async () => {
    const data = await fixture();
    const rows = await RaceImpactEvent.listActivity({
      raceId: data.race.id,
      userId: data.account.user.id,
      limit: 50,
      reconciliationEnabled: true,
    });
    assert.equal(rows.length, 1);

    const activity = activityProjection(rows[0]);
    const popup = popupProjection(rows[0]);
    assert.equal(activity.deltaSteps, 8);
    assert.equal(activity.impactValueStatus, "PROVISIONAL");
    assert.equal(activity.wasReconciled, false);
    assert.equal(activity.reconciledAt, null);
    assert.equal(popup.impactValueStatus, "PROVISIONAL");
  });

  it("revises the displayed Runner's High receipt from late overlapping samples without rewriting the original receipt or active total", async () => {
    const data = await fixture();
    await addLateSample(data.account.user.id);
    await enqueue(data, EFFECT_START, EFFECT_END);

    const result = await worker().runOnce(NOW);
    assert.equal(result.corrected, 1);

    const rawReceipt = await prisma.raceImpactEvent.findUniqueOrThrow({
      where: { id: data.receipt.id },
    });
    assert.equal(rawReceipt.deltaSteps, 8, "the immutable expiry snapshot remains audit evidence");

    const participant = await prisma.raceParticipant.findUniqueOrThrow({
      where: { id: data.participant.id },
    });
    assert.equal(
      participant.totalSteps,
      8,
      "active leaderboard totals remain owned by normal race resolution",
    );

    const rows = await RaceImpactEvent.listActivity({
      raceId: data.race.id,
      userId: data.account.user.id,
      limit: 50,
      reconciliationEnabled: true,
    });
    assert.equal(rows.length, 1);
    const activity = activityProjection(rows[0]);
    assert.equal(activity.deltaSteps, 2668);
    assert.equal(activity.impactValueStatus, "RECONCILED");
    assert.equal(activity.wasReconciled, true);
    assert.ok(activity.reconciledAt instanceof Date);

    const projection = await prisma.historicalEffectContribution.findUniqueOrThrow({
      where: {
        raceId_userId_effectId_calculationVersion: {
          raceId: data.race.id,
          userId: data.account.user.id,
          effectId: data.effect.id,
          calculationVersion: 1,
        },
      },
    });
    assert.equal(projection.currentDeltaSteps, 2668);

    await prisma.historicalRaceReconciliationIntent.updateMany({
      where: { raceId: data.race.id, userId: data.account.user.id },
      data: { status: "QUEUED", availableAt: NOW },
    });
    const retry = await worker().runOnce(NOW);
    assert.equal(retry.noop, 1);
    assert.equal(
      await prisma.historicalEffectCorrection.count({ where: { effectId: data.effect.id } }),
      1,
      "replaying the same source generation must not duplicate a correction",
    );
  });

  it("does not revise a receipt when the changed sample window is outside the effect window", async () => {
    const data = await fixture();
    const lateStart = new Date("2026-09-16T11:30:00.000Z");
    const lateEnd = new Date("2026-09-16T11:35:00.000Z");
    await addLateSample(data.account.user.id, {
      start: lateStart,
      end: lateEnd,
      steps: 500,
    });
    await enqueue(data, lateStart, lateEnd);

    const result = await worker().runOnce(NOW);
    assert.equal(result.skipped, 1);
    assert.equal(
      await prisma.historicalEffectContribution.count({ where: { effectId: data.effect.id } }),
      0,
    );

    const [row] = await RaceImpactEvent.listActivity({
      raceId: data.race.id,
      userId: data.account.user.id,
      limit: 50,
      reconciliationEnabled: true,
    });
    const activity = activityProjection(row);
    assert.equal(activity.deltaSteps, 8);
    assert.equal(activity.impactValueStatus, "PROVISIONAL");
    assert.equal(activity.wasReconciled, false);
  });

  it("reconciles an active receipt from the real step-sync path", async () => {
    const wallNow = new Date();
    const raceStart = new Date(wallNow.getTime() - 4 * 60 * 60 * 1000);
    const effectStart = new Date(wallNow.getTime() - 2 * 60 * 60 * 1000);
    const effectEnd = new Date(wallNow.getTime() - 60 * 60 * 1000);
    const raceEnd = new Date(wallNow.getTime() + 24 * 60 * 60 * 1000);
    const account = await createTestUser({ displayName: "Real sync impact" });
    const race = await prisma.race.create({
      data: {
        creatorId: account.user.id,
        name: "Real sync impact reconciliation",
        targetSteps: 100000,
        status: "ACTIVE",
        startedAt: raceStart,
        endsAt: raceEnd,
        timezone: "UTC",
        powerupsEnabled: true,
        timeBased: true,
        maxDurationDays: 2,
      },
    });
    const participant = await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: account.user.id,
        status: "ACCEPTED",
        joinedAt: raceStart,
        totalSteps: 100,
        rawSteps: 100,
      },
    });
    const powerup = await prisma.racePowerup.create({
      data: {
        raceId: race.id,
        participantId: participant.id,
        userId: account.user.id,
        type: "RUNNERS_HIGH",
        rarity: "RARE",
        status: "USED",
      },
    });
    const effect = await prisma.raceActiveEffect.create({
      data: {
        raceId: race.id,
        targetParticipantId: participant.id,
        targetUserId: account.user.id,
        sourceUserId: account.user.id,
        powerupId: powerup.id,
        type: "RUNNERS_HIGH",
        status: "EXPIRED",
        startsAt: effectStart,
        expiresAt: effectEnd,
        metadata: { multiplier: 2, stepsAtBuffStart: 0 },
      },
    });
    await prisma.raceImpactEvent.create({
      data: {
        raceId: race.id,
        recipientUserId: account.user.id,
        sourceKind: "ACTIVE_EFFECT",
        sourceId: effect.id,
        powerupType: "RUNNERS_HIGH",
        deltaSteps: 100,
        description: "Runner’s High wore off. You gained 100 steps.",
        valueStatus: "SYNCED_SNAPSHOT",
        calculationVersion: 2,
        resolvedAt: effectEnd,
      },
    });

    const server = await getSharedServer();
    const response = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: account.token,
      headers: {
        "Idempotency-Key": randomUUID(),
        "X-App-Version": "9.9.9",
      },
      body: {
        date: wallNow.toISOString().slice(0, 10),
        steps: 1000,
        samples: [{
          periodStart: effectStart.toISOString(),
          periodEnd: effectEnd.toISOString(),
          steps: 1000,
        }],
      },
    });
    assert.equal(response.status, 202, await response.text());

    const intent = await prisma.historicalRaceReconciliationIntent.findUniqueOrThrow({
      where: { raceId_userId: { raceId: race.id, userId: account.user.id } },
    });
    assert.equal(intent.status, "QUEUED");
    assert.ok(intent.changedStart.getTime() <= effectStart.getTime());
    assert.ok(intent.changedEnd.getTime() >= effectEnd.getTime());

    const result = await worker().runOnce(new Date());
    assert.equal(result.corrected, 1);

    const [row] = await RaceImpactEvent.listActivity({
      raceId: race.id,
      userId: account.user.id,
      limit: 50,
      reconciliationEnabled: true,
    });
    const activity = activityProjection(row);
    assert.equal(activity.deltaSteps, 1000);
    assert.equal(activity.impactValueStatus, "RECONCILED");
    assert.equal(activity.wasReconciled, true);

    const scoredParticipant = await prisma.raceParticipant.findUniqueOrThrow({
      where: { id: participant.id },
    });
    assert.equal(
      scoredParticipant.totalSteps,
      2000,
      "normal race resolution owns the active leaderboard recompute",
    );
  });


  it("does not admit reconciliation while the timed effect is still active", async () => {
    const wallNow = new Date();
    const raceStart = new Date(wallNow.getTime() - 2 * 60 * 60 * 1000);
    const effectStart = new Date(wallNow.getTime() - 30 * 60 * 1000);
    const effectEnd = new Date(wallNow.getTime() + 30 * 60 * 1000);
    const account = await createTestUser({ displayName: "Active effect guard" });
    const race = await prisma.race.create({
      data: {
        creatorId: account.user.id,
        name: "Active effect guard",
        targetSteps: 100000,
        status: "ACTIVE",
        startedAt: raceStart,
        endsAt: new Date(wallNow.getTime() + 24 * 60 * 60 * 1000),
        timezone: "UTC",
        powerupsEnabled: true,
        timeBased: true,
        maxDurationDays: 2,
      },
    });
    const participant = await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: account.user.id,
        status: "ACCEPTED",
        joinedAt: raceStart,
        totalSteps: 0,
        rawSteps: 0,
      },
    });
    const powerup = await prisma.racePowerup.create({
      data: {
        raceId: race.id,
        participantId: participant.id,
        userId: account.user.id,
        type: "RUNNERS_HIGH",
        rarity: "RARE",
        status: "USED",
      },
    });
    await prisma.raceActiveEffect.create({
      data: {
        raceId: race.id,
        targetParticipantId: participant.id,
        targetUserId: account.user.id,
        sourceUserId: account.user.id,
        powerupId: powerup.id,
        type: "RUNNERS_HIGH",
        status: "ACTIVE",
        startsAt: effectStart,
        expiresAt: effectEnd,
        metadata: { multiplier: 2 },
      },
    });

    const server = await getSharedServer();
    const response = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: account.token,
      headers: {
        "Idempotency-Key": randomUUID(),
        "X-App-Version": "9.9.9",
      },
      body: {
        date: wallNow.toISOString().slice(0, 10),
        steps: 100,
        samples: [{
          periodStart: effectStart.toISOString(),
          periodEnd: new Date(wallNow.getTime() - 5 * 60 * 1000).toISOString(),
          steps: 100,
        }],
      },
    });
    assert.equal(response.status, 202, await response.text());
    assert.equal(
      await prisma.historicalRaceReconciliationIntent.count({
        where: { raceId: race.id, userId: account.user.id },
      }),
      0,
    );
  });

  it("keeps a reconciled zero-impact receipt visible in Activity", async () => {
    const data = await fixture();
    const projection = await prisma.historicalEffectContribution.create({
      data: {
        raceId: data.race.id,
        userId: data.account.user.id,
        effectId: data.effect.id,
        powerupType: "RUNNERS_HIGH",
        currentDeltaSteps: 0,
        sourceGeneration: 3,
        calculationVersion: 1,
      },
    });

    const [row] = await RaceImpactEvent.listActivity({
      raceId: data.race.id,
      userId: data.account.user.id,
      limit: 50,
      reconciliationEnabled: true,
    });
    const activity = activityProjection(row);
    assert.ok(activity);
    assert.equal(activity.deltaSteps, 0);
    assert.equal(activity.impactValueStatus, "RECONCILED");
    assert.equal(activity.wasReconciled, true);
    assert.equal(activity.reconciledAt.getTime(), projection.updatedAt.getTime());
    assert.equal(
      activity.displayDescription,
      "Runner's High 0 steps. Updated after step sync.",
    );
  });

});
