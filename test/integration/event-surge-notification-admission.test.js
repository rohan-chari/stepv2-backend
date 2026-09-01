const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
} = require("./setup");
const {
  buildNotificationIntentService,
} = require("../../src/modules/notifications/services/notificationDelivery");
const {
  ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
  GLOBAL_EVENT_DELIVERY_SAFETY_MARGIN_MS,
  claimProviderAttemptPage,
  reconcileLegacyGlobalEventAdmissionResidue,
  releaseEventNotificationPage,
  waitForNotificationAdmissionStartupBarrier,
} = require("../../src/modules/notifications/services/notificationAdmission");
const { buildInboxDelivery, eventCollapseId } = require("../../src/modules/inbox/jobs/inboxDelivery");
const {
  projectScheduledEntitlementEventsBatch,
} = require("../../src/modules/domainEvents/models/domainEventOutbox");
const {
  buildNotificationCompletenessReconciler,
} = require("../../src/modules/notifications/jobs/notificationCompletenessReconciler");

let server;

async function eventFixture({ count = 1, startsAt, endsAt }) {
  const accounts = await Promise.all(Array.from({ length: count }, () => createTestUser()));
  const event = await prisma.globalStepEvent.create({ data: {
    startsAt, endsAt, multiplier: 2, scheduleMode: "LOCAL_ENTITLEMENTS",
    eventDay: "2098-08-26", localStartMinute: 600, durationMinutes: 30,
  } });
  const race = await prisma.race.create({ data: {
    creatorId: accounts[0].user.id, name: "Admission fixture", targetSteps: 10_000,
    status: "ACTIVE", startedAt: new Date(startsAt.getTime() - 60_000),
    endsAt: new Date(endsAt.getTime() + 60_000),
  } });
  const entitlements = [];
  for (const account of accounts) {
    const entitlement = await prisma.globalStepEventEntitlement.create({ data: {
      eventId: event.id, userId: account.user.id, timezone: "UTC", localDate: "2098-08-26",
      startsAt, endsAt, startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: startsAt,
    } });
    entitlements.push(entitlement);
    await prisma.globalEventRaceImpact.create({ data: {
      eventId: event.id, raceId: race.id, userId: account.user.id,
    } });
  }
  return { accounts, event, race, entitlements };
}

