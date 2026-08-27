const assert = require("node:assert/strict");
const { after, before, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
} = require("./setup");
const {
  buildNotificationIntentService,
} = require("../../src/modules/notifications/services/notificationDelivery");
const { createInboxAlert } = require("../../src/modules/inbox/services/inbox");
const { buildInboxDelivery } = require("../../src/modules/inbox/jobs/inboxDelivery");
const { GlobalStepEvent } = require("../../src/modules/steps/models/globalStepEvent");
const {
  ensureEntitlementForUser,
  processDueEntitlementBoundaries,
} = require("../../src/modules/steps/services/globalStepEventEntitlement");
const {
  buildNotificationProjector,
} = require("../../src/modules/domainEvents/services/notificationProjector");

const NOW = new Date("2026-08-23T15:00:00.000Z");

function intent(userId, overrides = {}) {
  return {
    recipientUserId: userId,
    type: "GLOBAL_EVENT_STARTED",
    title: "2x STEPS EVENT",
    body: "Double steps are LIVE.",
    payload: {
      type: "GLOBAL_EVENT_STARTED",
      route: "home",
      multiplier: 2,
      messageId: `event-${userId}`,
      collapseId: "global-event",
      threadId: "global-events",
    },
    deliveryKey: `global-event:${userId}:event-1`,
    availableAt: NOW,
    ...overrides,
  };
}

function integrationIntentService() {
  return buildNotificationIntentService({
    prisma,
    now: () => NOW,
    createInboxAlert: (args) => createInboxAlert({ ...args, prisma }),
    publishWakeup: async () => false,
  });
}

