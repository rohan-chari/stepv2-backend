const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { before, beforeEach, describe, it } = require("node:test");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
  startServer,
} = require("./setup");
const { appendDomainEvent, buildDomainEventProjectionJob } = require("../../src/modules/domainEvents");
const {
  buildNotificationProjector,
} = require("../../src/modules/domainEvents/services/notificationProjector");
const { notificationIntentService } = require("../../src/modules/notifications/services/notificationDelivery");
const {
  GENERATION_CAPABILITIES,
  EXPECTED_LOGICAL_OWNERS,
  heartbeatGeneration,
} = require("../../src/modules/steps/models/globalStepEventGeneration");
const {
  materializeEntitlementsForActiveRacers,
} = require("../../src/modules/steps/services/globalStepEventEntitlement");
const { enrollIfGlobalEventActive } = require("../../src/modules/steps/services/globalEventEnrollment");
const {
  buildGlobalEventBoundaryDrain,
} = require("../../src/modules/steps/jobs/globalEventBoundaryDrain");
const {
  buildGlobalEventEntitlementEventReconciler,
} = require("../../src/modules/steps/jobs/globalEventEntitlementEventReconciler");
const {
  buildNotificationCompletenessReconciler,
} = require("../../src/modules/notifications/jobs/notificationCompletenessReconciler");
const {
  buildNotificationScheduleRelease,
} = require("../../src/modules/notifications/jobs/notificationScheduleRelease");
const { buildInboxDelivery } = require("../../src/modules/inbox/jobs/inboxDelivery");
const { createInboxAlert } = require("../../src/modules/inbox/services/inbox");
const { buildDeviceTokenCleanup } = require("../../src/modules/notifications/jobs/deviceTokenCleanup");
const { RaceResolutionJobV2 } = require("../../src/modules/races/models/raceResolutionJobV2");

let server;

async function makeGenerationReady(current = new Date(), prefix = "ready") {
  const censusStart = new Date(current.getTime() - 90_000);
  for (const offset of [0, 30_000, 60_000, 90_000]) {
    for (const logicalOwnerId of EXPECTED_LOGICAL_OWNERS) {
      await heartbeatGeneration({
        client: prisma,
        now: new Date(censusStart.getTime() + offset),
        logicalOwnerId,
        bootId: `${prefix}-${logicalOwnerId}`,
        capabilities: GENERATION_CAPABILITIES,
      });
    }
  }
}