describe("event-start durable notification admission", () => {
  before(async () => { server = await getSharedServer(); void server; });
  beforeEach(async () => { await cleanDatabase(); });

  it("stamps the existing payload, stable sequence, and delivery-only safety expiry", async () => {
    const startsAt = new Date("2098-08-26T10:00:00.000Z");
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const fixture = await eventFixture({ startsAt, endsAt });
    const account = fixture.accounts[0];
    const entitlement = fixture.entitlements[0];
    const payload = { type: "GLOBAL_EVENT_STARTED", route: "home", eventId: fixture.event.id, multiplier: 2 };
    const service = buildNotificationIntentService({
      prisma, now: () => startsAt,
      publishNotificationWakeup: async () => true,
      invalidateInboxUnread: async () => true,
    });
    await service.submit({
      recipientUserId: account.user.id,
      type: "GLOBAL_EVENT_STARTED",
      title: "2x STEPS EVENT",
      body: "Double steps are LIVE for 30 minutes. Every step counts 2x in your races! Go!",
      payload,
      deliveryKey: `visible:GLOBAL_EVENT_STARTED:${account.user.id}:${fixture.event.id}`,
      availableAt: startsAt,
      expiresAt: endsAt,
      sourceRef: entitlement.id,
    });
    const schedule = await prisma.notificationSchedule.findFirstOrThrow({});
    assert.equal(schedule.status, "ADMISSION_PENDING");
    assert.equal(schedule.admissionClass, ADMISSION_CLASS_GLOBAL_EVENT_STARTED);
    assert.ok(BigInt(schedule.admissionSequence) >= 0n);
    assert.equal(
      schedule.expiresAt.toISOString(),
      new Date(endsAt.getTime() - GLOBAL_EVENT_DELIVERY_SAFETY_MARGIN_MS).toISOString(),
    );

    const released = await releaseEventNotificationPage({
      prisma, admissionClass: ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
      now: startsAt, maximumRows: 100,
    });
    assert.deepEqual(released, {
      examined: 1, materialized: 1, expired: 0, nextScheduleAt: null,
    });
    const alert = await prisma.inboxAlert.findFirstOrThrow({});
    const outbox = await prisma.inboxDeliveryOutbox.findFirstOrThrow({});
    assert.equal(alert.expiresAt.toISOString(), new Date(startsAt.getTime() + 30 * 24 * 60 * 60_000).toISOString());
    assert.deepEqual(outbox.payload.payload, payload);
    assert.equal(outbox.status, "ADMISSION_FIRST");
    assert.equal(outbox.admissionClass, ADMISSION_CLASS_GLOBAL_EVENT_STARTED);
    assert.equal(outbox.admissionSequence, schedule.admissionSequence);
    assert.equal(outbox.admissionExpiresAt.toISOString(), schedule.expiresAt.toISOString());
  });

  it("fences two allocators, caps downtime credit, and keeps first attempts ahead of retries", async () => {
    const startsAt = new Date("2098-08-26T10:00:00.000Z");
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const fixture = await eventFixture({ count: 130, startsAt, endsAt });
    const service = buildNotificationIntentService({ prisma, now: () => startsAt, publishNotificationWakeup: async () => true });
    for (let index = 0; index < fixture.accounts.length; index += 1) {
      await prisma.deviceToken.create({ data: {
        userId: fixture.accounts[index].user.id,
        token: `admission-device-${index}`, platform: "ios", status: "ACTIVE",
      } });
      await service.submit({
        recipientUserId: fixture.accounts[index].user.id,
        type: "GLOBAL_EVENT_STARTED", title: "2x", body: "Go",
        payload: { type: "GLOBAL_EVENT_STARTED", route: "home", eventId: fixture.event.id, multiplier: 2 },
        deliveryKey: `visible:GLOBAL_EVENT_STARTED:${fixture.accounts[index].user.id}:${fixture.event.id}`,
        availableAt: startsAt, expiresAt: endsAt, sourceRef: fixture.entitlements[index].id,
      });
    }
    await releaseEventNotificationPage({ prisma, admissionClass: ADMISSION_CLASS_GLOBAL_EVENT_STARTED, now: startsAt, maximumRows: 500 });
    const retry = await prisma.inboxDeliveryOutbox.findFirstOrThrow({ orderBy: { admissionSequence: "desc" } });
    await prisma.inboxDeliveryOutbox.update({ where: { id: retry.id }, data: { status: "ADMISSION_RETRY" } });

    const simultaneous = await Promise.all([
      claimProviderAttemptPage({ prisma, admissionClass: ADMISSION_CLASS_GLOBAL_EVENT_STARTED, now: startsAt, maximumRows: 100 }),
      claimProviderAttemptPage({ prisma, admissionClass: ADMISSION_CLASS_GLOBAL_EVENT_STARTED, now: startsAt, maximumRows: 100 }),
    ]);
    assert.equal(simultaneous.reduce((sum, page) => sum + page.claimed.length, 0), 1);
    assert.notEqual(simultaneous.flatMap((page) => page.claimed)[0].id, retry.id);

    const afterDowntime = await claimProviderAttemptPage({
      prisma, admissionClass: ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
      now: new Date(startsAt.getTime() + 60_000), maximumRows: 100,
    });
    assert.equal(afterDowntime.claimed.length, 1, "downtime rebases credit instead of creating a catch-up page");
    assert.ok(afterDowntime.claimed.every((row) => row.id !== retry.id), "due first attempts precede retries");
  });

  it("charges lane capacity for each due device provider attempt, not each recipient outbox", async () => {
    const startsAt = new Date("2098-08-26T10:00:00.000Z");
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const fixture = await eventFixture({ startsAt, endsAt });
    const userId = fixture.accounts[0].user.id;
    await prisma.deviceToken.createMany({ data: [0, 1, 2].map((index) => ({
      userId, token: `provider-target-${index}`, platform: "ios", status: "ACTIVE",
      installationId: `installation-${index}`,
    })) });
    const alert = await prisma.inboxAlert.create({ data: {
      userId, type: "GLOBAL_EVENT_STARTED", destination: { route: "home" },
      title: "2x", body: "Go", sourceKey: `visible:GLOBAL_EVENT_STARTED:${userId}:${fixture.event.id}`,
      createdAt: startsAt, expiresAt: endsAt,
    } });
    const outbox = await prisma.inboxDeliveryOutbox.create({ data: {
      alertId: alert.id, payload: { title: "2x", body: "Go" }, status: "ADMISSION_FIRST",
      availableAt: startsAt, admissionClass: ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
      admissionSequence: 1n,
      admissionExpiresAt: new Date(endsAt.getTime() - GLOBAL_EVENT_DELIVERY_SAFETY_MARGIN_MS),
    } });

    const tooEarly = await claimProviderAttemptPage({ prisma, now: startsAt, maximumRows: 100 });
    assert.equal(tooEarly.claimed.length, 0, "one available token cannot admit a three-device outbox");
    const admitted = await claimProviderAttemptPage({
      prisma, now: new Date(startsAt.getTime() + 20), maximumRows: 100,
    });
    assert.deepEqual(admitted.claimed.map((row) => row.id), [outbox.id]);
    assert.equal(admitted.claimed[0].admissionCost, 3);
    assert.equal(admitted.nextTokenAt.toISOString(), new Date(startsAt.getTime() + 30).toISOString());
  });

  it("claims an admitted retry once no due first attempt remains", async () => {
    const current = new Date("2098-08-26T10:00:00.000Z");
    const account = await createTestUser();
    await prisma.deviceToken.create({ data: {
      userId: account.user.id, token: "admission-retry-device", platform: "ios",
      installationId: "admission-retry-installation", status: "ACTIVE",
    } });
    const alert = await prisma.inboxAlert.create({ data: {
      userId: account.user.id, type: "GLOBAL_EVENT_STARTED", destination: { route: "home" },
      title: "2x", body: "Go", sourceKey: `visible:GLOBAL_EVENT_STARTED:${account.user.id}:retry`,
      createdAt: current, expiresAt: new Date(current.getTime() + 30 * 24 * 60 * 60_000),
    } });
    const outbox = await prisma.inboxDeliveryOutbox.create({ data: {
      alertId: alert.id, payload: { title: "2x", body: "Go" }, status: "ADMISSION_RETRY",
      availableAt: current, admissionClass: ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
      admissionSequence: 1n, admissionExpiresAt: new Date(current.getTime() + 120_000),
    } });

    const page = await claimProviderAttemptPage({ prisma, now: current, maximumRows: 100 });

    assert.deepEqual(page.claimed.map((row) => row.id), [outbox.id]);
    assert.equal(page.claimed[0].admissionCost, 1);
  });

  it("fences a stale admitted provider owner from overwriting the reclaiming owner's result", async () => {
    const startsAt = new Date("2098-08-26T10:00:00.000Z");
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const fixture = await eventFixture({ startsAt, endsAt });
    const userId = fixture.accounts[0].user.id;
    const token = await prisma.deviceToken.create({ data: {
      userId, token: "stale-owner-token", platform: "ios", status: "ACTIVE",
      installationId: "stale-owner-installation", ownershipGeneration: 1,
    } });
    const alert = await prisma.inboxAlert.create({ data: {
      userId, type: "GLOBAL_EVENT_STARTED", destination: { route: "home" },
      title: "2x", body: "Go", sourceKey: `visible:GLOBAL_EVENT_STARTED:${userId}:${fixture.event.id}`,
      createdAt: startsAt, expiresAt: endsAt,
    } });
    const outbox = await prisma.inboxDeliveryOutbox.create({ data: {
      alertId: alert.id, payload: { title: "2x", body: "Go" }, status: "ADMISSION_FIRST",
      availableAt: startsAt, admissionClass: ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
      admissionSequence: 1n,
      admissionExpiresAt: new Date(endsAt.getTime() - GLOBAL_EVENT_DELIVERY_SAFETY_MARGIN_MS),
    } });
    let releaseStaleProvider;
    let staleProviderStarted;
    const staleProviderStartedPromise = new Promise((resolve) => { staleProviderStarted = resolve; });
    const staleProviderResult = new Promise((resolve) => { releaseStaleProvider = resolve; });
    const common = {
      prisma, logger: { log() {}, error() {} }, userFanoutDisabled: () => false,
      appSettings: { getFlag: async () => false }, concurrency: 1, batchSize: 10,
    };
    const staleWorker = buildInboxDelivery({
      ...common, now: () => startsAt,
      apnsService: { async sendNotification() {
        staleProviderStarted();
        return staleProviderResult;
      } },
    });
    const staleRun = staleWorker();
    await staleProviderStartedPromise;

    const reclaimAt = new Date(startsAt.getTime() + 31_000);
    const reclaimingWorker = buildInboxDelivery({
      ...common, now: () => reclaimAt,
      apnsService: { async sendNotification() {
        return { success: true, providerMessageId: "winner", environment: "production" };
      } },
    });
    const reclaimed = await reclaimingWorker();
    assert.equal(reclaimed.delivered, 1);
    releaseStaleProvider({ success: false, invalidToken: true, reason: "stale-invalid" });
    await staleRun;

    const [savedOutbox, savedAttempt, savedToken] = await Promise.all([
      prisma.inboxDeliveryOutbox.findUniqueOrThrow({ where: { id: outbox.id } }),
      prisma.inboxDeliveryDeviceAttempt.findFirstOrThrow({ where: { outboxId: outbox.id } }),
      prisma.deviceToken.findUniqueOrThrow({ where: { id: token.id } }),
    ]);
    assert.equal(savedOutbox.status, "DELIVERED");
    assert.equal(savedAttempt.disposition, "ACCEPTED");
    assert.equal(savedAttempt.providerMessageId, "winner");
    assert.equal(savedToken.status, "ACTIVE");
  });

  it("fences initial push attribution creation from a stale admitted owner", async () => {
    const startsAt = new Date("2098-08-26T10:00:00.000Z");
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const fixture = await eventFixture({ startsAt, endsAt });
    const userId = fixture.accounts[0].user.id;
    const epoch = await prisma.adminMetricsCollectionEpoch.create({ data: { startedAt: startsAt } });
    await prisma.deviceToken.create({ data: {
      userId, token: "stale-attribution-token", platform: "ios", status: "ACTIVE",
      installationId: "stale-attribution-installation", ownershipGeneration: 1,
      adminMetricsOpenCapable: true, adminMetricsOpenEpochId: epoch.id,
    } });
    const alert = await prisma.inboxAlert.create({ data: {
      userId, type: "GLOBAL_EVENT_STARTED", destination: { route: "home" },
      title: "2x", body: "Go", sourceKey: `visible:GLOBAL_EVENT_STARTED:${userId}:${fixture.event.id}`,
      createdAt: startsAt, expiresAt: endsAt,
    } });
    const outbox = await prisma.inboxDeliveryOutbox.create({ data: {
      alertId: alert.id, payload: { title: "2x", body: "Go" }, status: "ADMISSION_FIRST",
      availableAt: startsAt, admissionClass: ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
      admissionSequence: 1n,
      admissionExpiresAt: new Date(endsAt.getTime() - GLOBAL_EVENT_DELIVERY_SAFETY_MARGIN_MS),
    } });
    let releaseAttribution;
    let attributionReached;
    const attributionReachedPromise = new Promise((resolve) => { attributionReached = resolve; });
    const attributionBlocked = new Promise((resolve) => { releaseAttribution = resolve; });
    let staleProviderCalls = 0;
    const common = {
      prisma, logger: { log() {}, error() {} }, userFanoutDisabled: () => false,
      appSettings: { getFlag: async () => true }, concurrency: 1, batchSize: 10,
    };
    const staleWorker = buildInboxDelivery({
      ...common, now: () => startsAt,
      beforePushAttribution: async () => {
        attributionReached();
        await attributionBlocked;
      },
      apnsService: { async sendNotification() {
        staleProviderCalls += 1;
        throw new Error("stale owner must not reach provider");
      } },
    });
    const staleRun = staleWorker();
    await attributionReachedPromise;

    const reclaimAt = new Date(startsAt.getTime() + 31_000);
    const reclaimingWorker = buildInboxDelivery({
      ...common, now: () => reclaimAt,
      apnsService: { async sendNotification() {
        return { success: true, providerMessageId: "attribution-winner", environment: "production" };
      } },
    });
    assert.equal((await reclaimingWorker()).delivered, 1);
    releaseAttribution();
    await staleRun;

    assert.equal(staleProviderCalls, 0);
    assert.equal(await prisma.pushDelivery.count({ where: { userId } }), 1);
    const [savedOutbox, savedDelivery] = await Promise.all([
      prisma.inboxDeliveryOutbox.findUniqueOrThrow({ where: { id: outbox.id } }),
      prisma.pushDelivery.findFirstOrThrow({ where: { userId } }),
    ]);
    assert.equal(savedOutbox.status, "DELIVERED");
    assert.equal(savedDelivery.openCapable, true);
    assert.equal(savedDelivery.providerAcceptedAt.toISOString(), reclaimAt.toISOString());
  });

  it("records an admitted first attempt before provider I/O at the delivery-window boundary", async () => {
    const startsAt = new Date("2098-08-26T10:00:00.000Z");
    const initialAttemptAt = new Date(startsAt.getTime() + 119_990);
    const responseAt = new Date(startsAt.getTime() + 120_490);
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const fixture = await eventFixture({ startsAt, endsAt });
    const userId = fixture.accounts[0].user.id;
    await prisma.deviceToken.create({ data: {
      userId, token: "boundary-attempt-token", platform: "ios", status: "ACTIVE",
      installationId: "boundary-attempt-installation", ownershipGeneration: 1,
    } });
    const alert = await prisma.inboxAlert.create({ data: {
      userId, type: "GLOBAL_EVENT_STARTED", destination: { route: "home" },
      title: "2x", body: "Go", sourceKey: `visible:GLOBAL_EVENT_STARTED:${userId}:${fixture.event.id}`,
      createdAt: startsAt, expiresAt: endsAt,
    } });
    await prisma.inboxDeliveryOutbox.create({ data: {
      alertId: alert.id, payload: { title: "2x", body: "Go" }, status: "ADMISSION_FIRST",
      availableAt: startsAt, admissionClass: ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
      admissionSequence: 1n, admissionExpiresAt: new Date(startsAt.getTime() + 180_000),
    } });
    let current = initialAttemptAt;
    const deliver = buildInboxDelivery({
      prisma, now: () => current, userFanoutDisabled: () => false,
      appSettings: { getFlag: async () => false }, logger: { log() {}, error() {} },
      apnsService: { async sendNotification() {
        current = responseAt;
        return { success: true, providerMessageId: "boundary-success", environment: "production" };
      } },
    });

    assert.equal((await deliver()).delivered, 1);
    const attempt = await prisma.inboxDeliveryDeviceAttempt.findFirstOrThrow({});
    assert.equal(attempt.firstAttemptedAt.toISOString(), initialAttemptAt.toISOString());
    assert.equal(attempt.providerRespondedAt.toISOString(), responseAt.toISOString());
  });

  it("legacy claimers cannot see admitted work and expired admitted leases consume a fresh token", async () => {
    const startsAt = new Date("2098-08-26T10:00:00.000Z");
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const fixture = await eventFixture({ startsAt, endsAt });
    const account = fixture.accounts[0];
    const alert = await prisma.inboxAlert.create({ data: {
      userId: account.user.id, type: "GLOBAL_EVENT_STARTED", destination: { route: "home" },
      title: "2x", body: "Go", sourceKey: `visible:GLOBAL_EVENT_STARTED:${account.user.id}:${fixture.event.id}`,
      createdAt: startsAt, expiresAt: new Date(startsAt.getTime() + 30 * 24 * 60 * 60_000),
    } });
    const outbox = await prisma.inboxDeliveryOutbox.create({ data: {
      alertId: alert.id, payload: { title: "2x", body: "Go", payload: { type: "GLOBAL_EVENT_STARTED", route: "home" } },
      status: "ADMISSION_LEASED", availableAt: startsAt,
      leaseUntil: new Date(startsAt.getTime() - 1), leaseToken: "old-admission-lease",
      admissionClass: ADMISSION_CLASS_GLOBAL_EVENT_STARTED, admissionSequence: 1n,
      admissionExpiresAt: new Date(endsAt.getTime() - GLOBAL_EVENT_DELIVERY_SAFETY_MARGIN_MS),
    } });
    const legacy = buildInboxDelivery({
      prisma, now: () => startsAt,
      claimProviderAttemptPage: async () => ({ claimed: [], nextTokenAt: startsAt }),
      apnsService: { async sendNotification() { throw new Error("must not send"); } },
      fcmService: { async sendNotification() { throw new Error("must not send"); } },
      logger: { log() {}, error() {} },
    });
    assert.deepEqual(await legacy(), { claimed: 0, delivered: 0, expired: 0 });
    const claimed = await claimProviderAttemptPage({
      prisma, admissionClass: ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
      now: startsAt, maximumRows: 100,
    });
    assert.deepEqual(claimed.claimed.map((row) => row.id), [outbox.id]);
    assert.notEqual(claimed.claimed[0].leaseToken, "old-admission-lease");
  });

  it("permanent reconciliation stamps mixed-version residue without changing accepted device state", async () => {
    const startsAt = new Date("2098-08-26T10:00:00.000Z");
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const fixture = await eventFixture({ startsAt, endsAt });
    const account = fixture.accounts[0];
    const alert = await prisma.inboxAlert.create({ data: {
      userId: account.user.id, type: "GLOBAL_EVENT_STARTED", destination: { route: "home" },
      title: "2x", body: "Go", sourceKey: `visible:GLOBAL_EVENT_STARTED:${account.user.id}:${fixture.event.id}`,
      createdAt: startsAt, expiresAt: new Date(startsAt.getTime() + 30 * 24 * 60 * 60_000),
    } });
    const outbox = await prisma.inboxDeliveryOutbox.create({ data: {
      alertId: alert.id, payload: { title: "2x", body: "Go" }, status: "LEASED",
      availableAt: startsAt, leaseUntil: new Date(startsAt.getTime() - 1), leaseToken: "legacy-lease",
      acceptedTokens: ["accepted-hash"], expiresAt: endsAt,
    } });
    await prisma.inboxDeliveryDeviceAttempt.create({ data: {
      outboxId: outbox.id, tokenHash: "accepted-hash", disposition: "ACCEPTED", attemptCount: 1,
      acceptedAt: startsAt,
    } });
    const result = await reconcileLegacyGlobalEventAdmissionResidue({ prisma, now: startsAt, maximumRows: 100 });
    assert.equal(result.outboxesStamped, 1);
    const repaired = await prisma.inboxDeliveryOutbox.findUniqueOrThrow({ where: { id: outbox.id } });
    assert.equal(repaired.status, "ADMISSION_RETRY");
    assert.deepEqual(repaired.acceptedTokens, ["accepted-hash"]);
    assert.equal((await prisma.inboxDeliveryDeviceAttempt.findFirstOrThrow({ where: { outboxId: outbox.id } })).disposition, "ACCEPTED");
  });

  it("bulk entitlement projection directly stamps admission and upgrades a same-revision legacy schedule conflict", async () => {
    const startsAt = new Date("2098-08-26T10:00:00.000Z");
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const fixture = await eventFixture({ startsAt, endsAt });
    const account = fixture.accounts[0];
    const entitlement = fixture.entitlements[0];
    const deliveryKey = `visible:GLOBAL_EVENT_STARTED:${account.user.id}:${fixture.event.id}`;
    await prisma.notificationSchedule.create({ data: {
      recipientUserId: account.user.id, type: "GLOBAL_EVENT_STARTED", title: "legacy",
      body: "legacy", payload: { type: "GLOBAL_EVENT_STARTED", route: "home" },
      deliveryKey, availableAt: startsAt, expiresAt: endsAt, status: "PENDING",
      sourceRef: entitlement.id, sourceRevision: 0,
    } });
    const domainEvent = await prisma.domainEventOutbox.create({ data: {
      eventKey: `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${entitlement.id}:0`,
      eventType: "GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1", schemaVersion: 1,
      aggregateType: "GLOBAL_STEP_EVENT_ENTITLEMENT", aggregateId: entitlement.id,
      occurredAt: startsAt, availableAt: startsAt,
      payload: {
        eventId: fixture.event.id, entitlementId: entitlement.id, userId: account.user.id,
        multiplier: 2, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
        scheduleRevision: 0,
      },
    } });
    await prisma.domainEventAudience.create({ data: {
      domainEventId: domainEvent.id, recipientId: account.user.id, ordinal: 0, facts: {},
    } });

    assert.equal((await projectScheduledEntitlementEventsBatch({ prisma, now: startsAt, batchSize: 10 })).processed, 1);
    const schedule = await prisma.notificationSchedule.findFirstOrThrow({ where: { deliveryKey } });
    assert.equal(schedule.status, "ADMISSION_PENDING");
    assert.equal(schedule.admissionClass, ADMISSION_CLASS_GLOBAL_EVENT_STARTED);
    assert.ok(schedule.admissionSequence != null);
    assert.equal(schedule.expiresAt.toISOString(), new Date(endsAt.getTime() - 60_000).toISOString());
  });

  it("paces two worker-equivalent scheduled projectors through one database lane", async () => {
    const startsAt = new Date("2098-08-26T10:00:00.000Z");
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const fixture = await eventFixture({ count: 2, startsAt, endsAt });
    for (let index = 0; index < fixture.accounts.length; index += 1) {
      const account = fixture.accounts[index];
      const entitlement = fixture.entitlements[index];
      const domainEvent = await prisma.domainEventOutbox.create({ data: {
        eventKey: `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${entitlement.id}:0`,
        eventType: "GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1", schemaVersion: 1,
        aggregateType: "GLOBAL_STEP_EVENT_ENTITLEMENT", aggregateId: entitlement.id,
        occurredAt: startsAt, availableAt: startsAt,
        payload: {
          eventId: fixture.event.id, entitlementId: entitlement.id,
          userId: account.user.id, multiplier: 2,
          startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
          scheduleRevision: 0,
        },
      } });
      await prisma.domainEventAudience.create({ data: {
        domainEventId: domainEvent.id, recipientId: account.user.id,
        ordinal: 0, facts: {},
      } });
    }

    const results = [
      await projectScheduledEntitlementEventsBatch({ prisma, now: startsAt, batchSize: 1 }),
      await projectScheduledEntitlementEventsBatch({ prisma, now: startsAt, batchSize: 1 }),
    ];
    assert.deepEqual(results.map((row) => row.processed).sort(), [0, 1]);
    assert.equal(await prisma.domainEventOutbox.count({ where: { status: "PENDING" } }), 1);
    assert.equal((await projectScheduledEntitlementEventsBatch({
      prisma, now: new Date(startsAt.getTime() + 1_000), batchSize: 1,
    })).processed, 1);
  });

  it("runs entitlement domain event through the bulk projector, admission lane, and real provider contract", async () => {
    const startsAt = new Date("2098-08-26T10:00:00.000Z");
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const fixture = await eventFixture({ startsAt, endsAt });
    const account = fixture.accounts[0];
    const entitlement = fixture.entitlements[0];
    await prisma.deviceToken.create({ data: {
      userId: account.user.id, token: "full-chain-provider-token", platform: "ios",
      installationId: "full-chain-installation", status: "ACTIVE",
    } });
    const domainEvent = await prisma.domainEventOutbox.create({ data: {
      eventKey: `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${entitlement.id}:0`,
      eventType: "GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1", schemaVersion: 1,
      aggregateType: "GLOBAL_STEP_EVENT_ENTITLEMENT", aggregateId: entitlement.id,
      occurredAt: startsAt, availableAt: startsAt,
      payload: {
        eventId: fixture.event.id, entitlementId: entitlement.id, userId: account.user.id,
        multiplier: 2, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
        scheduleRevision: 0,
      },
    } });
    await prisma.domainEventAudience.create({ data: {
      domainEventId: domainEvent.id, recipientId: account.user.id, ordinal: 0, facts: {},
    } });

    assert.equal((await projectScheduledEntitlementEventsBatch({ prisma, now: startsAt })).processed, 1);
    const sends = [];
    const invalidations = [];
    const deliver = buildInboxDelivery({
      prisma, now: () => startsAt, userFanoutDisabled: () => false,
      appSettings: { getFlag: async () => false }, logger: { log() {}, error() {} },
      invalidateInboxUnreadMany: async (userIds) => invalidations.push([...userIds]),
      apnsService: { async sendNotification(input) {
        sends.push(input);
        return { success: true, providerMessageId: "full-chain-provider", environment: "production" };
      } },
    });
    const result = await deliver();

    assert.equal(result.delivered, 1);
    assert.equal(sends.length, 1);
    assert.deepEqual(invalidations, [[account.user.id]]);
    assert.deepEqual(sends[0].payload, {
      type: "GLOBAL_EVENT_STARTED", route: "home", eventId: fixture.event.id,
      multiplier: 2, entitlementId: entitlement.id,
    });
    const deliveredRow = await prisma.inboxDeliveryOutbox.findFirstOrThrow({
      include: { alert: true },
    });
    assert.equal(sends[0].collapseId, eventCollapseId(deliveredRow));
    const [schedule, outbox, attempt] = await Promise.all([
      prisma.notificationSchedule.findFirstOrThrow({}),
      prisma.inboxDeliveryOutbox.findFirstOrThrow({}),
      prisma.inboxDeliveryDeviceAttempt.findFirstOrThrow({}),
    ]);
    assert.equal(schedule.status, "MATERIALIZED");
    assert.equal(outbox.status, "DELIVERED");
    assert.equal(attempt.disposition, "ACCEPTED");
  });

  it("startup barrier drains and counts both legacy schedules and outboxes", async () => {
    const startsAt = new Date("2098-08-26T10:00:00.000Z");
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const fixture = await eventFixture({ startsAt, endsAt });
    const account = fixture.accounts[0];
    const entitlement = fixture.entitlements[0];
    const deliveryKey = `visible:GLOBAL_EVENT_STARTED:${account.user.id}:${fixture.event.id}`;
    await prisma.notificationSchedule.create({ data: {
      recipientUserId: account.user.id, type: "GLOBAL_EVENT_STARTED", title: "2x", body: "Go",
      payload: { type: "GLOBAL_EVENT_STARTED", route: "home" }, deliveryKey,
      availableAt: startsAt, expiresAt: endsAt, status: "PENDING", sourceRef: entitlement.id,
    } });
    const alert = await prisma.inboxAlert.create({ data: {
      userId: account.user.id, type: "GLOBAL_EVENT_STARTED", destination: { route: "home" },
      title: "2x", body: "Go", sourceKey: deliveryKey, createdAt: startsAt,
      expiresAt: new Date(startsAt.getTime() + 30 * 24 * 60 * 60_000),
    } });
    await prisma.inboxDeliveryOutbox.create({ data: {
      alertId: alert.id, payload: { title: "2x", body: "Go" }, status: "PENDING",
      availableAt: startsAt, expiresAt: endsAt,
    } });

    const result = await waitForNotificationAdmissionStartupBarrier({
      prisma, now: () => startsAt, sleep: async () => {}, maximumWaitMs: 1_000, maximumRows: 1,
    });
    assert.equal(result.residue, 0);
    assert.equal(result.scheduleResidue, 0);
    assert.equal(result.outboxResidue, 0);
    assert.equal((await prisma.notificationSchedule.findFirstOrThrow({})).status, "ADMISSION_PENDING");
    assert.equal((await prisma.inboxDeliveryOutbox.findFirstOrThrow({})).status, "ADMISSION_FIRST");
  });

  it("converts a legacy outbox conflict to admitted first-attempt ownership", async () => {
    const startsAt = new Date("2098-08-26T10:00:00.000Z");
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const fixture = await eventFixture({ startsAt, endsAt });
    const recipientUserId = fixture.accounts[0].user.id;
    const deliveryKey = `visible:GLOBAL_EVENT_STARTED:${recipientUserId}:${fixture.event.id}`;
    const alert = await prisma.inboxAlert.create({ data: {
      userId: recipientUserId, type: "GLOBAL_EVENT_STARTED", title: "legacy",
      body: "legacy", destination: { route: "home" }, sourceKey: deliveryKey,
      expiresAt: endsAt,
    } });
    const legacy = await prisma.inboxDeliveryOutbox.create({ data: {
      alertId: alert.id, kind: "PUSH", payload: { title: "legacy", body: "legacy" },
      status: "PENDING", availableAt: startsAt, expiresAt: endsAt,
    } });
    await prisma.notificationSchedule.create({ data: {
      recipientUserId, type: "GLOBAL_EVENT_STARTED", title: "current", body: "current",
      payload: { type: "GLOBAL_EVENT_STARTED", route: "home", eventId: fixture.event.id },
      deliveryKey, availableAt: startsAt,
      expiresAt: new Date(endsAt.getTime() - GLOBAL_EVENT_DELIVERY_SAFETY_MARGIN_MS),
      status: "ADMISSION_PENDING", sourceRef: fixture.entitlements[0].id,
      admissionClass: ADMISSION_CLASS_GLOBAL_EVENT_STARTED, admissionSequence: 1n,
    } });

    await releaseEventNotificationPage({ prisma, now: startsAt });

    const upgraded = await prisma.inboxDeliveryOutbox.findUniqueOrThrow({ where: { id: legacy.id } });
    assert.equal(upgraded.status, "ADMISSION_FIRST");
    assert.equal(upgraded.admissionClass, ADMISSION_CLASS_GLOBAL_EVENT_STARTED);
    assert.equal(upgraded.admissionSequence, 1n);
  });

  it("invalidates unread cache once for the materialized recipient page and excludes cancellations from pending telemetry", async () => {
    const startsAt = new Date("2098-08-26T10:00:00.000Z");
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const fixture = await eventFixture({ count: 2, startsAt, endsAt });
    for (let index = 0; index < fixture.accounts.length; index += 1) {
      const userId = fixture.accounts[index].user.id;
      await prisma.notificationSchedule.create({ data: {
        recipientUserId: userId, type: "GLOBAL_EVENT_STARTED", title: "current", body: "current",
        payload: { type: "GLOBAL_EVENT_STARTED", route: "home", eventId: fixture.event.id },
        deliveryKey: `visible:GLOBAL_EVENT_STARTED:${userId}:${fixture.event.id}`,
        availableAt: startsAt,
        expiresAt: new Date(endsAt.getTime() - GLOBAL_EVENT_DELIVERY_SAFETY_MARGIN_MS),
        status: "ADMISSION_PENDING", sourceRef: fixture.entitlements[index].id,
        admissionClass: ADMISSION_CLASS_GLOBAL_EVENT_STARTED, admissionSequence: BigInt(index + 1),
      } });
    }
    await prisma.globalStepEventEntitlement.update({
      where: { id: fixture.entitlements[1].id }, data: { startOutcome: "NO_ACTIVE_RACES" },
    });
    const invalidations = [];
    const telemetry = [];

    const result = await releaseEventNotificationPage({
      prisma, now: startsAt,
      invalidateUnreadBatch: async (userIds) => {
        invalidations.push([...userIds]);
        throw new Error("redis unavailable");
      },
      telemetry: { recordNotification: (value) => telemetry.push(value) },
    });

    assert.equal(result.materialized, 1);
    assert.equal(invalidations.length, 1);
    assert.deepEqual(invalidations[0], [fixture.accounts[0].user.id]);
    assert.equal(telemetry.at(-1).schedulesPending, 0);
    assert.equal(telemetry.at(-1).canceled, 1);
  });

  it("serializes admitted completeness rearm so a retry cannot jump newly restored first work", async () => {
    const startsAt = new Date("2098-08-26T10:00:00.000Z");
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const fixture = await eventFixture({ count: 2, startsAt, endsAt });
    const firstUserId = fixture.accounts[0].user.id;
    const retryUserId = fixture.accounts[1].user.id;
    await prisma.deviceToken.createMany({ data: [
      { userId: firstUserId, token: "rearmed-first-device", platform: "ios", status: "ACTIVE" },
      { userId: retryUserId, token: "waiting-retry-device", platform: "ios", status: "ACTIVE" },
    ] });
    const rearmedSchedule = await prisma.notificationSchedule.create({ data: {
      recipientUserId: firstUserId, type: "GLOBAL_EVENT_STARTED", title: "2x", body: "Go",
      payload: { type: "GLOBAL_EVENT_STARTED", route: "home", eventId: fixture.event.id },
      deliveryKey: `visible:GLOBAL_EVENT_STARTED:${firstUserId}:${fixture.event.id}`,
      availableAt: startsAt,
      expiresAt: new Date(endsAt.getTime() - GLOBAL_EVENT_DELIVERY_SAFETY_MARGIN_MS),
      status: "MATERIALIZED", claimedAt: startsAt, releasedAt: startsAt,
      sourceRef: fixture.entitlements[0].id,
      admissionClass: ADMISSION_CLASS_GLOBAL_EVENT_STARTED, admissionSequence: 1n,
    } });
    const retryAlert = await prisma.inboxAlert.create({ data: {
      userId: retryUserId, type: "GLOBAL_EVENT_STARTED", destination: { route: "home" },
      title: "2x", body: "Go", sourceKey: `visible:GLOBAL_EVENT_STARTED:${retryUserId}:${fixture.event.id}`,
      createdAt: startsAt, expiresAt: endsAt,
    } });
    const retryOutbox = await prisma.inboxDeliveryOutbox.create({ data: {
      alertId: retryAlert.id, payload: { title: "2x", body: "Go" }, status: "ADMISSION_RETRY",
      availableAt: startsAt, admissionClass: ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
      admissionSequence: 2n,
      admissionExpiresAt: new Date(endsAt.getTime() - GLOBAL_EVENT_DELIVERY_SAFETY_MARGIN_MS),
    } });
    let releaseLane;
    let laneLocked;
    const laneLockedPromise = new Promise((resolve) => { laneLocked = resolve; });
    const laneBlocked = new Promise((resolve) => { releaseLane = resolve; });
    const reconcile = buildNotificationCompletenessReconciler({
      prisma, now: () => startsAt,
      afterAdmissionLaneLock: async () => {
        laneLocked();
        await laneBlocked;
      },
    });

    const reconciliation = reconcile();
    await laneLockedPromise;
    const concurrentClaim = claimProviderAttemptPage({ prisma, now: startsAt, maximumRows: 10 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseLane();
    assert.equal((await reconciliation).materializationGapsRearmed, 1);
    const claimed = await concurrentClaim;

    assert.equal(claimed.claimed.length, 1);
    assert.notEqual(claimed.claimed[0].id, retryOutbox.id);
    assert.equal((await prisma.notificationSchedule.findUniqueOrThrow({
      where: { id: rearmedSchedule.id },
    })).status, "MATERIALIZED");
    assert.equal((await prisma.inboxDeliveryOutbox.findUniqueOrThrow({
      where: { id: retryOutbox.id },
    })).status, "ADMISSION_RETRY");
  });
});
