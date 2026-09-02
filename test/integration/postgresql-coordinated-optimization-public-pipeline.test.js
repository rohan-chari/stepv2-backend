const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase, createTestUser, getSharedServer, prisma, request,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const {
  buildRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const {
  buildRacePlacementTransitionWorker,
} = require("../../src/modules/races/jobs/racePlacementTransitionWorker");
const {
  buildRaceResolutionPostTaskRunner,
} = require("../../src/modules/races/jobs/raceResolutionPostTaskRunner");
const {
  buildNotificationProjector,
} = require("../../src/modules/domainEvents/services/notificationProjector");
const {
  buildNotificationScheduleRelease,
} = require("../../src/modules/notifications/jobs/notificationScheduleRelease");
const {
  buildInboxDelivery,
} = require("../../src/modules/inbox/jobs/inboxDelivery");
const {
  buildGlobalEventSummaryTick,
} = require("../../src/modules/steps/jobs/globalEventSummary");
const { resolveExpiredRaces } = require("../../src/modules/races/jobs/raceExpiry");

const FEATURES = "impact_summaries,impact_summary_expiry_v1,inbox_v1";
const HOUR_MS = 60 * 60 * 1000;
let server;

async function drain(worker, maximum = 20) {
  const results = [];
  for (let index = 0; index < maximum; index += 1) {
    const result = await worker.processOne();
    if (!result) break;
    results.push(result);
  }
  return results;
}

describe("§30.7 public step-sync durable pipeline", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => {
    await cleanDatabase();
    await appSettings.setFlagsAtomically([
      ["raceQueueV2ClaimingDisabled", false],
      ["inlineRaceResolutionFallback", false],
      ["raceResolutionPostTasksV1Enabled", true],
      ["apiImpactSummariesEnabled", true],
      ["redisCacheHomeImpactSummaryEnabled", false],
      ["apiInboxV1Enabled", true],
    ]);
  });

  it("drives resolution, placement, post-task, event, schedule, Inbox, summary, expiry, and idempotent replay", { timeout: 60_000 }, async () => {
    assert.match(process.env.DATABASE_URL || "", /_test(?:\?|$)/);
    const now = new Date();
    const owner = await createTestUser({ displayName: "Pipeline Owner" });
    const rival = await createTestUser({ displayName: "Pipeline Rival" });
    await prisma.deviceToken.create({ data: {
      userId: owner.user.id, token: `pipeline-${randomUUID()}`, platform: "ios",
      installationId: `pipeline-install-${randomUUID()}`, status: "ACTIVE",
    } });
    const race = await prisma.race.create({ data: {
      creatorId: owner.user.id, name: "Coordinated optimization public pipeline",
      targetSteps: 100_000, status: "ACTIVE", timezone: "UTC",
      startedAt: new Date(now.getTime() - 3 * HOUR_MS),
      endsAt: new Date(now.getTime() + HOUR_MS), powerupsEnabled: false,
    } });
    await prisma.raceParticipant.createMany({ data: [
      {
        raceId: race.id, userId: owner.user.id, status: "ACCEPTED",
        joinedAt: race.startedAt, totalSteps: 0, lastNotifiedPlacement: 2,
      },
      {
        raceId: race.id, userId: rival.user.id, status: "ACCEPTED",
        joinedAt: race.startedAt, totalSteps: 100, lastNotifiedPlacement: 1,
      },
    ] });

    const summaryStartsAt = new Date(now.getTime() - 2 * HOUR_MS);
    const summaryEndsAt = new Date(now.getTime() - HOUR_MS);
    const summaryEvent = await prisma.globalStepEvent.create({ data: {
      startsAt: summaryStartsAt, endsAt: summaryEndsAt, multiplier: 2,
      scheduleMode: "LOCAL_ENTITLEMENTS", summaryAttributionVersion: 2,
    } });
    await prisma.globalStepEventEntitlement.create({ data: {
      eventId: summaryEvent.id, userId: owner.user.id, timezone: "UTC",
      localDate: summaryStartsAt.toISOString().slice(0, 10),
      startsAt: summaryStartsAt, endsAt: summaryEndsAt,
      startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: summaryStartsAt,
      endProcessedAt: summaryEndsAt,
    } });
    await prisma.globalEventRaceImpact.create({ data: {
      eventId: summaryEvent.id, raceId: race.id, userId: owner.user.id,
      status: "PENDING", attributionVersion: 2,
    } });
    await prisma.globalEventSummaryWork.create({ data: {
      eventId: summaryEvent.id, userId: owner.user.id, status: "WAITING_SYNC",
      expiresAt: new Date(now.getTime() + HOUR_MS), requiredRaceCount: 1,
    } });

    const idempotencyKey = randomUUID();
    const syncBody = {
      date: summaryStartsAt.toISOString().slice(0, 10), steps: 1200,
      samples: [{
        periodStart: summaryStartsAt.toISOString(),
        periodEnd: summaryEndsAt.toISOString(), steps: 1200,
        recordingMethod: "automatic",
      }],
    };
    const sync = () => request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: owner.token,
      headers: {
        "Idempotency-Key": idempotencyKey,
        "X-Timezone": "UTC",
        "X-Client-Features": FEATURES,
      },
      body: syncBody,
    });
    const first = await sync();
    assert.equal(first.status, 202);
    const firstBody = await first.json();
    const generationAfterFirst = (await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId: race.id },
    })).generation;
    const replay = await sync();
    assert.equal(replay.status, 202);
    assert.deepEqual(await replay.json(), firstBody);
    assert.equal((await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId: race.id },
    })).generation, generationAfterFirst, "HTTP idempotency replay must not enqueue a new generation");

    await prisma.raceResolutionJobV2.update({
      where: { raceId: race.id }, data: { notBeforeAt: new Date(0) },
    });
    const resolutionWorker = buildRaceResolutionWorkerV2({
      bootAt: 0, logger: { log() {}, warn() {}, error() {} },
    });
    assert.equal((await drain(resolutionWorker)).length, 1);
    const scored = await prisma.raceParticipant.findFirstOrThrow({
      where: { raceId: race.id, userId: owner.user.id },
    });
    assert.equal(scored.totalSteps, 2400, "the captured 2x event is reflected in authoritative scoring");

    const task = await prisma.raceResolutionPostTask.findFirstOrThrow({ where: { raceId: race.id } });
    const postTask = buildRaceResolutionPostTaskRunner({
      env: {}, logger: { log() {}, warn() {}, error() {} },
      async publishSnapshot() {},
      async deliverIntent() { return { accepted: true, disposition: "TEST_ACCEPTED" }; },
      async expireEffects() {},
    });
    const postTaskResult = task.state === "queued"
      ? await postTask.processTaskId(task.id)
      : task;
    assert.ok(["succeeded", "succeeded_with_failures"].includes(postTaskResult.state));

    await prisma.racePlacementTransitionJob.update({
      where: { raceId: race.id }, data: { notBeforeAt: new Date(0) },
    });
    assert.equal((await buildRacePlacementTransitionWorker({
      now: () => new Date(now.getTime() + 1_000),
    }).processOne()).metrics.placementOutcome, "committed");

    const notificationStartsAt = new Date(now.getTime() - 1_000);
    const notificationEndsAt = new Date(now.getTime() + 30 * 60_000);
    const notificationEvent = await prisma.globalStepEvent.create({ data: {
      startsAt: notificationStartsAt, endsAt: notificationEndsAt, multiplier: 2,
      scheduleMode: "LOCAL_ENTITLEMENTS", summaryAttributionVersion: 2,
    } });
    const notificationEntitlement = await prisma.globalStepEventEntitlement.create({ data: {
      eventId: notificationEvent.id, userId: owner.user.id, timezone: "UTC",
      localDate: notificationStartsAt.toISOString().slice(0, 10),
      startsAt: notificationStartsAt, endsAt: notificationEndsAt,
      startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: notificationStartsAt,
    } });
    await prisma.globalEventRaceImpact.create({ data: {
      eventId: notificationEvent.id, raceId: race.id, userId: owner.user.id,
      status: "PENDING", attributionVersion: 2,
    } });
    const scheduledDomainEvent = await prisma.domainEventOutbox.create({ data: {
      eventKey: `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${notificationEntitlement.id}:0`,
      eventType: "GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1", schemaVersion: 1,
      aggregateType: "GLOBAL_STEP_EVENT_ENTITLEMENT", aggregateId: notificationEntitlement.id,
      occurredAt: notificationStartsAt, availableAt: notificationStartsAt,
      payload: {
        eventId: notificationEvent.id, entitlementId: notificationEntitlement.id,
        userId: owner.user.id, multiplier: 2,
        startsAt: notificationStartsAt.toISOString(), endsAt: notificationEndsAt.toISOString(),
        scheduleRevision: 0,
      },
    } });
    await prisma.domainEventAudience.create({ data: {
      domainEventId: scheduledDomainEvent.id, recipientId: owner.user.id, ordinal: 0, facts: {},
    } });
    const projector = buildNotificationProjector({
      prisma, now: () => now, logger: { log() {}, warn() {}, error() {} },
    });
    for (let index = 0; index < 10; index += 1) await projector.run();
    assert.ok(await prisma.domainEventOutbox.count({
      where: { aggregateId: race.id, eventType: "PLACEMENT_CHANGED_V1" },
    }));
    assert.equal(await prisma.notificationSchedule.count({
      where: { recipientUserId: owner.user.id, type: "GLOBAL_EVENT_STARTED" },
    }), 1);

    const release = buildNotificationScheduleRelease({ now: () => now });
    assert.equal((await release()).released, 1);
    const sends = [];
    const provider = { async sendNotification(input) {
      sends.push(input);
      return { success: true, providerMessageId: "pipeline-provider", environment: "test" };
    } };
    const inboxWorker = buildInboxDelivery({
      prisma, now: () => now, apnsService: provider, fcmService: provider,
      userFanoutDisabled: () => false,
      appSettings: { async getFlag() { return false; } },
      logger: { log() {}, warn() {}, error() {} },
    });
    assert.equal((await inboxWorker()).delivered, 1);
    assert.equal(sends.length, 1);

    let summaryTickNow = new Date(now.getTime() + 2 * 60_000);
    const summaryTick = buildGlobalEventSummaryTick({ prisma, now: () => summaryTickNow });
    let summaryUpserts = 0;
    for (let index = 0; index < 3; index += 1) {
      summaryUpserts += (await summaryTick()).upserts;
      summaryTickNow = new Date(summaryTickNow.getTime() + 61_000);
    }
    assert.equal(summaryUpserts, 1);
    const [activeRaceResponse, homeResponse, inboxResponse] = await Promise.all([
      request(server.baseUrl, "GET", "/races", { token: owner.token }),
      request(server.baseUrl, "GET", "/home/race-card", {
        token: owner.token, headers: { "X-Client-Features": FEATURES },
      }),
      request(server.baseUrl, "GET", "/inbox/alerts", {
        token: owner.token, headers: { "X-Client-Features": FEATURES },
      }),
    ]);
    assert.equal((await activeRaceResponse.json()).active[0].myPlacement, 1);
    assert.equal((await homeResponse.json()).globalEventSummary.extraRaceSteps, 1200);
    assert.equal((await inboxResponse.json()).alerts[0].type, "GLOBAL_EVENT_STARTED");

    await prisma.race.update({
      where: { id: race.id }, data: { endsAt: new Date(Date.now() - 1_000) },
    });
    await resolveExpiredRaces();
    const completedResponse = await request(server.baseUrl, "GET", "/races", {
      token: owner.token,
    });
    const completed = await completedResponse.json();
    assert.equal(completed.completed[0].id, race.id);
    assert.equal((await prisma.raceParticipant.findFirstOrThrow({
      where: { raceId: race.id, userId: owner.user.id },
    })).placement, 1);

    const durableCounts = await Promise.all([
      prisma.domainEventOutbox.count(), prisma.notificationSchedule.count(),
      prisma.inboxAlert.count(), prisma.globalEventUserSummary.count(),
    ]);
    await projector.run();
    await release();
    await inboxWorker();
    await summaryTick();
    assert.deepEqual(await Promise.all([
      prisma.domainEventOutbox.count(), prisma.notificationSchedule.count(),
      prisma.inboxAlert.count(), prisma.globalEventUserSummary.count(),
    ]), durableCounts, "worker retry must not duplicate any public-visible output");
  });
});