describe("global-event reliability v2 contract", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); });

  it("keeps legacy registration valid and advertises additive v2 capabilities", async () => {
    const { token, user } = await createTestUser();
    const response = await request(server.baseUrl, "POST", "/notifications/device-token", {
      token,
      body: { deviceToken: "legacy-ios-token", platform: "ios" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      registrationVersion: 2,
      installationAccepted: false,
    });
    const registration = await prisma.deviceToken.findFirstOrThrow({
      where: { userId: user.id, token: "legacy-ios-token" },
    });
    assert.equal(registration.installationId, null);
    assert.equal(registration.status, null, "phase one null status remains legacy-active");
    assert.ok(registration.lastRegisteredAt instanceof Date);
  });

  it("binds one installation, rotates its token, and refreshes registration time", async () => {
    await makeGenerationReady(undefined, "rotation");
    const { token, user } = await createTestUser();
    const first = await request(server.baseUrl, "POST", "/notifications/device-token", {
      token,
      body: {
        deviceToken: "ios-token-one",
        platform: "ios",
        installationId: "ios.installation:one",
        providerEnvironment: "sandbox",
      },
    });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      success: true,
      registrationVersion: 2,
      installationAccepted: true,
    });
    const before = await prisma.deviceToken.findFirstOrThrow({
      where: { userId: user.id, installationId: "ios.installation:one" },
    });

    const second = await request(server.baseUrl, "POST", "/notifications/device-token", {
      token,
      body: {
        deviceToken: "ios-token-two",
        platform: "ios",
        installationId: "ios.installation:one",
        providerEnvironment: "sandbox",
      },
    });
    assert.equal(second.status, 200);
    const rows = await prisma.deviceToken.findMany({ where: { userId: user.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, before.id);
    assert.equal(rows[0].token, "ios-token-two");
    assert.equal(rows[0].ownershipGeneration, before.ownershipGeneration + 1);
    assert.ok(rows[0].lastRegisteredAt >= before.lastRegisteredAt);
  });

  it("converges cross-account legacy raw-token collisions through the retained user-token key", async () => {
    await makeGenerationReady(undefined, "compat-collision");
    const destination = await createTestUser();
    const firstLegacyOwner = await createTestUser();
    const secondLegacyOwner = await createTestUser();
    const token = "legacy-shared-provider-token";
    const destinationRow = await prisma.deviceToken.create({
      data: {
        userId: destination.user.id,
        token,
        platform: "ios",
        status: null,
        lastRegisteredAt: new Date("2098-08-26T09:00:00.000Z"),
      },
    });
    await prisma.deviceToken.createMany({
      data: [
        {
          userId: firstLegacyOwner.user.id,
          token,
          platform: "ios",
          status: null,
          lastRegisteredAt: new Date("2098-08-26T09:30:00.000Z"),
        },
        {
          userId: secondLegacyOwner.user.id,
          token,
          platform: "ios",
          status: null,
          lastRegisteredAt: new Date("2098-08-26T09:45:00.000Z"),
        },
      ],
    });

    const response = await request(server.baseUrl, "POST", "/notifications/device-token", {
      token: destination.token,
      body: {
        deviceToken: token,
        platform: "ios",
        installationId: "canonical-destination-installation",
        providerEnvironment: "sandbox",
      },
    });
    assert.equal(response.status, 200);
    const rows = await prisma.deviceToken.findMany({
      where: { token, platform: "ios" }, orderBy: { id: "asc" },
    });
    const active = rows.filter((row) => row.status === "ACTIVE");
    assert.equal(active.length, 1);
    assert.equal(active[0].id, destinationRow.id, "destination's retained-key row remains canonical");
    assert.equal(active[0].userId, destination.user.id);
    assert.equal(active[0].installationId, "canonical-destination-installation");
    assert.ok(rows.filter((row) => row.id !== destinationRow.id).every((row) =>
      row.status === "SUPERSEDED" && row.statusReason === "OWNERSHIP_CHANGED"));
  });

  it("enforces the exact additive POST validation matrix", async () => {
    const { token } = await createTestUser();
    const cases = [
      [{ platform: "ios" }, 400, "DEVICE_TOKEN_REQUIRED"],
      [{ deviceToken: "x".repeat(4097), platform: "ios" }, 400, "DEVICE_TOKEN_TOO_LONG"],
      [{ deviceToken: "x", platform: "web" }, 400, "DEVICE_PLATFORM_INVALID"],
      [{ deviceToken: "x", platform: "ios", installationId: "bad id" }, 400, "INSTALLATION_ID_INVALID"],
      [{ deviceToken: "x", platform: "ios", providerEnvironment: "invalid" }, 400, "PROVIDER_ENVIRONMENT_INVALID"],
      [{ deviceToken: "x", platform: "ios", providerEnvironment: "production" }, 400, "PROVIDER_ENVIRONMENT_MISMATCH"],
    ];
    for (const [body, status, code] of cases) {
      const response = await request(server.baseUrl, "POST", "/notifications/device-token", { token, body });
      assert.equal(response.status, status, code);
      assert.equal((await response.json()).code, code);
    }
  });

  it("supports installation-only logout and rejects token/installation mismatch", async () => {
    const { token } = await createTestUser();
    for (const [deviceToken, installationId] of [["token-a", "install-a"], ["token-b", "install-b"]]) {
      const response = await request(server.baseUrl, "POST", "/notifications/device-token", {
        token,
        body: { deviceToken, platform: "android", installationId },
      });
      assert.equal(response.status, 200);
    }

    const mismatch = await request(server.baseUrl, "DELETE", "/notifications/device-token", {
      token,
      body: { deviceToken: "token-a", installationId: "install-b" },
    });
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json()).code, "REGISTRATION_MISMATCH");

    const removed = await request(server.baseUrl, "DELETE", "/notifications/device-token", {
      token,
      body: { installationId: "install-a" },
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { success: true, removed: 1 });
  });

  it("caps active registrations at ten and reversibly quarantines the LRU row", async () => {
    await makeGenerationReady(undefined, "cap");
    const { token, user } = await createTestUser();
    for (let index = 0; index < 11; index += 1) {
      const response = await request(server.baseUrl, "POST", "/notifications/device-token", {
        token,
        body: {
          deviceToken: `token-${index}`,
          platform: "android",
          installationId: `installation-${index}`,
        },
      });
      assert.equal(response.status, 200);
    }
    assert.equal(await prisma.deviceToken.count({ where: { userId: user.id, status: "ACTIVE" } }), 10);
    assert.equal(await prisma.deviceToken.count({ where: { userId: user.id, status: "QUARANTINED" } }), 1);

    const reactivated = await request(server.baseUrl, "POST", "/notifications/device-token", {
      token,
      body: {
        deviceToken: "token-0",
        platform: "android",
        installationId: "installation-0",
      },
    });
    assert.equal(reactivated.status, 200);
    assert.equal(await prisma.deviceToken.count({ where: { userId: user.id, status: "ACTIVE" } }), 10);
    assert.equal((await prisma.deviceToken.findFirstOrThrow({ where: { token: "token-0" } })).status, "ACTIVE");
  });

  it("keeps token lifecycle roll-forward-only after quarantine starts even if census readiness later clears", async () => {
    const current = new Date();
    await makeGenerationReady(current, "roll-forward");
    const account = await createTestUser();
    await buildDeviceTokenCleanup({ prisma, now: () => current })();
    await prisma.globalStepEventCronOwner.deleteMany();

    const response = await request(server.baseUrl, "POST", "/notifications/device-token", {
      token: account.token,
      body: {
        deviceToken: "roll-forward-token",
        platform: "android",
        installationId: "roll-forward-installation",
      },
    });
    assert.equal(response.status, 200);
    const row = await prisma.deviceToken.findFirstOrThrow({
      where: { userId: account.user.id, token: "roll-forward-token" },
    });
    assert.equal(row.status, "ACTIVE");
  });

  it("projects a scheduled-entitlement event early but releases at payload startsAt", async () => {
    const { user } = await createTestUser();
    const now = new Date("2098-08-26T10:00:00.000Z");
    const startsAt = new Date(now.getTime() + 60 * 60_000);
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const event = await prisma.globalStepEvent.create({
      data: {
        startsAt: new Date("2098-08-25T10:00:00.000Z"),
        endsAt: new Date("2098-08-28T10:00:00.000Z"),
        multiplier: 2,
        scheduleMode: "LOCAL_ENTITLEMENTS",
        eventDay: "2098-08-26",
        localStartMinute: 600,
        durationMinutes: 30,
      },
    });
    const entitlement = await prisma.globalStepEventEntitlement.create({
      data: {
        eventId: event.id,
        userId: user.id,
        timezone: "UTC",
        localDate: "2098-08-26",
        startsAt,
        endsAt,
        scheduleRevision: 0,
      },
    });
    await prisma.$transaction((tx) => appendDomainEvent(tx, {
      eventKey: `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${entitlement.id}:0`,
      eventType: "GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1",
      schemaVersion: 1,
      aggregateType: "GLOBAL_STEP_EVENT_ENTITLEMENT",
      aggregateId: entitlement.id,
      occurredAt: now,
      availableAt: now,
      payload: {
        eventId: event.id,
        entitlementId: entitlement.id,
        userId: user.id,
        multiplier: 2,
        startsAt,
        endsAt,
        scheduleRevision: 0,
        timezone: "UTC",
      },
      audience: [{ recipientId: user.id, facts: {} }],
    }));

    const project = buildDomainEventProjectionJob({ now: () => now, logger: { log() {}, error() {} } });
    await project();
    await project();
    const schedule = await prisma.notificationSchedule.findFirstOrThrow({ where: { sourceRef: entitlement.id } });
    assert.equal(schedule.availableAt.toISOString(), startsAt.toISOString());
    assert.equal(schedule.expiresAt.toISOString(), endsAt.toISOString());
    assert.equal(schedule.sourceRevision, 0);
    assert.equal(schedule.deliveryKey, `visible:GLOBAL_EVENT_STARTED:${user.id}:${event.id}`);
    assert.equal(await prisma.inboxAlert.count({ where: { userId: user.id } }), 0);
  });

  it("projects a scheduled-entitlement cohort in bounded set-based pages", async () => {
    const current = new Date("2098-08-26T10:00:00.000Z");
    const startsAt = new Date("2098-08-27T10:00:00.000Z");
    const endsAt = new Date("2098-08-27T10:30:00.000Z");
    const event = await prisma.globalStepEvent.create({ data: {
      startsAt: new Date("2098-08-26T00:00:00.000Z"),
      endsAt: new Date("2098-08-28T23:59:59.000Z"),
      multiplier: 2,
      scheduleMode: "LOCAL_ENTITLEMENTS",
      eventDay: "2098-08-27",
      localStartMinute: 600,
      durationMinutes: 30,
    } });
    const cohort = Array.from({ length: 120 }, (_, index) => ({
      userId: crypto.randomUUID(),
      entitlementId: crypto.randomUUID(),
      domainEventId: crypto.randomUUID(),
      index,
    }));
    await prisma.user.createMany({ data: cohort.map((row) => ({
      id: row.userId,
      appleId: `batch-projector-${row.index}`,
      email: `batch-projector-${row.index}@example.com`,
    })) });
    await prisma.globalStepEventEntitlement.createMany({ data: cohort.map((row) => ({
      id: row.entitlementId,
      eventId: event.id,
      userId: row.userId,
      timezone: "UTC",
      localDate: "2098-08-27",
      startsAt,
      endsAt,
      scheduleRevision: 0,
    })) });
    await prisma.domainEventOutbox.createMany({ data: cohort.map((row) => ({
      id: row.domainEventId,
      eventKey: `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${row.entitlementId}:0`,
      eventType: "GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1",
      schemaVersion: 1,
      aggregateType: "GLOBAL_STEP_EVENT_ENTITLEMENT",
      aggregateId: row.entitlementId,
      occurredAt: current,
      availableAt: current,
      payload: {
        eventId: event.id,
        entitlementId: row.entitlementId,
        userId: row.userId,
        multiplier: 2,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        scheduleRevision: 0,
        timezone: "UTC",
      },
    })) });
    await prisma.domainEventAudience.createMany({ data: cohort.map((row) => ({
      domainEventId: row.domainEventId,
      recipientId: row.userId,
      ordinal: 0,
      facts: {},
    })) });

    const result = await buildNotificationProjector({
      now: () => current,
      monotonicNow: () => 0,
      logger: { log() {}, error() {} },
    }).run({ budgetMs: 1 });

    assert.equal(result.scheduledEventBatches, 2);
    assert.equal(result.scheduledEventsProjected, 120);
    assert.equal(await prisma.notificationSchedule.count(), 120);
    assert.equal(await prisma.domainEventNotificationProjection.count({
      where: { status: "COMPLETED" },
    }), 120);
    assert.equal(await prisma.domainEventOutbox.count({ where: { status: "COMPLETED" } }), 120);
  });

  it("routes late scheduled-event projection through eligible, pending, and no-race boundary states", async () => {
    const current = new Date("2098-08-26T10:00:01.000Z");
    const startsAt = new Date("2098-08-26T10:00:00.000Z");
    const endsAt = new Date("2098-08-26T10:30:00.000Z");
    const accounts = await Promise.all([createTestUser(), createTestUser(), createTestUser()]);
    const [eligible, pending, dormant] = accounts;
    const event = await prisma.globalStepEvent.create({ data: {
      startsAt, endsAt, multiplier: 2, scheduleMode: "LOCAL_ENTITLEMENTS",
      eventDay: "2098-08-26", localStartMinute: 600, durationMinutes: 30,
    } });
    const race = await prisma.race.create({ data: {
      creatorId: eligible.user.id, name: "Late projection race", targetSteps: 10_000,
      status: "ACTIVE", startedAt: new Date(startsAt.getTime() - 60_000),
      endsAt: new Date(endsAt.getTime() + 60_000),
    } });
    const entitlements = await Promise.all([
      prisma.globalStepEventEntitlement.create({ data: {
        eventId: event.id, userId: eligible.user.id, timezone: "UTC", localDate: "2098-08-26",
        startsAt, endsAt, startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: current,
      } }),
      prisma.globalStepEventEntitlement.create({ data: {
        eventId: event.id, userId: pending.user.id, timezone: "UTC", localDate: "2098-08-26",
        startsAt, endsAt,
      } }),
      prisma.globalStepEventEntitlement.create({ data: {
        eventId: event.id, userId: dormant.user.id, timezone: "UTC", localDate: "2098-08-26",
        startsAt, endsAt, startOutcome: "NO_ACTIVE_RACES", startProcessedAt: current,
      } }),
    ]);
    await prisma.globalEventRaceImpact.create({
      data: { eventId: event.id, raceId: race.id, userId: eligible.user.id },
    });
    for (let index = 0; index < accounts.length; index += 1) {
      const userId = accounts[index].user.id;
      const entitlement = entitlements[index];
      await prisma.$transaction((tx) => appendDomainEvent(tx, {
        eventKey: `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${entitlement.id}:0`,
        eventType: "GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1",
        schemaVersion: 1,
        aggregateType: "GLOBAL_STEP_EVENT_ENTITLEMENT",
        aggregateId: entitlement.id,
        occurredAt: startsAt,
        availableAt: startsAt,
        payload: {
          eventId: event.id, entitlementId: entitlement.id, userId,
          multiplier: 2, startsAt, endsAt, scheduleRevision: 0, timezone: "UTC",
        },
        audience: [{ recipientId: userId, facts: {} }],
      }));
    }
    const project = buildDomainEventProjectionJob({ now: () => current, logger: { log() {}, error() {} } });
    for (let index = 0; index < 4; index += 1) await project();
    assert.equal(await prisma.notificationSchedule.count({}), 3);
    assert.equal(await prisma.inboxAlert.count({}), 0, "late projection cannot bypass eligibility");

    const released = await notificationIntentService.releaseDue({ now: current, batchSize: 500 });
    assert.equal(released.released, 1);
    assert.equal(await prisma.inboxAlert.count({ where: { userId: eligible.user.id } }), 1);
    assert.equal((await prisma.notificationSchedule.findFirstOrThrow({
      where: { recipientUserId: pending.user.id },
    })).status, "PENDING");
    assert.equal((await prisma.notificationSchedule.findFirstOrThrow({
      where: { recipientUserId: dormant.user.id },
    })).status, "CANCELLED_NO_ACTIVE_RACE");
  });

  it("keeps the newest pending schedule revision when events replay out of order", async () => {
    const { user } = await createTestUser();
    const eventId = crypto.randomUUID();
    const entitlementId = crypto.randomUUID();
    const oldStart = new Date("2098-08-26T10:00:00.000Z");
    const newStart = new Date("2098-08-26T13:00:00.000Z");
    const base = {
      eventId, entitlementId, userId: user.id, multiplier: 2,
      endsAt: new Date("2098-08-26T13:30:00.000Z"), timezone: "UTC",
    };
    for (const [revision, startsAt] of [[1, newStart], [0, oldStart]]) {
      await prisma.$transaction((tx) => appendDomainEvent(tx, {
        eventKey: `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${entitlementId}:${revision}`,
        eventType: "GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1",
        schemaVersion: 1,
        aggregateType: "GLOBAL_STEP_EVENT_ENTITLEMENT",
        aggregateId: entitlementId,
        occurredAt: new Date(`2098-08-26T0${revision}:00:00.000Z`),
        availableAt: new Date(`2098-08-26T0${revision}:00:00.000Z`),
        payload: { ...base, startsAt, scheduleRevision: revision },
        audience: [{ recipientId: user.id, facts: {} }],
      }));
    }
    const project = buildDomainEventProjectionJob({
      now: () => new Date("2098-08-26T02:00:00.000Z"),
      logger: { log() {}, error() {} },
    });
    await project();
    await project();
    const schedule = await prisma.notificationSchedule.findUniqueOrThrow({
      where: { recipientUserId_deliveryKey: {
        recipientUserId: user.id,
        deliveryKey: `visible:GLOBAL_EVENT_STARTED:${user.id}:${eventId}`,
      } },
    });
    assert.equal(schedule.sourceRevision, 1);
    assert.equal(schedule.availableAt.toISOString(), newStart.toISOString());
  });

  it("materializes eligible schedules with outbox expiry and keeps no-race schedules dormant", async () => {
    const eligible = await createTestUser();
    const dormant = await createTestUser();
    const startsAt = new Date("2098-08-26T10:00:00.000Z");
    const current = new Date(startsAt.getTime() + 1_000);
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const event = await prisma.globalStepEvent.create({
      data: {
        startsAt, endsAt, multiplier: 2, scheduleMode: "LOCAL_ENTITLEMENTS",
        eventDay: "2098-08-26", localStartMinute: 600, durationMinutes: 30,
      },
    });
    const race = await prisma.race.create({
      data: {
        creatorId: eligible.user.id,
        name: "Reliability race",
        targetSteps: 10_000,
        status: "ACTIVE",
        startedAt: new Date(startsAt.getTime() - 60_000),
        endsAt: new Date(endsAt.getTime() + 60_000),
      },
    });
    const [eligibleEntitlement, dormantEntitlement] = await Promise.all([
      prisma.globalStepEventEntitlement.create({ data: {
        eventId: event.id, userId: eligible.user.id, timezone: "UTC", localDate: "2098-08-26",
        startsAt, endsAt, startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: current,
      } }),
      prisma.globalStepEventEntitlement.create({ data: {
        eventId: event.id, userId: dormant.user.id, timezone: "UTC", localDate: "2098-08-26",
        startsAt, endsAt, startOutcome: "NO_ACTIVE_RACES", startProcessedAt: current,
      } }),
    ]);
    await prisma.globalEventRaceImpact.create({
      data: { eventId: event.id, raceId: race.id, userId: eligible.user.id },
    });
    for (const [userId, sourceRef] of [
      [eligible.user.id, eligibleEntitlement.id],
      [dormant.user.id, dormantEntitlement.id],
    ]) {
      await prisma.notificationSchedule.create({ data: {
        recipientUserId: userId,
        type: "GLOBAL_EVENT_STARTED",
        title: "2x STEPS EVENT",
        body: "Double steps are LIVE for 30 minutes. Every step counts 2x in your races! Go!",
        payload: { type: "GLOBAL_EVENT_STARTED", route: "home", eventId: event.id, multiplier: 2 },
        deliveryKey: `visible:GLOBAL_EVENT_STARTED:${userId}:${event.id}`,
        availableAt: startsAt,
        expiresAt: endsAt,
        sourceRef,
      } });
    }

    const result = await notificationIntentService.releaseDue({ now: current, batchSize: 500 });
    assert.equal(result.released, 1);
    const alert = await prisma.inboxAlert.findFirstOrThrow({
      where: { userId: eligible.user.id }, include: { outbox: true },
    });
    assert.equal(alert.outbox[0].expiresAt.toISOString(), endsAt.toISOString());
    const dormantSchedule = await prisma.notificationSchedule.findFirstOrThrow({
      where: { recipientUserId: dormant.user.id },
    });
    assert.equal(dormantSchedule.status, "CANCELLED_NO_ACTIVE_RACE");
  });

  it("rearms a dormant schedule through the deployed late-activation event before expiry", async () => {
    const account = await createTestUser();
    const current = new Date();
    const startsAt = new Date(current.getTime() - 60_000);
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const event = await prisma.globalStepEvent.create({ data: {
      startsAt, endsAt, multiplier: 2, scheduleMode: "LOCAL_ENTITLEMENTS",
      eventDay: current.toISOString().slice(0, 10), localStartMinute: 600, durationMinutes: 30,
    } });
    const entitlement = await prisma.globalStepEventEntitlement.create({ data: {
      eventId: event.id,
      userId: account.user.id,
      timezone: "UTC",
      localDate: current.toISOString().slice(0, 10),
      startsAt,
      endsAt,
      startOutcome: "NO_ACTIVE_RACES",
      startProcessedAt: startsAt,
    } });
    await prisma.notificationSchedule.create({ data: {
      recipientUserId: account.user.id,
      type: "GLOBAL_EVENT_STARTED",
      title: "2x STEPS EVENT",
      body: "Double steps are LIVE for 30 minutes. Every step counts 2x in your races! Go!",
      payload: { type: "GLOBAL_EVENT_STARTED", route: "home", eventId: event.id, multiplier: 2 },
      deliveryKey: `visible:GLOBAL_EVENT_STARTED:${account.user.id}:${event.id}`,
      availableAt: startsAt,
      expiresAt: endsAt,
      sourceRef: entitlement.id,
      status: "CANCELLED_NO_ACTIVE_RACE",
    } });
    const race = await prisma.race.create({ data: {
      creatorId: account.user.id,
      name: "Late join race",
      targetSteps: 10_000,
      status: "ACTIVE",
      startedAt: current,
      endsAt: new Date(endsAt.getTime() + 60_000),
    } });
    await prisma.raceParticipant.create({ data: {
      raceId: race.id,
      userId: account.user.id,
      status: "ACCEPTED",
      joinedAt: current,
    } });

    await prisma.$transaction((tx) => enrollIfGlobalEventActive(tx, {
      raceId: race.id,
      userIds: [account.user.id],
      at: current,
    }));
    assert.equal(await prisma.domainEventOutbox.count({
      where: { eventKey: `GLOBAL_STEP_EVENT_ACTIVATED_V1:${entitlement.id}` },
    }), 1);
    const project = buildDomainEventProjectionJob({ now: () => current, logger: { log() {}, error() {} } });
    await project();
    await project();
    const alert = await prisma.inboxAlert.findFirstOrThrow({
      where: { userId: account.user.id },
      include: { outbox: true },
    });
    assert.equal(alert.sourceKey, `visible:GLOBAL_EVENT_STARTED:${account.user.id}:${event.id}`);
    assert.equal(alert.outbox[0].expiresAt.toISOString(), endsAt.toISOString());
  });

  it("requires every exact per-boot owner for 90 continuous seconds", async () => {
    const startedAt = new Date("2098-08-26T10:00:00.000Z");
    for (const logicalOwnerId of EXPECTED_LOGICAL_OWNERS) {
      const ready = await heartbeatGeneration({
        client: prisma,
        now: startedAt,
        logicalOwnerId,
        bootId: `boot-${logicalOwnerId}`,
        capabilities: GENERATION_CAPABILITIES,
      });
      assert.equal(ready, false);
    }
    for (const offset of [30_000, 60_000]) {
      for (const logicalOwnerId of EXPECTED_LOGICAL_OWNERS) {
        await heartbeatGeneration({
          client: prisma,
          now: new Date(startedAt.getTime() + offset),
          logicalOwnerId,
          bootId: `boot-${logicalOwnerId}`,
          capabilities: GENERATION_CAPABILITIES,
        });
      }
    }
    const beforeWindow = await heartbeatGeneration({
      client: prisma,
      now: new Date(startedAt.getTime() + 89_999),
      logicalOwnerId: "cron:0",
      bootId: "boot-cron:0",
      capabilities: GENERATION_CAPABILITIES,
    });
    assert.equal(beforeWindow, false);
    const afterWindow = await heartbeatGeneration({
      client: prisma,
      now: new Date(startedAt.getTime() + 90_000),
      logicalOwnerId: "cron:0",
      bootId: "boot-cron:0",
      capabilities: GENERATION_CAPABILITIES,
    });
    assert.equal(afterWindow, true);

    const overlap = await heartbeatGeneration({
      client: prisma,
      now: new Date(startedAt.getTime() + 91_000),
      logicalOwnerId: "http:0",
      bootId: "overlapping-http-boot",
      capabilities: GENERATION_CAPABILITIES,
    });
    assert.equal(overlap, false);
    assert.equal((await prisma.globalStepEventGenerationState.findUniqueOrThrow({ where: { id: 1 } })).readySince, null);
  });

  it("keeps generation two fenced until a live legacy null-owner row expires", async () => {
    const startedAt = new Date("2098-08-26T10:00:00.000Z");
    await prisma.globalStepEventCronOwner.create({ data: {
      ownerId: "legacy-rolling-worker",
      generation: 1,
      localAware: false,
      heartbeatAt: startedAt,
      expiresAt: new Date(startedAt.getTime() + 100_000),
    } });

    for (const offset of [0, 30_000, 60_000, 90_000]) {
      for (const logicalOwnerId of EXPECTED_LOGICAL_OWNERS) {
        assert.equal(await heartbeatGeneration({
          client: prisma,
          now: new Date(startedAt.getTime() + offset),
          logicalOwnerId,
          bootId: `rolling-${logicalOwnerId}`,
          capabilities: GENERATION_CAPABILITIES,
        }), false);
      }
    }
    assert.equal((await prisma.globalStepEventGenerationState.findUniqueOrThrow({ where: { id: 1 } })).readySince, null);

    for (const offset of [100_000, 130_000, 160_000]) {
      for (const logicalOwnerId of EXPECTED_LOGICAL_OWNERS) {
        assert.equal(await heartbeatGeneration({
          client: prisma,
          now: new Date(startedAt.getTime() + offset),
          logicalOwnerId,
          bootId: `rolling-${logicalOwnerId}`,
          capabilities: GENERATION_CAPABILITIES,
        }), false);
      }
    }
    assert.equal(await heartbeatGeneration({
      client: prisma,
      now: new Date(startedAt.getTime() + 190_000),
      logicalOwnerId: "cron:0",
      bootId: "rolling-cron:0",
      capabilities: GENERATION_CAPABILITIES,
    }), true);
  });

  it("gates scheduled-entitlement production on the continuous generation census", async () => {
    const current = new Date("2098-08-26T10:00:00.000Z");
    const { user } = await createTestUser({ globalEventTimezone: "UTC" });
    const race = await prisma.race.create({ data: {
      creatorId: user.id, name: "Generation-gated race", targetSteps: 10_000,
      status: "ACTIVE", startedAt: new Date(current.getTime() - 60_000),
      endsAt: new Date(current.getTime() + 3 * 60 * 60_000),
    } });
    await prisma.raceParticipant.create({ data: {
      raceId: race.id, userId: user.id, status: "ACCEPTED", joinedAt: current,
    } });
    const parent = await prisma.globalStepEvent.create({ data: {
      startsAt: new Date(current.getTime() + 60 * 60_000),
      endsAt: new Date(current.getTime() + 36 * 60 * 60_000),
      multiplier: 2, scheduleMode: "LOCAL_ENTITLEMENTS", eventDay: "2098-08-26",
      localStartMinute: 660, durationMinutes: 30,
    } });

    await materializeEntitlementsForActiveRacers(parent, { prisma, now: current });
    const entitlement = await prisma.globalStepEventEntitlement.findFirstOrThrow({
      where: { eventId: parent.id, userId: user.id },
    });
    assert.equal(await prisma.domainEventOutbox.count({
      where: { eventKey: `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${entitlement.id}:0` },
    }), 0, "an old/missing owner keeps the new producer off");

    await prisma.globalStepEventEntitlement.delete({ where: { id: entitlement.id } });
    const censusStart = new Date(current.getTime() - 90_000);
    for (const offset of [0, 30_000, 60_000, 90_000]) {
      for (const logicalOwnerId of EXPECTED_LOGICAL_OWNERS) {
        await heartbeatGeneration({
          client: prisma,
          now: new Date(censusStart.getTime() + offset),
          logicalOwnerId,
          bootId: `producer-${logicalOwnerId}`,
          capabilities: GENERATION_CAPABILITIES,
        });
      }
    }
    await materializeEntitlementsForActiveRacers(parent, { prisma, now: current });
    const readyEntitlement = await prisma.globalStepEventEntitlement.findFirstOrThrow({
      where: { eventId: parent.id, userId: user.id },
    });
    const scheduled = await prisma.domainEventOutbox.findUniqueOrThrow({
      where: { eventKey: `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${readyEntitlement.id}:0` },
      include: { audience: true },
    });
    assert.equal(scheduled.availableAt.toISOString(), current.toISOString());
    assert.equal(new Date(scheduled.payload.startsAt).toISOString(), readyEntitlement.startsAt.toISOString());
    assert.deepEqual(scheduled.audience.map((row) => row.recipientId), [user.id]);
  });

  it("atomically relocates entitlement and pending schedule in at most eight application statements", async () => {
    const current = new Date();
    await makeGenerationReady(current, "timezone");
    const account = await createTestUser({
      timezone: "America/New_York",
      globalEventTimezone: "America/New_York",
    });
    const eventDay = new Date(current.getTime() + 3 * 24 * 60 * 60_000)
      .toISOString().slice(0, 10);
    const oldStart = new Date(`${eventDay}T14:00:00.000Z`);
    const event = await prisma.globalStepEvent.create({ data: {
      startsAt: new Date(current.getTime() + 60 * 60_000),
      endsAt: new Date(current.getTime() + 5 * 24 * 60 * 60_000),
      multiplier: 2,
      scheduleMode: "LOCAL_ENTITLEMENTS",
      eventDay,
      localStartMinute: 600,
      durationMinutes: 30,
    } });
    const entitlement = await prisma.globalStepEventEntitlement.create({ data: {
      eventId: event.id,
      userId: account.user.id,
      timezone: "America/New_York",
      localDate: eventDay,
      startsAt: oldStart,
      endsAt: new Date(oldStart.getTime() + 30 * 60_000),
    } });
    const deliveryKey = `visible:GLOBAL_EVENT_STARTED:${account.user.id}:${event.id}`;
    await prisma.notificationSchedule.create({ data: {
      recipientUserId: account.user.id,
      type: "GLOBAL_EVENT_STARTED",
      title: "2x STEPS EVENT",
      body: "Go!",
      payload: { type: "GLOBAL_EVENT_STARTED", route: "home", eventId: event.id, multiplier: 2 },
      deliveryKey,
      availableAt: oldStart,
      expiresAt: new Date(oldStart.getTime() + 30 * 60_000),
      sourceRef: entitlement.id,
      sourceRevision: 0,
    } });

    const statements = [];
    const measuredServer = await startServer({
      now: () => current,
      timezoneStatementObserver: (name) => statements.push(name),
    });
    let response;
    try {
      response = await request(measuredServer.baseUrl, "GET", "/auth/me", {
        token: account.token,
        headers: { "x-timezone": "America/Denver" },
      });
    } finally {
      await measuredServer.close();
    }
    assert.equal(response.status, 200);
    const [storedUser, relocated] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: account.user.id } }),
      prisma.globalStepEventEntitlement.findUniqueOrThrow({ where: { id: entitlement.id } }),
    ]);
    assert.equal(storedUser.timezone, "America/Denver");
    assert.equal(relocated.timezone, "America/Denver");
    assert.equal(relocated.timezoneRelocatedFrom, "America/New_York");
    assert.ok(relocated.timezoneRelocatedAt);
    assert.equal(relocated.scheduleRevision, 1);
    assert.notEqual(relocated.startsAt.toISOString(), oldStart.toISOString());
    assert.equal(await prisma.domainEventOutbox.count({
      where: { eventKey: `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${entitlement.id}:1` },
    }), 1);
    assert.ok(statements.length <= 8, `application SQL (${statements.length}): ${statements.join(",")}`);

    const project = buildDomainEventProjectionJob({ now: () => current, logger: { log() {}, error() {} } });
    await project();
    await project();
    const moved = await prisma.notificationSchedule.findUniqueOrThrow({
      where: { recipientUserId_deliveryKey: {
        recipientUserId: account.user.id, deliveryKey,
      } },
    });
    assert.equal(moved.sourceRevision, 1);
    assert.equal(moved.availableAt.toISOString(), relocated.startsAt.toISOString());
    assert.notEqual(moved.availableAt.toISOString(), oldStart.toISOString());
    const oldBoundary = new Date(oldStart.getTime() + 1_000);
    assert.ok(oldBoundary < moved.availableAt);
    assert.equal((await notificationIntentService.releaseDue({ now: oldBoundary, batchSize: 500 })).released, 0);
    assert.equal(await prisma.inboxAlert.count({ where: { userId: account.user.id } }), 0);
  });

  it("revision-relocates a pending entitlement across consecutive timezone changes", async () => {
    const current = new Date();
    await makeGenerationReady(current, "timezone-repeat");
    const account = await createTestUser({
      timezone: "America/New_York",
      globalEventTimezone: "America/New_York",
    });
    const eventDay = new Date(current.getTime() + 3 * 24 * 60 * 60_000)
      .toISOString().slice(0, 10);
    const event = await prisma.globalStepEvent.create({ data: {
      startsAt: new Date(current.getTime() + 60 * 60_000),
      endsAt: new Date(current.getTime() + 5 * 24 * 60 * 60_000),
      multiplier: 2,
      scheduleMode: "LOCAL_ENTITLEMENTS",
      eventDay,
      localStartMinute: 600,
      durationMinutes: 30,
    } });
    const initialStart = new Date(`${eventDay}T14:00:00.000Z`);
    const entitlement = await prisma.globalStepEventEntitlement.create({ data: {
      eventId: event.id,
      userId: account.user.id,
      timezone: "America/New_York",
      localDate: eventDay,
      startsAt: initialStart,
      endsAt: new Date(initialStart.getTime() + 30 * 60_000),
    } });
    const deliveryKey = `visible:GLOBAL_EVENT_STARTED:${account.user.id}:${event.id}`;
    await prisma.notificationSchedule.create({ data: {
      recipientUserId: account.user.id,
      type: "GLOBAL_EVENT_STARTED",
      title: "2x STEPS EVENT",
      body: "Go!",
      payload: { type: "GLOBAL_EVENT_STARTED", route: "home", eventId: event.id, multiplier: 2 },
      deliveryKey,
      availableAt: initialStart,
      expiresAt: new Date(initialStart.getTime() + 30 * 60_000),
      sourceRef: entitlement.id,
      sourceRevision: 0,
    } });

    for (const timeZone of ["America/Denver", "America/Los_Angeles"]) {
      const response = await request(server.baseUrl, "GET", "/auth/me", {
        token: account.token,
        headers: { "x-timezone": timeZone },
      });
      assert.equal(response.status, 200);
    }

    const relocated = await prisma.globalStepEventEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });
    assert.equal(relocated.timezone, "America/Los_Angeles");
    assert.equal(relocated.timezoneRelocatedFrom, "America/Denver");
    assert.equal(relocated.scheduleRevision, 2);
    assert.equal(await prisma.domainEventOutbox.count({
      where: { eventKey: `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${entitlement.id}:2` },
    }), 1);

    const project = buildDomainEventProjectionJob({
      now: () => new Date(current.getTime() + 60_000),
      logger: { log() {}, error() {} },
    });
    for (let pass = 0; pass < 4; pass += 1) await project();
    const schedule = await prisma.notificationSchedule.findUniqueOrThrow({
      where: { recipientUserId_deliveryKey: { recipientUserId: account.user.id, deliveryKey } },
    });
    assert.equal(schedule.sourceRevision, 2);
    assert.equal(schedule.availableAt.toISOString(), relocated.startsAt.toISOString());
  });

  it("defers request-time timezone relocation while a legacy null-owner lease is live", async () => {
    const current = new Date();
    await makeGenerationReady(current, "timezone-legacy-lease");
    await prisma.globalStepEventCronOwner.create({ data: {
      ownerId: "timezone-live-legacy-worker",
      generation: 1,
      localAware: false,
      heartbeatAt: current,
      expiresAt: new Date(current.getTime() + 60_000),
    } });
    const account = await createTestUser({
      timezone: "America/New_York",
      globalEventTimezone: "America/New_York",
    });
    const eventDay = new Date(current.getTime() + 3 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const oldStart = new Date(`${eventDay}T14:00:00.000Z`);
    const event = await prisma.globalStepEvent.create({ data: {
      startsAt: new Date(current.getTime() + 60 * 60_000),
      endsAt: new Date(current.getTime() + 5 * 24 * 60 * 60_000),
      multiplier: 2, scheduleMode: "LOCAL_ENTITLEMENTS", eventDay,
      localStartMinute: 600, durationMinutes: 30,
    } });
    const entitlement = await prisma.globalStepEventEntitlement.create({ data: {
      eventId: event.id, userId: account.user.id, timezone: "America/New_York",
      localDate: eventDay, startsAt: oldStart,
      endsAt: new Date(oldStart.getTime() + 30 * 60_000),
    } });

    const response = await request(server.baseUrl, "GET", "/auth/me", {
      token: account.token,
      headers: { "x-timezone": "America/Denver" },
    });
    assert.equal(response.status, 200);
    const [storedUser, storedEntitlement] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: account.user.id } }),
      prisma.globalStepEventEntitlement.findUniqueOrThrow({ where: { id: entitlement.id } }),
    ]);
    assert.equal(storedUser.timezone, "America/New_York");
    assert.equal(storedEntitlement.timezone, "America/New_York");
    assert.equal(storedEntitlement.scheduleRevision, 0);
    assert.equal(await prisma.domainEventOutbox.count({
      where: { eventKey: `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${entitlement.id}:1` },
    }), 0);
  });

  it("rolls back timezone and entitlement after a post-user-write failure, then retries next request", async () => {
    const current = new Date();
    await makeGenerationReady(current, "timezone-rollback");
    const account = await createTestUser({
      timezone: "America/New_York",
      globalEventTimezone: "America/New_York",
    });
    const eventDay = new Date(current.getTime() + 3 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const oldStart = new Date(`${eventDay}T14:00:00.000Z`);
    const event = await prisma.globalStepEvent.create({ data: {
      startsAt: new Date(current.getTime() + 60 * 60_000),
      endsAt: new Date(current.getTime() + 5 * 24 * 60 * 60_000),
      multiplier: 2,
      scheduleMode: "LOCAL_ENTITLEMENTS",
      eventDay,
      localStartMinute: 600,
      durationMinutes: 30,
    } });
    const entitlement = await prisma.globalStepEventEntitlement.create({ data: {
      eventId: event.id,
      userId: account.user.id,
      timezone: "America/New_York",
      localDate: eventDay,
      startsAt: oldStart,
      endsAt: new Date(oldStart.getTime() + 30 * 60_000),
    } });
    const failingServer = await startServer({
      now: () => current,
      timezoneAfterUserUpdate: async () => {
        const error = new Error("forced post-user timezone failure");
        error.code = "FORCED_TIMEZONE_FAILURE";
        throw error;
      },
    });
    try {
      const failedOpen = await request(failingServer.baseUrl, "GET", "/auth/me", {
        token: account.token,
        headers: { "x-timezone": "America/Denver" },
      });
      assert.equal(failedOpen.status, 200);
    } finally {
      await failingServer.close();
    }
    const [rolledBackUser, rolledBackEntitlement] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: account.user.id } }),
      prisma.globalStepEventEntitlement.findUniqueOrThrow({ where: { id: entitlement.id } }),
    ]);
    assert.equal(rolledBackUser.timezone, "America/New_York");
    assert.equal(rolledBackEntitlement.timezone, "America/New_York");
    assert.equal(rolledBackEntitlement.scheduleRevision, 0);
    assert.equal(await prisma.domainEventOutbox.count({
      where: { eventKey: `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${entitlement.id}:1` },
    }), 0);

    const retried = await request(server.baseUrl, "GET", "/auth/me", {
      token: account.token,
      headers: { "x-timezone": "America/Denver" },
    });
    assert.equal(retried.status, 200);
    const relocated = await prisma.globalStepEventEntitlement.findUniqueOrThrow({ where: { id: entitlement.id } });
    assert.equal(relocated.timezone, "America/Denver");
    assert.equal(relocated.scheduleRevision, 1);
  });

  it("aborts timezone relocation when an active race expands after C0 fences are chosen", async () => {
    const current = new Date();
    await makeGenerationReady(current, "timezone-lock-expansion");
    const account = await createTestUser({
      timezone: "America/New_York",
      globalEventTimezone: "America/New_York",
    });
    const raceData = (name) => ({
      creatorId: account.user.id, name, targetSteps: 100_000, status: "ACTIVE",
      startedAt: new Date(current.getTime() - 60_000),
      endsAt: new Date(current.getTime() + 48 * 60 * 60_000),
    });
    const [fencedRace, expandingRace] = await Promise.all([
      prisma.race.create({ data: raceData("Timezone fenced race") }),
      prisma.race.create({ data: raceData("Timezone expanding race") }),
    ]);
    await prisma.raceParticipant.create({ data: {
      raceId: fencedRace.id, userId: account.user.id, status: "ACCEPTED", joinedAt: current,
    } });
    const eventDay = new Date(current.getTime() + 3 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const oldStart = new Date(`${eventDay}T14:00:00.000Z`);
    const event = await prisma.globalStepEvent.create({ data: {
      startsAt: new Date(current.getTime() + 60 * 60_000),
      endsAt: new Date(current.getTime() + 5 * 24 * 60 * 60_000),
      multiplier: 2, scheduleMode: "LOCAL_ENTITLEMENTS", eventDay,
      localStartMinute: 600, durationMinutes: 30,
    } });
    const entitlement = await prisma.globalStepEventEntitlement.create({ data: {
      eventId: event.id, userId: account.user.id, timezone: "America/New_York",
      localDate: eventDay, startsAt: oldStart,
      endsAt: new Date(oldStart.getTime() + 30 * 60_000),
    } });
    let expanded = false;
    const expandingServer = await startServer({
      now: () => current,
      timezoneAfterRaceFences: async () => {
        if (expanded) return;
        expanded = true;
        await prisma.raceParticipant.create({ data: {
          raceId: expandingRace.id, userId: account.user.id,
          status: "ACCEPTED", joinedAt: current,
        } });
      },
    });
    try {
      const response = await request(expandingServer.baseUrl, "GET", "/auth/me", {
        token: account.token, headers: { "x-timezone": "America/Denver" },
      });
      assert.equal(response.status, 200);
    } finally {
      await expandingServer.close();
    }
    const [storedUser, storedEntitlement] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: account.user.id } }),
      prisma.globalStepEventEntitlement.findUniqueOrThrow({ where: { id: entitlement.id } }),
    ]);
    assert.equal(storedUser.timezone, "America/New_York");
    assert.equal(storedEntitlement.timezone, "America/New_York");
    assert.equal(storedEntitlement.scheduleRevision, 0);
  });

  it("drains 561 same-time entitlements in set-based micro-batches without a minute sleep", async () => {
    const current = new Date("2098-08-26T10:32:00.000Z");
    await makeGenerationReady(current, "boundary");
    const userIds = Array.from({ length: 561 }, () => crypto.randomUUID());
    await prisma.user.createMany({ data: userIds.map((id, index) => ({
      id,
      appleId: `boundary-${index}`,
      email: `boundary-${index}@example.test`,
      globalEventTimezone: "UTC",
    })) });
    const race = await prisma.race.create({ data: {
      creatorId: userIds[0], name: "561-user boundary", targetSteps: 10_000,
      status: "ACTIVE", startedAt: new Date(current.getTime() - 60_000),
      endsAt: new Date(current.getTime() + 60 * 60_000),
    } });
    await prisma.raceParticipant.createMany({ data: userIds.map((userId) => ({
      raceId: race.id, userId, status: "ACCEPTED", joinedAt: new Date(current.getTime() - 60_000),
    })) });
    const event = await prisma.globalStepEvent.create({ data: {
      startsAt: current,
      endsAt: new Date(current.getTime() + 30 * 60_000),
      multiplier: 2, scheduleMode: "LOCAL_ENTITLEMENTS", eventDay: "2098-08-26",
      localStartMinute: 632, durationMinutes: 30,
    } });
    await prisma.globalStepEventEntitlement.createMany({ data: userIds.map((userId) => ({
      eventId: event.id, userId, timezone: "UTC", localDate: "2098-08-26",
      startsAt: current, endsAt: new Date(current.getTime() + 30 * 60_000),
    })) });

    const drain = buildGlobalEventBoundaryDrain({
      prisma,
      now: () => new Date(current.getTime() + 100),
      logger: { log() {}, error() {} },
    });
    const result = await drain.runUntilIdle();
    assert.equal(result.starts, 561);
    assert.ok(result.transactionAttempts <= 6, `used ${result.transactionAttempts} transactions`);
    assert.equal(await prisma.globalStepEventEntitlement.count({
      where: { startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: { not: null } },
    }), 561);
    assert.equal(await prisma.globalEventRaceImpact.count({ where: { eventId: event.id } }), 561);
    assert.equal(await prisma.raceResolutionJobV2.count({ where: { raceId: race.id } }), 1);
  });

  it("keeps domain activation live when an owner restarts at the exact boundary", async () => {
    const current = new Date("2098-08-26T10:32:00.000Z");
    const account = await createTestUser();
    const event = await prisma.globalStepEvent.create({ data: {
      startsAt: current,
      endsAt: new Date(current.getTime() + 30 * 60_000),
      multiplier: 2,
      scheduleMode: "LOCAL_ENTITLEMENTS",
      eventDay: "2098-08-26",
      localStartMinute: 632,
      durationMinutes: 30,
    } });
    const entitlement = await prisma.globalStepEventEntitlement.create({ data: {
      eventId: event.id,
      userId: account.user.id,
      timezone: "UTC",
      localDate: "2098-08-26",
      startsAt: current,
      endsAt: new Date(current.getTime() + 30 * 60_000),
    } });
    const race = await prisma.race.create({ data: {
      creatorId: account.user.id,
      name: "Owner restart boundary race",
      targetSteps: 10_000,
      status: "ACTIVE",
      startedAt: new Date(current.getTime() - 60_000),
      endsAt: new Date(current.getTime() + 60 * 60_000),
    } });
    await prisma.raceParticipant.create({ data: {
      raceId: race.id,
      userId: account.user.id,
      status: "ACCEPTED",
      joinedAt: new Date(current.getTime() - 60_000),
    } });
    await heartbeatGeneration({
      client: prisma,
      now: current,
      logicalOwnerId: "http:0",
      bootId: "just-restarted-http-owner",
      capabilities: GENERATION_CAPABILITIES,
    });

    const drain = buildGlobalEventBoundaryDrain({
      prisma,
      now: () => new Date(current.getTime() + 100),
      logger: { log() {}, error() {} },
    });
    assert.deepEqual(await drain.runUntilIdle(), {
      starts: 1,
      stale: 0,
      failures: 0,
      bisections: 0,
      transactionAttempts: 1,
    });
    const activated = await prisma.globalStepEventEntitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });
    assert.ok(activated.startProcessedAt);
    assert.equal(activated.startOutcome, "ACTIVATED_ON_TIME");
    assert.equal(await prisma.globalEventRaceImpact.count({
      where: { eventId: event.id, raceId: race.id, userId: account.user.id },
    }), 1);
  });

  it("merges a concurrent STEP_SYNC queue reason and scopes with global-event activation", async () => {
    const current = new Date("2098-08-26T10:32:00.000Z");
    const account = await createTestUser();
    const race = await prisma.race.create({ data: {
      creatorId: account.user.id,
      name: "Concurrent reason merge",
      targetSteps: 10_000,
      status: "ACTIVE",
      startedAt: new Date(current.getTime() - 60_000),
      endsAt: new Date(current.getTime() + 60 * 60_000),
    } });
    const participant = await prisma.raceParticipant.create({ data: {
      raceId: race.id,
      userId: account.user.id,
      status: "ACCEPTED",
      joinedAt: new Date(current.getTime() - 60_000),
    } });
    const event = await prisma.globalStepEvent.create({ data: {
      startsAt: current,
      endsAt: new Date(current.getTime() + 30 * 60_000),
      multiplier: 2,
      scheduleMode: "LOCAL_ENTITLEMENTS",
      eventDay: "2098-08-26",
      localStartMinute: 632,
      durationMinutes: 30,
    } });
    await prisma.globalStepEventEntitlement.create({ data: {
      eventId: event.id,
      userId: account.user.id,
      timezone: "UTC",
      localDate: "2098-08-26",
      startsAt: current,
      endsAt: new Date(current.getTime() + 30 * 60_000),
    } });
    const drain = buildGlobalEventBoundaryDrain({
      prisma,
      now: () => new Date(current.getTime() + 100),
      logger: { log() {}, error() {} },
    });
    await Promise.all([
      RaceResolutionJobV2.enqueueMany({
        raceIds: [race.id],
        userId: account.user.id,
        now: current,
        dirtyEnvelopeByRaceId: new Map([[race.id, {
          reason: "STEP_SYNC",
          dirtyUserIds: [account.user.id],
          dirtyParticipantIds: [participant.id],
          powerupTypes: [],
          priority: "COALESCE",
        }]]),
      }),
      drain.runUntilIdle(),
    ]);
    const job = await prisma.raceResolutionJobV2.findUniqueOrThrow({ where: { raceId: race.id } });
    assert.deepEqual(new Set(job.dirtyReasons), new Set(["STEP_SYNC", "GLOBAL_EVENT_BOUNDARY"]));
    assert.ok(job.triggeredByUserIds.includes(account.user.id));
    assert.ok(job.dirtyParticipantIds.includes(participant.id));
    assert.equal(job.dirtyPriority, "IMMEDIATE");
  });

  it("repairs each durable handoff from the owning side of the domain-event boundary", async () => {
    const current = new Date("2098-08-26T10:00:00.000Z");
    const censusStart = new Date(current.getTime() - 90_000);
    for (const offset of [0, 30_000, 60_000, 90_000]) {
      for (const logicalOwnerId of EXPECTED_LOGICAL_OWNERS) {
        await heartbeatGeneration({
          client: prisma, now: new Date(censusStart.getTime() + offset),
          logicalOwnerId, bootId: `repair-${logicalOwnerId}`,
          capabilities: GENERATION_CAPABILITIES,
        });
      }
    }
    const { user } = await createTestUser();
    const parent = await prisma.globalStepEvent.create({ data: {
      startsAt: new Date(current.getTime() + 60 * 60_000),
      endsAt: new Date(current.getTime() + 36 * 60 * 60_000), multiplier: 2,
      scheduleMode: "LOCAL_ENTITLEMENTS", eventDay: "2098-08-26",
      localStartMinute: 660, durationMinutes: 30,
    } });
    const entitlement = await prisma.globalStepEventEntitlement.create({ data: {
      eventId: parent.id, userId: user.id, timezone: "UTC", localDate: "2098-08-26",
      startsAt: new Date(current.getTime() + 60 * 60_000),
      endsAt: new Date(current.getTime() + 90 * 60_000),
    } });

    const stepsRepair = buildGlobalEventEntitlementEventReconciler({
      prisma, now: () => current, logger: { log() {}, error() {} },
    });
    assert.equal((await stepsRepair()).published, 1);
    const project = buildDomainEventProjectionJob({ now: () => current, logger: { log() {}, error() {} } });
    await project();
    await project();
    const schedule = await prisma.notificationSchedule.findFirstOrThrow({ where: { sourceRef: entitlement.id } });

    await prisma.notificationSchedule.delete({ where: { id: schedule.id } });
    const notificationRepair = buildNotificationCompletenessReconciler({
      prisma, now: () => current, logger: { log() {}, error() {} },
    });
    const repaired = await notificationRepair();
    assert.equal(repaired.projectionsRearmed, 1);
    await project();
    assert.equal(await prisma.notificationSchedule.count({ where: { sourceRef: entitlement.id } }), 1);
  });

  it("repairs missing materialization, overdue outbox, snapshot, and terminal-target gaps independently", async () => {
    const startsAt = new Date("2098-08-26T10:00:00.000Z");
    const current = new Date(startsAt.getTime() + 60_000);
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const accounts = await Promise.all(Array.from({ length: 4 }, () => createTestUser()));
    const event = await prisma.globalStepEvent.create({ data: {
      startsAt, endsAt, multiplier: 2, scheduleMode: "LOCAL_ENTITLEMENTS",
      eventDay: "2098-08-26", localStartMinute: 600, durationMinutes: 30,
    } });
    const race = await prisma.race.create({ data: {
      creatorId: accounts[0].user.id, name: "Completeness repair race", targetSteps: 10_000,
      status: "ACTIVE", startedAt: new Date(startsAt.getTime() - 60_000),
      endsAt: new Date(endsAt.getTime() + 60_000),
    } });
    const entitlements = [];
    for (const account of accounts) {
      const entitlement = await prisma.globalStepEventEntitlement.create({ data: {
        eventId: event.id, userId: account.user.id, timezone: "UTC", localDate: "2098-08-26",
        startsAt, endsAt, startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: current,
      } });
      entitlements.push(entitlement);
      await prisma.globalEventRaceImpact.create({
        data: { eventId: event.id, raceId: race.id, userId: account.user.id },
      });
      await prisma.notificationSchedule.create({ data: {
        recipientUserId: account.user.id, type: "GLOBAL_EVENT_STARTED",
        title: "2x STEPS EVENT", body: "Go!",
        payload: { type: "GLOBAL_EVENT_STARTED", route: "home", eventId: event.id, multiplier: 2 },
        deliveryKey: `visible:GLOBAL_EVENT_STARTED:${account.user.id}:${event.id}`,
        availableAt: startsAt, expiresAt: endsAt, sourceRef: entitlement.id,
        status: "MATERIALIZED", claimedAt: startsAt, releasedAt: startsAt,
      } });
    }
    const makeAlert = (index) => prisma.inboxAlert.create({ data: {
      userId: accounts[index].user.id, type: "GLOBAL_EVENT_STARTED",
      destination: { route: "home" }, title: "2x STEPS EVENT", body: "Go!",
      sourceKey: `visible:GLOBAL_EVENT_STARTED:${accounts[index].user.id}:${event.id}`,
      createdAt: startsAt, expiresAt: new Date(current.getTime() + 30 * 24 * 60 * 60_000),
    } });
    const missingOutboxAlert = await makeAlert(1);
    const overdueAlert = await makeAlert(2);
    const terminalAlert = await makeAlert(3);
    const overdueOutbox = await prisma.inboxDeliveryOutbox.create({ data: {
      alertId: overdueAlert.id, kind: "PUSH", payload: { title: "2x", body: "Go" },
      status: "LEASED", availableAt: startsAt,
      leaseUntil: new Date(current.getTime() - 1_000), leaseToken: "stale-lease", expiresAt: endsAt,
    } });
    const terminalOutbox = await prisma.inboxDeliveryOutbox.create({ data: {
      alertId: terminalAlert.id, kind: "PUSH", payload: { title: "2x", body: "Go" },
      status: "DELIVERED", availableAt: startsAt, deliveredAt: current, expiresAt: endsAt,
    } });
    await prisma.inboxDeliveryDeviceAttempt.create({ data: {
      outboxId: terminalOutbox.id, tokenHash: "repair-target", disposition: "RETRY",
      nextAttemptAt: current,
    } });

    const repaired = await buildNotificationCompletenessReconciler({
      prisma, now: () => current, logger: { log() {}, error() {} },
    })();
    assert.equal(repaired.materializationGapsRearmed, 2);
    assert.equal(repaired.overdueOutboxesRearmed, 1);
    assert.equal(repaired.missingSnapshotsRearmed, 1);
    assert.equal(repaired.terminalTargetsRepaired, 1);
    assert.equal(
      Object.hasOwn(repaired, "released"),
      false,
      "the cold completeness audit must not duplicate the hot schedule-release worker",
    );
    assert.equal(
      await prisma.inboxDeliveryOutbox.count({ where: { alertId: missingOutboxAlert.id } }),
      0,
      "repair only rearms durable schedules; the dedicated release worker owns materialization",
    );
    const release = buildNotificationScheduleRelease({
      notificationIntentService,
      now: () => current,
    });
    assert.equal((await release()).released, 2);
    assert.equal(await prisma.inboxDeliveryOutbox.count({ where: { alertId: missingOutboxAlert.id } }), 1);
    assert.equal((await prisma.inboxDeliveryOutbox.findUniqueOrThrow({
      where: { id: overdueOutbox.id },
    })).status, "RETRY");
    assert.equal((await prisma.inboxDeliveryDeviceAttempt.findFirstOrThrow({
      where: { outboxId: terminalOutbox.id },
    })).disposition, "EXHAUSTED");
  });

  it("snapshots installation targets once and never sends a rotated token on retry", async () => {
    await makeGenerationReady(undefined, "snapshot");
    const account = await createTestUser();
    for (const [deviceToken, installationId] of [["snapshot-a", "install-a"], ["snapshot-b", "install-b"]]) {
      const response = await request(server.baseUrl, "POST", "/notifications/device-token", {
        token: account.token,
        body: { deviceToken, platform: "android", installationId },
      });
      assert.equal(response.status, 200);
    }
    let current = new Date("2098-08-26T10:00:00.000Z");
    await createInboxAlert({
      userId: account.user.id,
      type: "GLOBAL_EVENT_STARTED",
      title: "2x STEPS EVENT",
      body: "Double steps are LIVE for 30 minutes. Every step counts 2x in your races! Go!",
      destination: { route: "home" },
      sourceKey: `visible:GLOBAL_EVENT_STARTED:${account.user.id}:snapshot-event`,
      payload: { type: "GLOBAL_EVENT_STARTED", route: "home", eventId: "snapshot-event", multiplier: 2 },
      now: current,
      expiresAt: new Date(current.getTime() + 30 * 60_000),
    });
    const sent = [];
    const fcm = {
      async sendNotification(input) {
        sent.push(input);
        return input.deviceToken === "snapshot-a"
          ? { success: true, statusCode: 200, providerMessageId: "fcm/message/a", environment: null }
          : { success: false, statusCode: 503, reason: "UNAVAILABLE", retryAfterMs: 250, permanent: false };
      },
    };
    const deliver = buildInboxDelivery({
      prisma,
      now: () => current,
      fcmService: fcm,
      apnsService: fcm,
      logger: { log() {}, error() {} },
      random: () => 0,
    });
    await deliver();
    const outbox = await prisma.inboxDeliveryOutbox.findFirstOrThrow({});
    let targets = await prisma.inboxDeliveryDeviceAttempt.findMany({
      where: { outboxId: outbox.id }, orderBy: { installationId: "asc" },
    });
    assert.equal(targets.length, 2);
    assert.equal(targets[0].disposition, "ACCEPTED");
    assert.equal(targets[0].firstAttemptedAt.toISOString(), current.toISOString());
    assert.equal(targets[0].providerMessageId, "fcm/message/a");
    assert.equal(targets[1].disposition, "TRANSIENT_FAIL");
    assert.equal(targets[1].firstAttemptedAt.toISOString(), current.toISOString());

    const rotated = await request(server.baseUrl, "POST", "/notifications/device-token", {
      token: account.token,
      body: { deviceToken: "snapshot-c", platform: "android", installationId: "install-b" },
    });
    assert.equal(rotated.status, 200);
    current = new Date(current.getTime() + 2_000);
    await deliver();
    targets = await prisma.inboxDeliveryDeviceAttempt.findMany({
      where: { outboxId: outbox.id }, orderBy: { installationId: "asc" },
    });
    assert.equal(targets[1].disposition, "SUPERSEDED");
    assert.deepEqual(sent.map((call) => call.deviceToken).sort(), ["snapshot-a", "snapshot-b"]);
    assert.equal((await prisma.inboxDeliveryOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).status, "DELIVERED");
  });

  it("upgrades and delivers a seeded pre-migration retry target", async () => {
    const account = await createTestUser();
    const current = new Date("2098-08-26T10:00:00.000Z");
    const registration = await prisma.deviceToken.create({ data: {
      userId: account.user.id,
      token: "legacy-retry-device",
      platform: "ios",
      status: null,
      lastRegisteredAt: current,
    } });
    await createInboxAlert({
      userId: account.user.id,
      type: "GLOBAL_EVENT_STARTED",
      title: "2x STEPS EVENT",
      body: "Go!",
      destination: { route: "home" },
      sourceKey: `visible:GLOBAL_EVENT_STARTED:${account.user.id}:legacy-retry`,
      payload: { type: "GLOBAL_EVENT_STARTED", route: "home" },
      now: current,
      expiresAt: new Date(current.getTime() + 30 * 60_000),
    });
    const outbox = await prisma.inboxDeliveryOutbox.findFirstOrThrow({});
    await prisma.inboxDeliveryOutbox.update({
      where: { id: outbox.id },
      data: { status: "RETRY", attemptCount: 1, retryAt: current },
    });
    await prisma.inboxDeliveryDeviceAttempt.create({ data: {
      outboxId: outbox.id,
      tokenHash: crypto.createHash("sha256").update("legacy-retry-device").digest("hex"),
      disposition: "RETRY",
      attemptCount: 1,
      nextAttemptAt: current,
    } });
    const calls = [];
    const provider = {
      async sendNotification(input) {
        calls.push(input.deviceToken);
        return { success: true, providerMessageId: "legacy-retry-accepted" };
      },
    };

    await buildInboxDelivery({
      prisma,
      now: () => current,
      apnsService: provider,
      fcmService: provider,
      logger: { log() {}, error() {} },
    })();

    const attempt = await prisma.inboxDeliveryDeviceAttempt.findFirstOrThrow({
      where: { outboxId: outbox.id },
    });
    assert.deepEqual(calls, ["legacy-retry-device"]);
    assert.equal(attempt.deviceTokenId, registration.id);
    assert.equal(attempt.recipientUserId, account.user.id);
    assert.equal(attempt.ownershipGeneration, registration.ownershipGeneration);
    assert.equal(attempt.disposition, "ACCEPTED");
    assert.equal((await prisma.inboxDeliveryOutbox.findUniqueOrThrow({
      where: { id: outbox.id },
    })).status, "DELIVERED");
  });

  it("defers the outbox to the earliest target Retry-After without burning empty-scan attempts", async () => {
    await makeGenerationReady(undefined, "retry-after");
    const account = await createTestUser();
    await request(server.baseUrl, "POST", "/notifications/device-token", {
      token: account.token,
      body: {
        deviceToken: "retry-after-device",
        platform: "android",
        installationId: "retry-after-installation",
      },
    });
    let current = new Date("2098-08-26T10:00:00.000Z");
    await createInboxAlert({
      userId: account.user.id,
      type: "GLOBAL_EVENT_STARTED",
      title: "2x STEPS EVENT",
      body: "Go!",
      destination: { route: "home" },
      sourceKey: `visible:GLOBAL_EVENT_STARTED:${account.user.id}:retry-after`,
      payload: { type: "GLOBAL_EVENT_STARTED", route: "home" },
      now: current,
      expiresAt: new Date(current.getTime() + 30 * 60_000),
    });
    let providerCalls = 0;
    const provider = {
      async sendNotification() {
        providerCalls += 1;
        return {
          success: false,
          statusCode: 429,
          reason: "THROTTLED",
          retryAfterMs: 60_000,
          permanent: false,
        };
      },
    };
    const deliver = buildInboxDelivery({
      prisma,
      now: () => current,
      fcmService: provider,
      apnsService: provider,
      logger: { log() {}, error() {} },
      random: () => 0,
    });
    await deliver();
    const first = await prisma.inboxDeliveryOutbox.findFirstOrThrow({});
    assert.equal(first.status, "RETRY");
    assert.equal(first.attemptCount, 1);
    assert.equal(first.availableAt.toISOString(), "2098-08-26T10:01:00.000Z");
    const target = await prisma.inboxDeliveryDeviceAttempt.findFirstOrThrow({});
    assert.equal(target.nextAttemptAt.toISOString(), first.availableAt.toISOString());

    current = new Date("2098-08-26T10:00:30.000Z");
    const emptyScan = await deliver();
    const unchanged = await prisma.inboxDeliveryOutbox.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(emptyScan.claimed, 0);
    assert.equal(unchanged.attemptCount, 1);
    assert.equal(providerCalls, 1);
  });

  it("preserves admin open attribution for an ownership-revalidated snapshotted target", async () => {
    await makeGenerationReady(undefined, "attribution");
    const account = await createTestUser();
    const epoch = await prisma.adminMetricsCollectionEpoch.create({
      data: { startedAt: new Date("2098-08-26T09:00:00.000Z") },
    });
    await prisma.deviceToken.create({
      data: {
        userId: account.user.id,
        token: "attribution-ios-device",
        platform: "ios",
        installationId: "attribution-installation",
        status: "ACTIVE",
        lastRegisteredAt: new Date("2098-08-26T09:30:00.000Z"),
        providerEnvironment: "sandbox",
        adminMetricsOpenCapable: true,
        adminMetricsOpenEpochId: epoch.id,
      },
    });
    const current = new Date("2098-08-26T10:00:00.000Z");
    await createInboxAlert({
      userId: account.user.id,
      type: "GLOBAL_EVENT_STARTED",
      title: "2x STEPS EVENT",
      body: "Go!",
      destination: { route: "home" },
      sourceKey: `visible:GLOBAL_EVENT_STARTED:${account.user.id}:attribution`,
      payload: { type: "GLOBAL_EVENT_STARTED", route: "home" },
      now: current,
      expiresAt: new Date(current.getTime() + 30 * 60_000),
    });
    const sent = [];
    const provider = {
      async sendNotification(input) {
        sent.push(input);
        return { success: true, providerMessageId: "provider-attribution-id", environment: "sandbox" };
      },
    };
    await buildInboxDelivery({
      prisma,
      now: () => current,
      fcmService: provider,
      apnsService: provider,
      appSettings: { async getFlag(name) { return name === "adminMetricsV2TelemetryEnabled"; } },
      logger: { log() {}, error() {} },
    })();
    const fact = await prisma.pushDelivery.findFirstOrThrow({});
    assert.equal(fact.openCapable, true);
    assert.equal(fact.providerAcceptedAt.toISOString(), current.toISOString());
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.notificationId, fact.publicId);
  });

  it("quarantines a 125-row legacy fixture to ten active rows without deleting it", async () => {
    const current = new Date();
    await makeGenerationReady(current, "cleanup");
    const { user } = await createTestUser();
    await prisma.deviceToken.createMany({ data: Array.from({ length: 125 }, (_, index) => ({
      userId: user.id,
      token: `legacy-accumulated-${index}`,
      platform: "ios",
      lastRegisteredAt: new Date(current.getTime() - index * 1_000),
      status: null,
    })) });
    const cleanup = buildDeviceTokenCleanup({ prisma, now: () => current });
    const result = await cleanup();
    assert.equal(result.activated, 125);
    assert.equal(await prisma.deviceToken.count({ where: { userId: user.id, status: "ACTIVE" } }), 10);
    assert.equal(await prisma.deviceToken.count({ where: { userId: user.id, status: "QUARANTINED" } }), 115);
    assert.equal(await prisma.deviceToken.count({ where: { userId: user.id } }), 125);
    assert.ok((await prisma.globalStepEventGenerationState.findUniqueOrThrow({ where: { id: 1 } })).quarantineStartedAt);
  });

  it("keeps null legacy registrations readable until the bounded backfill is complete", async () => {
    const current = new Date();
    await makeGenerationReady(current, "cleanup-multipage");
    const { user } = await createTestUser();
    await prisma.deviceToken.createMany({ data: Array.from({ length: 625 }, (_, index) => ({
      userId: user.id,
      token: `legacy-multipage-${index}`,
      platform: "ios",
      lastRegisteredAt: new Date(current.getTime() - index * 1_000),
      status: null,
    })) });
    const cleanup = buildDeviceTokenCleanup({ prisma, now: () => current, batchSize: 500 });
    const first = await cleanup();
    assert.equal(first.quarantineStarted, false);
    assert.equal(await prisma.deviceToken.count({ where: { userId: user.id, status: null } }), 125);
    assert.equal((await prisma.globalStepEventGenerationState.findUniqueOrThrow({ where: { id: 1 } })).quarantineStartedAt, null);

    const second = await cleanup();
    assert.equal(second.quarantineStarted, true);
    assert.equal(await prisma.deviceToken.count({ where: { userId: user.id, status: null } }), 0);
    assert.equal(await prisma.deviceToken.count({ where: { userId: user.id, status: "ACTIVE" } }), 10);
  });
});