describe("centralized notification delivery", { concurrency: 1 }, () => {
  let server;

  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
    await cleanDatabase();
  });

  it("persists exactly one immediate intent and preserves the complete provider payload", async () => {
    await cleanDatabase();
    const { user } = await createTestUser();
    const service = integrationIntentService();

    await service.submit(intent(user.id));
    await service.submit(intent(user.id));

    const alerts = await prisma.inboxAlert.findMany({ where: { userId: user.id } });
    const outbox = await prisma.inboxDeliveryOutbox.findMany({ where: { alert: { userId: user.id } } });
    assert.equal(alerts.length, 1);
    assert.equal(outbox.length, 1);
    assert.deepEqual(outbox[0].payload, {
      title: "2x STEPS EVENT",
      body: "Double steps are LIVE.",
      destination: { route: "home" },
      payload: intent(user.id).payload,
    });
  });

  it("keeps a scheduled intent invisible until due, then releases it once", async () => {
    await cleanDatabase();
    const { user } = await createTestUser();
    const service = integrationIntentService();
    const scheduled = intent(user.id, {
      deliveryKey: `scheduled:${user.id}:event-2`,
      availableAt: new Date(NOW.getTime() + 60_000),
      expiresAt: new Date(NOW.getTime() + 30 * 60_000),
    });

    await service.submit(scheduled);
    assert.equal(await prisma.inboxAlert.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.notificationSchedule.count({ where: { recipientUserId: user.id } }), 1);

    const released = await service.releaseDue({ now: new Date(NOW.getTime() + 60_000) });
    assert.equal(released.released, 1);
    assert.equal((await service.releaseDue({ now: new Date(NOW.getTime() + 60_000) })).released, 0);
    assert.equal(await prisma.inboxAlert.count({ where: { userId: user.id } }), 1);
    assert.equal((await prisma.notificationSchedule.findFirstOrThrow({ where: { recipientUserId: user.id } })).status, "MATERIALIZED");
  });

  it("two delivery workers race safely, preserve the full payload, and use bounded recipient concurrency", async () => {
    await cleanDatabase();
    const users = await Promise.all(Array.from({ length: 5 }, () => createTestUser()));
    const service = integrationIntentService();
    for (const { user } of users) {
      await prisma.deviceToken.create({
        data: {
          userId: user.id,
          token: `token-${user.id}`,
          platform: "ios",
          status: null,
          lastRegisteredAt: NOW,
        },
      });
      await service.submit(intent(user.id, { deliveryKey: `race:${user.id}` }));
    }

    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const provider = {
      async sendNotification({ payload }) {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        assert.equal(payload.type, "GLOBAL_EVENT_STARTED");
        assert.equal(payload.multiplier, 2);
        return { success: true };
      },
    };
    const worker = () => buildInboxDelivery({
      prisma,
      apnsService: provider,
      fcmService: provider,
      now: () => NOW,
      batchSize: 50,
      concurrency: 2,
      appSettings: { async getFlag() { return false; } },
      userFanoutDisabled: () => false,
    });

    await Promise.all([worker()(), worker()()]);
    assert.equal(calls, 5);
    // Concurrency is bounded per worker. Two workers may each use the
    // configured limit, so the integration ceiling is 2 workers × 2.
    assert.ok(maxActive <= 4, `max active provider calls was ${maxActive}`);
    assert.equal(await prisma.inboxDeliveryOutbox.count({ where: { status: "DELIVERED" } }), 5);
    assert.equal(await prisma.inboxDeliveryOutbox.count({ where: { leaseToken: null } }), 5);
  });

  it("persists no-device, permanent, and transient provider dispositions", async () => {
    await cleanDatabase();
    const noDevice = await createTestUser();
    const permanent = await createTestUser();
    const transient = await createTestUser();
    const service = integrationIntentService();
    await service.submit(intent(noDevice.user.id, { deliveryKey: `outcome:no-device:${noDevice.user.id}` }));
    await service.submit(intent(permanent.user.id, { deliveryKey: `outcome:permanent:${permanent.user.id}` }));
    await service.submit(intent(transient.user.id, { deliveryKey: `outcome:transient:${transient.user.id}` }));
    await prisma.deviceToken.createMany({ data: [
      {
        userId: permanent.user.id,
        token: "permanent",
        platform: "ios",
        status: null,
        lastRegisteredAt: NOW,
      },
      {
        userId: transient.user.id,
        token: "transient",
        platform: "ios",
        status: null,
        lastRegisteredAt: NOW,
      },
    ] });
    const provider = {
      async sendNotification({ deviceToken }) {
        if (deviceToken === "permanent") return { success: false, permanent: true, reason: "INVALID_PAYLOAD" };
        return { success: false, reason: "TEMPORARY_UNAVAILABLE" };
      },
    };
    await buildInboxDelivery({
      prisma, apnsService: provider, fcmService: provider,
      now: () => NOW, batchSize: 10, concurrency: 2,
      appSettings: { async getFlag() { return false; } },
      userFanoutDisabled: () => false,
    })();
    const attempts = await prisma.inboxDeliveryDeviceAttempt.findMany({ orderBy: { tokenHash: "asc" } });
    assert.equal(attempts.filter((row) => row.disposition === "NO_DEVICE").length, 1);
    assert.equal(attempts.filter((row) => row.disposition === "PERMANENT_FAIL").length, 1);
    assert.equal(attempts.filter((row) => row.disposition === "TRANSIENT_FAIL").length, 1);
    assert.equal(await prisma.inboxDeliveryOutbox.count({ where: { status: "RETRY" } }), 1);
    assert.equal(await prisma.inboxDeliveryOutbox.count({ where: { status: "DELIVERED" } }), 2);
  });

  it("legacy global start commits an event, then projection persists the visible intent", async () => {
    await cleanDatabase();
    const { user } = await createTestUser();
    const testNow = new Date();
    const race = await prisma.race.create({
      data: {
        creatorId: user.id,
        name: "Legacy durable event race",
        targetSteps: 1000,
        timeBased: true,
        maxDurationDays: 1,
        status: "ACTIVE",
        startedAt: new Date(testNow.getTime() - 60_000),
        endsAt: new Date(testNow.getTime() + 30 * 60_000),
      },
    });
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: user.id, status: "ACCEPTED", joinedAt: race.startedAt },
    });

    const created = await GlobalStepEvent.createIfAbsentWithEnrollments({
      startsAt: testNow,
      endsAt: new Date(testNow.getTime() + 30 * 60_000),
      multiplier: 2,
      eventDay: "2026-08-23",
    });

    assert.equal(created.created, true);
    assert.equal(await prisma.notificationSchedule.count({ where: { recipientUserId: user.id } }), 0);
    assert.equal(await prisma.inboxAlert.count({ where: { userId: user.id } }), 0);
    await buildNotificationProjector({ prisma, now: () => testNow }).run();
    const alert = await prisma.inboxAlert.findFirstOrThrow({ where: { userId: user.id } });
    const outbox = await prisma.inboxDeliveryOutbox.findFirstOrThrow({ where: { alertId: alert.id } });
    assert.equal(alert.sourceKey, `visible:GLOBAL_EVENT_STARTED:${user.id}:${created.event.id}`);
    assert.ok(outbox.availableAt >= NOW);
    assert.deepEqual(outbox.payload.payload, {
      type: "GLOBAL_EVENT_STARTED",
      route: "home",
      eventId: created.event.id,
      multiplier: 2,
    });
  });

  it("local provisioning stays notification-free and boundary activation projects durably", async () => {
    await cleanDatabase();
    const { user } = await createTestUser({ globalEventTimezone: "America/New_York" });
    const startsAt = new Date("2026-08-24T14:00:00.000Z");
    const endsAt = new Date("2026-08-24T14:30:00.000Z");
    const event = await prisma.globalStepEvent.create({
      data: {
        eventDay: "2026-08-24",
        scheduleMode: "LOCAL_ENTITLEMENTS",
        localStartMinute: 600,
        durationMinutes: 30,
        startsAt,
        endsAt,
        multiplier: 2,
      },
    });
    const race = await prisma.race.create({
      data: {
        creatorId: user.id,
        name: "Local event eligibility race",
        targetSteps: 1000,
        timeBased: true,
        maxDurationDays: 1,
        status: "ACTIVE",
        startedAt: new Date(startsAt.getTime() - 60_000),
        endsAt: new Date(endsAt.getTime() + 60 * 60_000),
      },
    });
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: user.id, status: "ACCEPTED", joinedAt: race.startedAt },
    });

    await prisma.$transaction((tx) => ensureEntitlementForUser(tx, {
      event,
      user,
      now: NOW,
    }));
    assert.equal(await prisma.inboxAlert.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.notificationSchedule.count({ where: { recipientUserId: user.id } }), 0);
    assert.equal(await prisma.domainEventOutbox.count({}), 0);

    const boundary = await processDueEntitlementBoundaries({
      prisma,
      now: startsAt,
      enqueueRaceResolution: async () => {},
      logger: { log() {}, error() {} },
    });
    assert.equal(boundary.starts, 1);
    assert.equal(await prisma.domainEventOutbox.count({
      where: { eventType: "GLOBAL_STEP_EVENT_ACTIVATED_V1" },
    }), 1);
    assert.equal(await prisma.inboxAlert.count({ where: { userId: user.id } }), 0);

    await buildNotificationProjector({ prisma, now: () => startsAt }).run();
    assert.equal(await prisma.inboxAlert.count({ where: { userId: user.id } }), 1);
    assert.equal(await prisma.notificationSchedule.count({ where: { recipientUserId: user.id } }), 0);
    const entitlement = await prisma.globalStepEventEntitlement.findUniqueOrThrow({
      where: { eventId_userId: { eventId: event.id, userId: user.id } },
    });
    const localOutbox = await prisma.inboxDeliveryOutbox.findFirstOrThrow({
      where: { alert: { userId: user.id, type: "GLOBAL_EVENT_STARTED" } },
    });
    assert.deepEqual(localOutbox.payload.payload, {
      type: "GLOBAL_EVENT_STARTED",
      route: "home",
      eventId: event.id,
      entitlementId: entitlement.id,
      multiplier: 2,
    });
  });
});
