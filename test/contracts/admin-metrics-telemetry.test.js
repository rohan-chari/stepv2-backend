const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
  startServer,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const { signSessionToken } = require("../../src/modules/users/services/sessionToken");
const { registerNotificationHandlers } = require("../../src/modules/notifications/notificationHandlers");
const { buildInboxDelivery } = require("../../src/modules/inbox/jobs/inboxDelivery");
const { createInboxAlert } = require("../../src/modules/inbox/services/inbox");
const {
  buildRaceResolutionDeliveryIntents,
} = require("../../src/modules/races/services/raceResolutionDeliveryIntents");
const {
  evaluateHighMultiplierAlert,
} = require("../../src/modules/races/services/highMultiplierAlert");
const {
  buildNotificationProjector,
} = require("../../src/modules/domainEvents/services/notificationProjector");

function asyncEventBus() {
  const handlers = new Map();
  return {
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    async emit(name, data) {
      for (const handler of handlers.get(name) || []) await handler(data);
    },
  };
}

describe("admin metrics v2 telemetry ingestion", () => {
  let server;

  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.analyticsCleanupRun.deleteMany();
    await prisma.metricCoverageStart.deleteMany();
    await prisma.adminMetricsCollectionEpoch.deleteMany();
    await appSettings.setFlag("adminMetricsV2TelemetryEnabled", false);
  });

  async function enableTelemetry() {
    await appSettings.setFlag("adminMetricsV2TelemetryEnabled", true);
    const epoch = await prisma.adminMetricsCollectionEpoch.findFirst({
      where: { endedAt: null },
    });
    assert.ok(epoch, "enabling telemetry creates one open epoch");
    return epoch;
  }

  function deliverVisible({ settings, apns, logger = { log() {}, warn() {}, error() {} } }) {
    return buildInboxDelivery({
      prisma,
      appSettings: settings,
      apnsService: apns,
      fcmService: apns,
      logger,
    })();
  }

  it("foreground returns the exact disabled envelope without a write", async () => {
    const user = await createTestUser();
    const response = await request(server.baseUrl, "POST", "/analytics/foreground", {
      token: user.token,
      body: {
        sessionId: "01JTEST.DISABLED",
        occurredAt: new Date().toISOString(),
        appVersion: "2.4.0",
      },
      headers: { "X-Client-Features": "admin_metrics_v2" },
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { recorded: false, reason: "disabled" });
    assert.equal(await prisma.userActivityDay.count(), 0);
  });

  it("foreground validates bounded fields with the locked error", async () => {
    await enableTelemetry();
    const user = await createTestUser();
    const response = await request(server.baseUrl, "POST", "/analytics/foreground", {
      token: user.token,
      body: { sessionId: "bad id!", occurredAt: "never", appVersion: "x" },
      headers: { "X-Client-Features": "admin_metrics_v2" },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Invalid foreground analytics event",
      code: "INVALID_ANALYTICS_EVENT",
    });
  });

  it("foreground accepts capable Google Sign-In accounts from the iOS-only client", async () => {
    const epoch = await enableTelemetry();
    const google = await prisma.user.create({
      data: { googleSub: `google-${Date.now()}`, email: "google@test.com" },
    });
    const sessionToken = signSessionToken({ userId: google.id, googleSub: google.googleSub });
    const response = await request(server.baseUrl, "POST", "/analytics/foreground", {
      token: sessionToken,
      body: {
        sessionId: "01JGOOGLE.TEST",
        occurredAt: new Date().toISOString(),
        appVersion: "2.4.0",
      },
      headers: { "X-Client-Features": "admin_metrics_v2" },
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { recorded: true });
    const stored = await prisma.user.findUnique({ where: { id: google.id } });
    assert.equal(stored.metricsV2EligibleEpochId, epoch.id);
    assert.equal(await prisma.userActivityDay.count({ where: { userId: google.id } }), 1);
  });

  it("foreground requires the explicit admin_metrics_v2 capability", async () => {
    await enableTelemetry();
    const user = await createTestUser();
    const response = await request(server.baseUrl, "POST", "/analytics/foreground", {
      token: user.token,
      body: {
        sessionId: "01JNO.CAPABILITY",
        occurredAt: new Date().toISOString(),
        appVersion: "2.4.0",
      },
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      recorded: false,
      reason: "unsupported_platform",
    });
    assert.equal(await prisma.userActivityDay.count(), 0);
    const stored = await prisma.user.findUnique({ where: { id: user.user.id } });
    assert.equal(stored.metricsV2EligibleEpochId, null);
  });

  it("foreground soft-drops occurrences before the current epoch", async () => {
    const epoch = await enableTelemetry();
    const startedAt = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.adminMetricsCollectionEpoch.update({
      where: { id: epoch.id },
      data: { startedAt },
    });
    const user = await createTestUser();
    const response = await request(server.baseUrl, "POST", "/analytics/foreground", {
      token: user.token,
      headers: { "X-Client-Features": "admin_metrics_v2" },
      body: {
        sessionId: "01JPRE.EPOCH",
        occurredAt: new Date(startedAt.getTime() - 60 * 1000).toISOString(),
        appVersion: "2.4.0",
      },
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      recorded: false,
      reason: "disabled",
    });
    assert.equal(await prisma.userActivityDay.count(), 0);
  });

  it("does not backfill a collection gap into a newly enabled epoch", async () => {
    const firstEpoch = await enableTelemetry();
    const user = await createTestUser();
    await appSettings.setFlag("adminMetricsV2TelemetryEnabled", false);
    const gapOccurrence = new Date();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondEpoch = await enableTelemetry();
    assert.notEqual(secondEpoch.id, firstEpoch.id);
    assert.ok(secondEpoch.startedAt > gapOccurrence);

    const response = await request(server.baseUrl, "POST", "/analytics/foreground", {
      token: user.token,
      headers: { "X-Client-Features": "admin_metrics_v2" },
      body: {
        sessionId: "01JGAP.EPOCH",
        occurredAt: gapOccurrence.toISOString(),
        appVersion: "2.4.0",
      },
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { recorded: false, reason: "disabled" });
    assert.equal(await prisma.userActivityDay.count(), 0);
  });

  it("foreground upserts one ET day and reordered retries cannot regress metadata", async () => {
    const epoch = await enableTelemetry();
    await prisma.adminMetricsCollectionEpoch.update({
      where: { id: epoch.id },
      data: { startedAt: new Date("2026-08-18T00:00:00.000Z") },
    });
    const user = await createTestUser();
    const later = new Date("2026-08-18T16:00:00.000Z");
    const earlier = new Date("2026-08-18T14:00:00.000Z");
    for (const [occurredAt, version] of [[later, "2.4.0"], [earlier, "2.3.9"]]) {
      const response = await request(server.baseUrl, "POST", "/analytics/foreground", {
        token: user.token,
        body: {
          sessionId: `01J${version.replaceAll(".", "")}`,
          occurredAt: occurredAt.toISOString(),
          appVersion: version,
        },
        headers: { "X-Client-Features": "admin_metrics_v2" },
      });
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { recorded: true });
    }
    const rows = await prisma.userActivityDay.findMany();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].activityDate.toISOString().slice(0, 10), "2026-08-18");
    assert.equal(rows[0].firstSeenAt.toISOString(), earlier.toISOString());
    assert.equal(rows[0].lastSeenAt.toISOString(), later.toISOString());
    assert.equal(rows[0].appVersion, "2.4.0");
    assert.equal(rows[0].metadataOccurredAt.toISOString(), later.toISOString());
    const stored = await prisma.user.findUnique({ where: { id: user.user.id } });
    assert.equal(stored.metricsV2EligibleEpochId, epoch.id);
    assert.ok(stored.metricsV2EligibleAt);
  });

  it("foreground preserves the first eligibility instant within an epoch", async () => {
    const epoch = await enableTelemetry();
    const firstEligibleAt = new Date(Date.now() - 30 * 60 * 1000);
    const user = await createTestUser({
      metricsV2EligibleAt: firstEligibleAt,
      metricsV2EligibleEpochId: epoch.id,
    });
    const response = await request(server.baseUrl, "POST", "/analytics/foreground", {
      token: user.token,
      headers: { "X-Client-Features": "admin_metrics_v2" },
      body: {
        sessionId: "01JFIRST.ELIGIBLE",
        occurredAt: new Date().toISOString(),
        appVersion: "2.4.0",
      },
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { recorded: true });
    const stored = await prisma.user.findUnique({ where: { id: user.user.id } });
    assert.equal(stored.metricsV2EligibleAt.toISOString(), firstEligibleAt.toISOString());
  });

  it("notification-open is disabled without attribution writes", async () => {
    const user = await createTestUser();
    const response = await request(
      server.baseUrl,
      "POST",
      "/analytics/notification-open",
      { token: user.token, body: { notificationId: "01JNOTIFICATION.TEST" } }
    );
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { attributed: false, reason: "disabled" });
  });

  it("notification-open does not expose unknown or other-user ids", async () => {
    await enableTelemetry();
    const owner = await createTestUser();
    const caller = await createTestUser();
    await prisma.pushDelivery.create({
      data: {
        publicId: "01JOWNED.NOTIFICATION",
        deliveryKey: "test:owned",
        userId: owner.user.id,
        notificationType: "race_started",
        openCapable: true,
        providerAcceptedAt: new Date(),
      },
    });
    for (const notificationId of ["01JUNKNOWN.NOTIFICATION", "01JOWNED.NOTIFICATION"]) {
      const response = await request(
        server.baseUrl,
        "POST",
        "/analytics/notification-open",
        { token: caller.token, body: { notificationId } }
      );
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { attributed: false });
    }
  });

  it("notification-open stamps the owning delivery idempotently", async () => {
    await enableTelemetry();
    const owner = await createTestUser();
    await prisma.pushDelivery.create({
      data: {
        publicId: "01JOPEN.NOTIFICATION",
        deliveryKey: "test:open",
        userId: owner.user.id,
        notificationType: "race_started",
        openCapable: true,
        providerAcceptedAt: new Date(),
      },
    });
    for (let i = 0; i < 2; i++) {
      const response = await request(
        server.baseUrl,
        "POST",
        "/analytics/notification-open",
        { token: owner.token, body: { notificationId: "01JOPEN.NOTIFICATION" } }
      );
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { attributed: true });
    }
    const delivery = await prisma.pushDelivery.findUnique({
      where: { publicId: "01JOPEN.NOTIFICATION" },
    });
    assert.ok(delivery.openedAt);
  });

  it("notification-open never overwrites the first open timestamp", async () => {
    await enableTelemetry();
    const owner = await createTestUser();
    const firstOpenedAt = new Date("2026-08-17T12:00:00.000Z");
    await prisma.pushDelivery.create({
      data: {
        publicId: "01JFIRST.OPENED",
        deliveryKey: "test:first-opened",
        userId: owner.user.id,
        notificationType: "race_started",
        openCapable: true,
        providerAcceptedAt: new Date(),
        openedAt: firstOpenedAt,
      },
    });
    const response = await request(
      server.baseUrl,
      "POST",
      "/analytics/notification-open",
      { token: owner.token, body: { notificationId: "01JFIRST.OPENED" } }
    );
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { attributed: true });
    const stored = await prisma.pushDelivery.findUnique({
      where: { publicId: "01JFIRST.OPENED" },
    });
    assert.equal(stored.openedAt.toISOString(), firstOpenedAt.toISOString());
  });

  it("accepts iOS v2 activation events from Google Sign-In accounts", async () => {
    await enableTelemetry();
    const google = await prisma.user.create({
      data: { googleSub: `activation-google-ios-${Date.now()}` },
    });
    const sessionToken = signSessionToken({ userId: google.id, googleSub: google.googleSub });
    const raceId = "11111111-1111-4111-8111-111111111111";
    const events = [
      {
        id: "v2-health-event",
        name: "health_connected",
        context: { source: "healthkit" },
        appVersion: "2.4.0",
        platform: "ios",
        timestamp: new Date().toISOString(),
      },
      {
        id: "v2-leaderboard-event",
        name: "race_leaderboard_viewed",
        context: { race_id: raceId },
        appVersion: "2.4.0",
        platform: "ios",
        timestamp: new Date().toISOString(),
      },
    ];
    const response = await request(
      server.baseUrl,
      "POST",
      "/analytics/activation-events",
      {
        token: sessionToken,
        body: { events },
        headers: { "X-Client-Features": "admin_metrics_v2" },
      }
    );
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 2, inserted: 2 });
  });

  it("soft-drops only v2 events when disabled and retains legacy writes", async () => {
    const user = await createTestUser();
    const timestamp = new Date().toISOString();
    const response = await request(
      server.baseUrl,
      "POST",
      "/analytics/activation-events",
      {
        token: user.token,
        body: {
          events: [
            { id: "disabled-v2", name: "health_connected", context: { source: "healthkit" }, appVersion: "2.4.0", platform: "ios", timestamp },
            { id: "enabled-legacy", name: "home_reached", context: {}, appVersion: "2.4.0", platform: "ios", timestamp },
          ],
        },
      }
    );
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 1, inserted: 1 });
    const rows = await prisma.activationEvent.findMany();
    assert.deepEqual(rows.map((row) => row.name), ["home_reached"]);
  });

  it("soft-drops v2 events from Android envelopes without affecting the batch", async () => {
    await enableTelemetry();
    const user = await createTestUser();
    const timestamp = new Date().toISOString();
    const response = await request(
      server.baseUrl,
      "POST",
      "/analytics/activation-events",
      {
        token: user.token,
        body: {
          events: [
            { id: "android-v2", name: "health_connected", context: { source: "healthkit" }, appVersion: "2.4.0", platform: "android", timestamp },
          ],
        },
      }
    );
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 0, inserted: 0 });
  });

  it("stamps immutable signup eligibility only for capable Apple creates and keeps it off the wire", async () => {
    const epoch = await enableTelemetry();
    const response = await request(server.baseUrl, "POST", "/auth/apple", {
      headers: { "X-Client-Features": "admin_metrics_v2" },
      body: { identityToken: `metrics-signup-${Date.now()}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    for (const privateKey of [
      "metricsV2EligibleAt",
      "metricsV2EligibleEpochId",
      "metricsV2SignupEligible",
      "metricsV2SignupEpochId",
    ]) {
      assert.equal(privateKey in body.user, false);
    }
    const stored = await prisma.user.findUnique({ where: { id: body.user.id } });
    assert.equal(stored.metricsV2SignupEligible, true);
    assert.equal(stored.metricsV2SignupEpochId, epoch.id);
  });

  it("stamps immutable signup eligibility for capable Google Sign-In creates", async () => {
    const epoch = await enableTelemetry();
    const googleServer = await startServer({
      verifyGoogleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
    });
    try {
      const response = await request(googleServer.baseUrl, "POST", "/auth/google", {
        headers: { "X-Client-Features": "admin_metrics_v2" },
        body: { idToken: `metrics-google-signup-${Date.now()}` },
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      for (const privateKey of [
        "metricsV2EligibleAt",
        "metricsV2EligibleEpochId",
        "metricsV2SignupEligible",
        "metricsV2SignupEpochId",
      ]) {
        assert.equal(privateKey in body.user, false);
      }
      const stored = await prisma.user.findUnique({ where: { id: body.user.id } });
      assert.equal(stored.metricsV2SignupEligible, true);
      assert.equal(stored.metricsV2SignupEpochId, epoch.id);
      assert.equal(stored.metricsV2EligibleEpochId, epoch.id);
      assert.ok(stored.metricsV2EligibleAt);
    } finally {
      await googleServer.close();
    }
  });

  it("stamps only capable iOS device tokens with the current open epoch", async () => {
    const epoch = await enableTelemetry();
    const google = await prisma.user.create({
      data: { googleSub: `device-google-ios-${Date.now()}` },
    });
    const token = signSessionToken({ userId: google.id, googleSub: google.googleSub });
    const response = await request(
      server.baseUrl,
      "POST",
      "/notifications/device-token",
      {
        token,
        headers: { "X-Client-Features": "admin_metrics_v2" },
        body: { deviceToken: "capable-ios-token", platform: "ios" },
      }
    );
    assert.equal(response.status, 200);
    const storedToken = await prisma.deviceToken.findFirst({
      where: { token: "capable-ios-token" },
    });
    assert.equal(storedToken.adminMetricsOpenCapable, true);
    assert.equal(storedToken.adminMetricsOpenEpochId, epoch.id);

    const androidResponse = await request(
      server.baseUrl,
      "POST",
      "/notifications/device-token",
      {
        token,
        headers: { "X-Client-Features": "admin_metrics_v2" },
        body: { deviceToken: "google-android-token", platform: "android" },
      }
    );
    assert.equal(androidResponse.status, 200);
    const androidToken = await prisma.deviceToken.findFirst({
      where: { token: "google-android-token" },
    });
    assert.equal(androidToken.adminMetricsOpenCapable, false);
    assert.equal(androidToken.adminMetricsOpenEpochId, null);
  });

  it("creates one accepted delivery fact for central and special visible direct sends", async () => {
    const epoch = await enableTelemetry();
    const actor = await createTestUser();
    const recipient = {
      user: await prisma.user.create({
        data: { googleSub: `direct-google-ios-${Date.now()}` },
      }),
    };
    await prisma.deviceToken.create({
      data: {
        userId: recipient.user.id,
        token: "direct-capable-ios",
        platform: "ios",
        adminMetricsOpenCapable: true,
        adminMetricsOpenEpochId: epoch.id,
      },
    });
    const sent = [];
    const bus = asyncEventBus();
    registerNotificationHandlers({
      eventBus: bus,
      prisma,
      appSettings: {
        async getFlag(name) { return name === "adminMetricsV2TelemetryEnabled"; },
      },
      apnsService: {
        async sendNotification(input) { sent.push(input); return { success: true }; },
        async sendSilentNotification() { return { success: true }; },
      },
      Notification: { async create() {}, async findFirstByUserTypeSince() { return null; } },
      logger: { log() {}, warn() {}, error() {} },
    });

    await bus.emit("FRIEND_REQUEST_SENT", {
      userId: actor.user.id,
      addresseeId: recipient.user.id,
    });
    await bus.emit("DAILY_MOVER", {
      userId: recipient.user.id,
      raceId: "direct-visible-race",
      raceName: "Direct visible race",
      movement: 4,
      placement: 2,
    });
    await deliverVisible({
      settings: { async getFlag(name) { return name === "adminMetricsV2TelemetryEnabled"; } },
      apns: { async sendNotification(input) { sent.push(input); return { success: true }; } },
    });

    const deliveries = await prisma.pushDelivery.findMany({ orderBy: { notificationType: "asc" } });
    assert.equal(deliveries.length, 2);
    assert.ok(deliveries.every((row) => row.openCapable && row.providerAcceptedAt));
    assert.equal(new Set(deliveries.map((row) => row.publicId)).size, 2);
    assert.deepEqual(
      new Set(sent.map((call) => call.payload.notificationId)),
      new Set(deliveries.map((row) => row.publicId))
    );
  });

  it("attributes chat, placement, high-multiplier, and daily-mover visible paths", async () => {
    const epoch = await enableTelemetry();
    const sender = await createTestUser();
    const recipient = await createTestUser();
    await prisma.deviceToken.create({
      data: {
        userId: recipient.user.id,
        token: "special-capable-ios",
        platform: "ios",
        adminMetricsOpenCapable: true,
        adminMetricsOpenEpochId: epoch.id,
      },
    });
    const race = await prisma.race.create({
      data: {
        creatorId: sender.user.id,
        name: "Special visible race",
        targetSteps: 1000,
        status: "ACTIVE",
        startedAt: new Date(),
      },
    });
    await prisma.raceParticipant.createMany({
      data: [
        { raceId: race.id, userId: sender.user.id, status: "ACCEPTED" },
        { raceId: race.id, userId: recipient.user.id, status: "ACCEPTED" },
      ],
    });
    const sent = [];
    const bus = asyncEventBus();
    registerNotificationHandlers({
      eventBus: bus,
      prisma,
      appSettings: {
        async getFlag(name) { return name === "adminMetricsV2TelemetryEnabled"; },
      },
      apnsService: {
        async sendNotification(input) { sent.push(input); return { success: true }; },
        async sendSilentNotification() { return { success: true }; },
      },
      Notification: {
        async create() {},
        async findFirstByUserTypeSince() { return null; },
      },
      logger: { log() {}, warn() {}, error() {} },
    });

    await bus.emit("RACE_MESSAGE_SENT", {
      raceId: race.id,
      messageId: `message-${Date.now()}`,
      senderId: sender.user.id,
      senderName: "Sender",
      raceName: race.name,
      body: "Visible chat",
    });
    await bus.emit("PLACEMENT_CHANGED", {
      raceId: race.id,
      raceName: race.name,
      userId: recipient.user.id,
      previousPlacement: 2,
      placement: 1,
      paidPlaces: 1,
    });
    await bus.emit("HIGH_MULTIPLIER_ALERT", {
      raceId: race.id,
      raceName: race.name,
      actorUserId: sender.user.id,
      actorName: "Sender",
      multiplier: 4,
      recipientUserIds: [recipient.user.id],
      notificationIntentId: "high-multiplier:special-path:2026-08-18T14:00:00.000Z",
    });
    await bus.emit("DAILY_MOVER", {
      userId: recipient.user.id,
      raceId: race.id,
      raceName: race.name,
      movement: 2,
      placement: 2,
    });
    await deliverVisible({
      settings: { async getFlag(name) { return name === "adminMetricsV2TelemetryEnabled"; } },
      apns: { async sendNotification(input) { sent.push(input); return { success: true }; } },
    });

    const deliveries = await prisma.pushDelivery.findMany();
    assert.deepEqual(
      new Set(deliveries.map((row) => row.notificationType)),
      new Set([
        "race_message",
        "PLACEMENT_CHANGED",
        "HIGH_MULTIPLIER_ALERT",
        "DAILY_MOVER",
      ])
    );
    assert.equal(deliveries.length, 4);
    assert.equal(sent.length, 4);
    assert.ok(sent.every((call) => call.payload.notificationId));
  });

  it("routes race-resolution visible delivery intents through durable attribution", async () => {
    const epoch = await enableTelemetry();
    const recipient = await createTestUser();
    await prisma.deviceToken.create({
      data: {
        userId: recipient.user.id,
        token: "resolution-capable-ios",
        platform: "ios",
        adminMetricsOpenCapable: true,
        adminMetricsOpenEpochId: epoch.id,
      },
    });
    const sent = [];
    const occurrenceAt = new Date("2026-08-18T14:00:00.000Z");
    const delivery = buildRaceResolutionDeliveryIntents({
      prisma,
      now: () => occurrenceAt,
    });
    const actor = await createTestUser();
    const event = {
      raceId: "resolution-race",
      raceName: "Resolution race",
      actorUserId: actor.user.id,
      actorName: actor.user.displayName,
      multiplier: 5,
      recipientUserIds: [recipient.user.id],
    };
    await delivery.claimHighMultiplier(event, { sourceGeneration: "generation-1" });
    await delivery.claimHighMultiplier(event, { sourceGeneration: "generation-1" });
    await buildNotificationProjector({ prisma, logger: { log() {}, warn() {}, error() {} } }).run();
    await deliverVisible({
      settings: { async getFlag(name) { return name === "adminMetricsV2TelemetryEnabled"; } },
      apns: { async sendNotification(input) { sent.push(input); return { success: true }; } },
    });

    const facts = await prisma.pushDelivery.findMany();
    assert.equal(facts.length, 1);
    assert.ok(facts[0].deliveryKey.startsWith(
      `visible:HIGH_MULTIPLIER_ALERT:${recipient.user.id}:`
    ));
    assert.ok(facts[0].providerAcceptedAt);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.notificationId, facts[0].publicId);
  });

  it("uses one canonical delivery identity across Inbox and direct retries", async () => {
    const epoch = await enableTelemetry();
    const recipient = await createTestUser();
    await prisma.deviceToken.create({
      data: {
        userId: recipient.user.id,
        token: "path-switch-capable-ios",
        platform: "ios",
        adminMetricsOpenCapable: true,
        adminMetricsOpenEpochId: epoch.id,
      },
    });
    const settings = {
      async getFlag(name) {
        if (name === "adminMetricsV2TelemetryEnabled") return true;
        return false;
      },
    };
    const sent = [];
    const apns = {
      async sendNotification(input) { sent.push(input); return { success: true }; },
      async sendSilentNotification() { return { success: true }; },
    };
    const bus = asyncEventBus();
    registerNotificationHandlers({
      eventBus: bus,
      prisma,
      appSettings: settings,
      apnsService: apns,
      Notification: { async create() {} },
      logger: { log() {}, warn() {}, error() {} },
    });
    const intent = {
      notificationIntentId: "buyin-intent-1",
      raceId: "same-race",
      raceName: "Same race",
      newBuyIn: 20,
      affectedUserIds: [recipient.user.id],
    };
    await bus.emit("RACE_BUYIN_CHANGED", intent);
    await buildInboxDelivery({
      prisma,
      appSettings: settings,
      apnsService: apns,
      logger: { log() {}, warn() {}, error() {} },
    })();
    await bus.emit("RACE_BUYIN_CHANGED", intent);

    const facts = await prisma.pushDelivery.findMany();
    assert.equal(facts.length, 1);
    assert.equal(
      facts[0].deliveryKey,
      `visible:RACE_BUYIN_CHANGED:${recipient.user.id}:buyin-intent-1`
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.notificationId, facts[0].publicId);
  });

  it("uses the persisted global-event id across Inbox, direct path-switch, and retry", async () => {
    const epoch = await enableTelemetry();
    const recipient = await createTestUser();
    await prisma.deviceToken.create({
      data: {
        userId: recipient.user.id,
        token: "global-event-path-switch-ios",
        platform: "ios",
        adminMetricsOpenCapable: true,
        adminMetricsOpenEpochId: epoch.id,
      },
    });
    const event = await prisma.globalStepEvent.create({
      data: {
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 29 * 60_000),
        multiplier: 2,
      },
    });
    const settings = {
      async getFlag(name) {
        if (name === "adminMetricsV2TelemetryEnabled") return true;
        return false;
      },
    };
    const sent = [];
    const apns = {
      async sendNotification(input) { sent.push(input); return { success: true }; },
    };
    const payload = {
      eventId: event.id,
      multiplier: event.multiplier,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      participantUserIds: [recipient.user.id],
    };
    const inboxBus = asyncEventBus();
    registerNotificationHandlers({
      eventBus: inboxBus, prisma, appSettings: settings, apnsService: apns,
      Notification: { async create() {} },
      logger: { log() {}, warn() {}, error() {} },
    });
    await inboxBus.emit("GLOBAL_EVENT_STARTED", payload);
    await buildInboxDelivery({
      prisma, appSettings: settings, apnsService: apns,
      logger: { log() {}, warn() {}, error() {} },
    })();

    const directBus = asyncEventBus();
    registerNotificationHandlers({
      eventBus: directBus, prisma, appSettings: settings, apnsService: apns,
      Notification: { async create() {} },
      logger: { log() {}, warn() {}, error() {} },
    });
    await directBus.emit("GLOBAL_EVENT_STARTED", payload);
    await directBus.emit("GLOBAL_EVENT_STARTED", payload);

    const facts = await prisma.pushDelivery.findMany();
    assert.equal(facts.length, 1);
    assert.equal(
      facts[0].deliveryKey,
      `visible:GLOBAL_EVENT_STARTED:${recipient.user.id}:${event.id}`
    );
    assert.equal(sent.length, 1);
    assert.ok(sent.every((call) => call.payload.notificationId === facts[0].publicId));
  });

  it("persists one durable high-multiplier intent per re-armed crossing", async () => {
    const epoch = await enableTelemetry();
    const actor = await createTestUser();
    const recipient = await createTestUser();
    await prisma.deviceToken.create({
      data: {
        userId: recipient.user.id,
        token: "high-multiplier-crossing-ios",
        platform: "ios",
        adminMetricsOpenCapable: true,
        adminMetricsOpenEpochId: epoch.id,
      },
    });
    const race = await prisma.race.create({
      data: {
        creatorId: actor.user.id,
        name: "Two crossings",
        targetSteps: 1000,
        status: "ACTIVE",
        startedAt: new Date(),
      },
    });
    await prisma.raceParticipant.createMany({
      data: [
        { raceId: race.id, userId: actor.user.id, status: "ACCEPTED" },
        { raceId: race.id, userId: recipient.user.id, status: "ACCEPTED" },
      ],
    });
    const sent = [];
    const bus = asyncEventBus();
    registerNotificationHandlers({
      eventBus: bus,
      prisma,
      appSettings: {
        async getFlag(name) { return name === "adminMetricsV2TelemetryEnabled"; },
      },
      apnsService: {
        async sendNotification(input) { sent.push(input); return { success: true }; },
      },
      Notification: {
        async create() {},
        async findFirstByUserTypeSince() { return null; },
      },
      logger: { log() {}, warn() {}, error() {} },
    });
    const participantFor = () => prisma.raceParticipant.findFirst({
      where: { raceId: race.id, userId: actor.user.id },
      include: { user: true },
    });
    const actorParticipant = await participantFor();
    const emitAlert = async (alert) => {
      await bus.emit("HIGH_MULTIPLIER_ALERT", alert);
      return [];
    };
    const rival = await prisma.raceParticipant.findFirst({
      where: { raceId: race.id, userId: recipient.user.id },
    });
    const firstAt = new Date("2026-08-18T14:00:00.000Z");
    await evaluateHighMultiplierAlert({
      participant: await participantFor(), currentMultiplier: 5, race,
      otherParticipants: [rival], prisma, emitAlert, now: () => firstAt,
    });
    const firstEvent = {
      raceId: race.id,
      raceName: race.name,
      actorUserId: actor.user.id,
      actorName: actor.user.displayName,
      multiplier: 5,
      recipientUserIds: [recipient.user.id],
      notificationIntentId: `high-multiplier:${actorParticipant.id}:${firstAt.toISOString()}`,
    };
    await bus.emit("HIGH_MULTIPLIER_ALERT", firstEvent);
    await evaluateHighMultiplierAlert({
      participant: await participantFor(), currentMultiplier: 4, race,
      otherParticipants: [rival], prisma, emitAlert, now: () => new Date("2026-08-18T14:01:00.000Z"),
    });
    const secondAt = new Date("2026-08-18T14:02:00.000Z");
    await evaluateHighMultiplierAlert({
      participant: await participantFor(), currentMultiplier: 5, race,
      otherParticipants: [rival], prisma, emitAlert, now: () => secondAt,
    });
    await deliverVisible({
      settings: { async getFlag(name) { return name === "adminMetricsV2TelemetryEnabled"; } },
      apns: { async sendNotification(input) { sent.push(input); return { success: true }; } },
    });

    const facts = await prisma.pushDelivery.findMany({ orderBy: { deliveryKey: "asc" } });
    assert.equal(facts.length, 2, "retry reuses the first crossing; re-armed crossing is distinct");
    assert.deepEqual(
      facts.map((row) => row.deliveryKey),
      [firstAt, secondAt].map(
        (at) =>
          `visible:HIGH_MULTIPLIER_ALERT:${recipient.user.id}:high-multiplier:${actorParticipant.id}:${at.toISOString()}`
      ).sort()
    );
    assert.equal(sent.length, 2);
    assert.notEqual(sent[0].payload.notificationId, sent[1].payload.notificationId);
  });

  it("keeps distinct identical-context special notification intents separate", async () => {
    const epoch = await enableTelemetry();
    const recipient = await createTestUser();
    await prisma.deviceToken.create({
      data: {
        userId: recipient.user.id,
        token: "distinct-intents-capable-ios",
        platform: "ios",
        adminMetricsOpenCapable: true,
        adminMetricsOpenEpochId: epoch.id,
      },
    });
    const sent = [];
    const bus = asyncEventBus();
    registerNotificationHandlers({
      eventBus: bus,
      prisma,
      appSettings: {
        async getFlag(name) { return name === "adminMetricsV2TelemetryEnabled"; },
      },
      apnsService: {
        async sendNotification(input) { sent.push(input); return { success: true }; },
      },
      Notification: { async create() {} },
      logger: { log() {}, warn() {}, error() {} },
    });
    const base = {
      userId: recipient.user.id,
      raceId: "identical-context-race",
      raceName: "Identical context",
      movement: 1,
      placement: 2,
    };
    await bus.emit("DAILY_MOVER", { ...base, notificationIntentId: "mover-intent-a" });
    await bus.emit("DAILY_MOVER", { ...base, notificationIntentId: "mover-intent-a" });
    await bus.emit("DAILY_MOVER", { ...base, notificationIntentId: "mover-intent-b" });
    await deliverVisible({
      settings: { async getFlag(name) { return name === "adminMetricsV2TelemetryEnabled"; } },
      apns: { async sendNotification(input) { sent.push(input); return { success: true }; } },
    });

    const facts = await prisma.pushDelivery.findMany({ orderBy: { deliveryKey: "asc" } });
    assert.equal(facts.length, 2);
    assert.deepEqual(
      facts.map((row) => row.deliveryKey),
      [
        `visible:DAILY_MOVER:${recipient.user.id}:mover-intent-a`,
        `visible:DAILY_MOVER:${recipient.user.id}:mover-intent-b`,
      ]
    );
    assert.equal(sent.length, 2);
    assert.notEqual(sent[0].payload.notificationId, sent[1].payload.notificationId);
  });

  it("canonicalizes differing internal and wire notification type names", async () => {
    const epoch = await enableTelemetry();
    const recipient = await createTestUser();
    await prisma.deviceToken.create({
      data: {
        userId: recipient.user.id,
        token: "wire-type-capable-ios",
        platform: "ios",
        adminMetricsOpenCapable: true,
        adminMetricsOpenEpochId: epoch.id,
      },
    });
    const settings = {
      async getFlag(name) {
        return name === "adminMetricsV2TelemetryEnabled";
      },
    };
    const sent = [];
    const apns = {
      async sendNotification(input) { sent.push(input); return { success: true }; },
    };
    const event = {
      notificationIntentId: "team-lead-intent-1",
      raceId: "team-lead-race",
      raceName: "Team lead race",
      leadingTeamName: "Red",
      trailingTeamName: "Blue",
      memberUserIds: [recipient.user.id],
    };
    const inboxBus = asyncEventBus();
    registerNotificationHandlers({
      eventBus: inboxBus, prisma, appSettings: settings, apnsService: apns,
      Notification: { async create() {} },
      logger: { log() {}, warn() {}, error() {} },
    });
    await inboxBus.emit("TEAM_LEAD_CHANGED", event);
    await buildInboxDelivery({
      prisma, appSettings: settings, apnsService: apns,
      logger: { log() {}, warn() {}, error() {} },
    })();
    const directBus = asyncEventBus();
    registerNotificationHandlers({
      eventBus: directBus, prisma, appSettings: settings, apnsService: apns,
      Notification: { async create() {} },
      logger: { log() {}, warn() {}, error() {} },
    });
    await directBus.emit("TEAM_LEAD_CHANGED", event);

    const facts = await prisma.pushDelivery.findMany();
    assert.equal(facts.length, 1);
    assert.equal(
      facts[0].deliveryKey,
      `visible:TEAM_LEAD_CHANGE:${recipient.user.id}:team-lead-intent-1`
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.notificationId, facts[0].publicId);
  });

  it("reuses one accepted delivery fact when the Inbox outbox retries", async () => {
    const epoch = await enableTelemetry();
    const recipient = {
      user: await prisma.user.create({
        data: { googleSub: `inbox-google-ios-${Date.now()}` },
      }),
    };
    await prisma.deviceToken.create({
      data: {
        userId: recipient.user.id,
        token: "inbox-capable-ios",
        platform: "ios",
        adminMetricsOpenCapable: true,
        adminMetricsOpenEpochId: epoch.id,
      },
    });
    await createInboxAlert({
      prisma,
      userId: recipient.user.id,
      type: "DAILY_MOVER",
      title: "Inbox delivery",
      body: "Visible body",
      destination: { route: "home" },
      sourceKey: "metrics-inbox-retry",
    });
    const sent = [];
    const deliver = buildInboxDelivery({
      prisma,
      appSettings: { async getFlag(name) { return name === "adminMetricsV2TelemetryEnabled"; } },
      apnsService: { async sendNotification(input) { sent.push(input); return { success: true }; } },
      logger: { log() {}, warn() {}, error() {} },
    });
    await deliver();
    await prisma.inboxDeliveryOutbox.updateMany({
      data: { status: "RETRY", availableAt: new Date(0), deliveredAt: null },
    });
    await deliver();

    const deliveries = await prisma.pushDelivery.findMany();
    assert.equal(deliveries.length, 1);
    assert.ok(deliveries[0].openCapable && deliveries[0].providerAcceptedAt);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.notificationId, deliveries[0].publicId);
  });
});
