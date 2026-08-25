const assert = require("node:assert/strict");
const { after, before, beforeEach, test } = require("node:test");

process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
process.env.RACE_RESOLVE_DEBOUNCE_MS = "0";

const {
  cleanDatabase, createTestUser, disconnectDatabase, prisma, request, startServer,
} = require("./setup");
const {
  GlobalStepEventEntitlement,
} = require("../../src/modules/steps/models/globalStepEventEntitlement");
const {
  GlobalStepEvent,
} = require("../../src/modules/steps/models/globalStepEvent");
const {
  processDueEntitlementBoundaries,
} = require("../../src/modules/steps/services/globalStepEventEntitlement");
const redisCache = require("../../src/shared/cache/redisCache");
const { appSettings } = require("../../src/shared/config/appSettings");
const {
  buildRenewSeededRaces,
} = require("../../src/modules/races/jobs/seededRaceRenewal");
const {
  captureOperationalSnapshot,
} = require("../../src/modules/steps/services/globalStepEventObservability");
const {
  cleanupExpiredEntitlements,
} = require("../../src/modules/steps/services/globalStepEventRetention");
const {
  resolveExpiredRaces,
} = require("../../src/modules/races/jobs/raceExpiry");
const {
  buildGlobalEventSummaryTick,
} = require("../../src/modules/steps/jobs/globalEventSummary");
const {
  buildMaybeStartGlobalEvent,
} = require("../../src/modules/steps/jobs/globalStepEventScheduler");
const {
  chooseEventStartForEtDay,
} = require("../../src/modules/steps/globalStepEvent");
const {
  buildRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const {
  buildRecomputePlacements,
} = require("../../src/modules/races/jobs/placementRecompute");
const {
  createInboxAlert,
} = require("../../src/modules/inbox/services/inbox");
const derivedCache = require("../../src/shared/cache/derivedCache");
const cacheKeys = require("../../src/shared/cache/cacheKeys");

let server;
before(async () => { server = await startServer(); });
beforeEach(async () => cleanDatabase());
after(async () => { await server.close(); await disconnectDatabase(); });

test("unique entitlement snapshot and race/viewer eligibility are participant-specific", async () => {
  const [{ user: ny }, { user: madrid }] = await Promise.all([
    createTestUser({ globalEventTimezone: "America/New_York" }),
    createTestUser({ globalEventTimezone: "Europe/Madrid" }),
  ]);
  const now = new Date("2026-08-20T15:30:00.000Z");
  const race = await prisma.race.create({ data: {
    creatorId: ny.id,
    name: "Local 2x integration",
    targetSteps: 0,
    timeBased: true,
    maxDurationDays: 1,
    status: "ACTIVE",
    startedAt: new Date("2026-08-20T14:00:00.000Z"),
    endsAt: new Date("2026-08-21T14:00:00.000Z"),
  } });
  await prisma.raceParticipant.createMany({ data: [
    { raceId: race.id, userId: ny.id, status: "ACCEPTED", joinedAt: race.startedAt },
    { raceId: race.id, userId: madrid.id, status: "ACCEPTED", joinedAt: race.startedAt },
  ] });
  const event = await prisma.globalStepEvent.create({ data: {
    eventDay: "2026-08-20",
    scheduleMode: "LOCAL_ENTITLEMENTS",
    localStartMinute: 17 * 60 + 17,
    durationMinutes: 30,
    startsAt: new Date("2026-08-20T03:17:00.000Z"),
    endsAt: new Date("2026-08-21T05:47:00.000Z"),
    multiplier: 2,
  } });
  const madridEntitlement = await prisma.globalStepEventEntitlement.create({ data: {
    eventId: event.id,
    userId: madrid.id,
    timezone: "Europe/Madrid",
    localDate: "2026-08-20",
    startsAt: new Date("2026-08-20T15:17:00.000Z"),
    endsAt: new Date("2026-08-20T15:47:00.000Z"),
    startOutcome: "ACTIVATED_ON_TIME",
    startProcessedAt: new Date("2026-08-20T15:17:10.000Z"),
  } });
  await prisma.globalStepEventEntitlement.create({ data: {
    eventId: event.id,
    userId: ny.id,
    timezone: "America/New_York",
    localDate: "2026-08-20",
    startsAt: new Date("2026-08-20T21:17:00.000Z"),
    endsAt: new Date("2026-08-20T21:47:00.000Z"),
  } });
  await prisma.globalEventRaceImpact.create({ data: {
    eventId: event.id,
    raceId: race.id,
    userId: madrid.id,
    status: "PENDING",
  } });

  await assert.rejects(
    prisma.globalStepEventEntitlement.create({ data: {
      eventId: event.id,
      userId: madrid.id,
      timezone: "Pacific/Kiritimati",
      localDate: "2026-08-20",
      startsAt: new Date("2026-08-20T03:17:00.000Z"),
      endsAt: new Date("2026-08-20T03:47:00.000Z"),
    }}),
    (error) => error?.code === "P2002"
  );

  const map = await GlobalStepEventEntitlement.findEligibleByRace({
    raceId: race.id,
    userIds: [ny.id, madrid.id],
    rangeStart: race.startedAt,
    rangeEnd: now,
  });
  assert.deepEqual(map.get(ny.id), []);
  assert.equal(map.get(madrid.id).length, 1);
  assert.equal(map.get(madrid.id)[0].entitlementId, madridEntitlement.id);

  assert.equal(await GlobalStepEventEntitlement.findViewerActive({
    userId: ny.id, raceId: race.id, now,
  }), null);
  const banner = await GlobalStepEventEntitlement.findViewerActive({
    userId: madrid.id, raceId: race.id, now,
  });
  assert.equal(banner.multiplier, 2);
  assert.equal(banner.endsAt.toISOString(), "2026-08-20T15:47:00.000Z");
});

test("legacy creation adopts an old-worker exact-start row with a null event day", async () => {
  const startsAt = new Date("2026-08-20T21:17:00.000Z");
  const oldWorkerRow = await prisma.globalStepEvent.create({ data: {
    startsAt,
    endsAt: new Date("2026-08-20T21:47:00.000Z"),
    multiplier: 2,
  } });

  const result = await GlobalStepEvent.createIfAbsent({
    startsAt,
    endsAt: new Date("2026-08-20T21:47:00.000Z"),
    multiplier: 2,
    eventDay: "2026-08-20",
  });

  assert.equal(result.created, false);
  assert.equal(result.event.id, oldWorkerRow.id);
  assert.equal(result.event.eventDay, "2026-08-20");
  assert.equal(await prisma.globalStepEvent.count({ where: { startsAt } }), 1);
});

test("future local maintenance leaves an unfenced intervening day on the legacy path", async () => {
  const dayProbe = new Date("2026-08-20T16:00:00.000Z");
  const now = chooseEventStartForEtDay(dayProbe);
  const emitted = [];
  const run = buildMaybeStartGlobalEvent({
    now: () => now,
    localGlobalStepEventTick: async () => true,
    GlobalStepEvent,
    appSettings: { async getFlag() { return false; } },
    Race: { async findActiveParticipantUserIds() { return []; } },
    eventBus: { emit(name, payload) { emitted.push({ name, payload }); } },
    logger: { log() {}, error() {} },
  });

  const event = await run();

  assert.ok(event);
  assert.equal(event.scheduleMode, "LEGACY_GLOBAL");
  assert.equal(event.eventDay, "2026-08-20");
  assert.equal(await prisma.globalStepEvent.count({
    where: { eventDay: "2026-08-20" },
  }), 1);
  assert.equal(emitted.length, 1);
});

test("a future local envelope timestamp collision cannot claim the prior legacy day", async () => {
  const dayProbe = new Date("2026-08-21T16:00:00.000Z");
  const now = chooseEventStartForEtDay(dayProbe);
  const futureLocal = await prisma.globalStepEvent.create({ data: {
    eventDay: "2026-08-22",
    scheduleMode: "LOCAL_ENTITLEMENTS",
    localStartMinute: 642,
    durationMinutes: 30,
    startsAt: now,
    endsAt: new Date(now.getTime() + 26 * 60 * 60 * 1000),
    multiplier: 2,
  } });
  const run = buildMaybeStartGlobalEvent({
    now: () => now,
    localGlobalStepEventTick: async () => true,
    GlobalStepEvent,
    appSettings: { async getFlag() { return false; } },
    Race: { async findActiveParticipantUserIds() { return []; } },
    eventBus: { emit() {} },
    logger: { log() {}, error() {} },
  });

  const legacy = await run();

  assert.ok(legacy);
  assert.notEqual(legacy.id, futureLocal.id);
  assert.equal(legacy.eventDay, "2026-08-21");
  assert.equal(legacy.scheduleMode, "LEGACY_GLOBAL");
  assert.equal(await prisma.globalStepEvent.count({ where: { startsAt: now } }), 2);
});

test("a same-day local parent fences the legacy scheduler", async () => {
  const dayProbe = new Date("2026-08-21T16:00:00.000Z");
  const now = chooseEventStartForEtDay(dayProbe);
  const local = await prisma.globalStepEvent.create({ data: {
    eventDay: "2026-08-21",
    scheduleMode: "LOCAL_ENTITLEMENTS",
    localStartMinute: 900,
    durationMinutes: 30,
    startsAt: new Date(now.getTime() + 6 * 60 * 60 * 1000),
    endsAt: new Date(now.getTime() + 32 * 60 * 60 * 1000),
    multiplier: 2,
  } });
  const run = buildMaybeStartGlobalEvent({
    now: () => now,
    localGlobalStepEventTick: async () => true,
    GlobalStepEvent,
    appSettings: { async getFlag() { return false; } },
    Race: { async findActiveParticipantUserIds() { return []; } },
    eventBus: { emit() { assert.fail("same-day local parent must suppress legacy fan-out"); } },
    logger: { log() {}, error() {} },
  });

  assert.equal(await run(), null);
  assert.equal(await prisma.globalStepEvent.count({ where: { eventDay: "2026-08-21" } }), 1);
  assert.equal((await prisma.globalStepEvent.findUnique({
    where: { eventDay: "2026-08-21" },
  })).id, local.id);
});

test("authenticated uploads and progress keep two local zones isolated and old clients compatible", async () => {
  const [{ user: ny, token: nyToken }, { user: madrid, token: madridToken }] =
    await Promise.all([
      createTestUser({ globalEventTimezone: "America/New_York" }),
      createTestUser({ globalEventTimezone: "Europe/Madrid" }),
    ]);
  const now = new Date();
  const raceStart = new Date(now.getTime() - 8 * 60 * 60 * 1000);
  const race = await prisma.race.create({ data: {
    creatorId: ny.id,
    name: "Two-zone HTTP local 2x",
    targetSteps: 0,
    timeBased: true,
    maxDurationDays: 1,
    status: "ACTIVE",
    startedAt: raceStart,
    endsAt: new Date(now.getTime() + 16 * 60 * 60 * 1000),
  } });
  await prisma.raceParticipant.createMany({ data: [
    { raceId: race.id, userId: ny.id, status: "ACCEPTED", joinedAt: raceStart },
    { raceId: race.id, userId: madrid.id, status: "ACCEPTED", joinedAt: raceStart },
  ] });

  const scoredParent = await prisma.globalStepEvent.create({ data: {
    eventDay: "2098-08-19",
    scheduleMode: "LOCAL_ENTITLEMENTS",
    localStartMinute: 600,
    durationMinutes: 30,
    startsAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    endsAt: new Date(now.getTime() - 90 * 60 * 1000),
    multiplier: 2,
  } });
  const nyWindow = {
    startsAt: new Date(now.getTime() - 4 * 60 * 60 * 1000),
    endsAt: new Date(now.getTime() - 3 * 60 * 60 * 1000),
  };
  const madridWindow = {
    startsAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    endsAt: new Date(now.getTime() - 6 * 60 * 60 * 1000),
  };
  await prisma.globalStepEventEntitlement.createMany({ data: [
    { eventId: scoredParent.id, userId: ny.id, timezone: "America/New_York",
      localDate: "2098-08-19", ...nyWindow, startOutcome: "ACTIVATED_ON_TIME",
      startProcessedAt: nyWindow.startsAt, endProcessedAt: nyWindow.endsAt },
    { eventId: scoredParent.id, userId: madrid.id, timezone: "Europe/Madrid",
      localDate: "2098-08-19", ...madridWindow, startOutcome: "ACTIVATED_ON_TIME",
      startProcessedAt: madridWindow.startsAt, endProcessedAt: madridWindow.endsAt },
  ] });
  await prisma.globalEventRaceImpact.createMany({ data: [
    { eventId: scoredParent.id, raceId: race.id, userId: ny.id, status: "PENDING" },
    { eventId: scoredParent.id, raceId: race.id, userId: madrid.id, status: "PENDING" },
  ] });

  const [nyUpload, madridUpload] = await Promise.all([
    request(server.baseUrl, "POST", "/steps/samples", {
      token: nyToken,
      // Deliberately omit X-Timezone: this is the frozen-client request shape.
      body: { samples: [{ periodStart: nyWindow.startsAt.toISOString(),
        periodEnd: nyWindow.endsAt.toISOString(), steps: 100 }] },
    }),
    request(server.baseUrl, "POST", "/steps/samples", {
      token: madridToken,
      headers: { "X-Timezone": "Europe/Madrid" },
      body: { samples: [{ periodStart: madridWindow.startsAt.toISOString(),
        periodEnd: madridWindow.endsAt.toISOString(), steps: 100 }] },
    }),
  ]);
  assert.equal(nyUpload.status, 200);
  assert.equal(madridUpload.status, 200);

  const [nyResponse, madridResponse] = await Promise.all([
    request(server.baseUrl, "GET", `/races/${race.id}/progress`, { token: nyToken }),
    request(server.baseUrl, "GET", `/races/${race.id}/progress`, { token: madridToken }),
  ]);
  assert.equal(nyResponse.status, 200);
  assert.equal(madridResponse.status, 200);
  const nyProgress = (await nyResponse.json()).progress;
  const madridProgress = (await madridResponse.json()).progress;
  for (const progress of [nyProgress, madridProgress]) {
    assert.equal(progress.participants.find((row) => row.userId === ny.id).totalSteps, 200);
    assert.equal(progress.participants.find((row) => row.userId === madrid.id).totalSteps, 200);
  }
});

test("HTTP progress clips local boost to race start and each participant's late join", async () => {
  const [{ user: creator, token: creatorToken }, { user: late, token: lateToken }] =
    await Promise.all([createTestUser(), createTestUser()]);
  const now = new Date();
  const windowStart = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  const windowEnd = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const raceStart = new Date(windowStart.getTime() + 15 * 60 * 1000);
  const lateJoin = new Date(windowStart.getTime() + 30 * 60 * 1000);
  const race = await prisma.race.create({ data: {
    creatorId: creator.id,
    name: "HTTP clipped local window",
    targetSteps: 0,
    timeBased: true,
    maxDurationDays: 1,
    status: "ACTIVE",
    startedAt: raceStart,
    endsAt: new Date(now.getTime() + 12 * 60 * 60 * 1000),
  } });
  await prisma.raceParticipant.createMany({ data: [
    { raceId: race.id, userId: creator.id, status: "ACCEPTED", joinedAt: raceStart },
    { raceId: race.id, userId: late.id, status: "ACCEPTED", joinedAt: lateJoin },
  ] });
  const event = await prisma.globalStepEvent.create({ data: {
    eventDay: "2098-08-20",
    scheduleMode: "LOCAL_ENTITLEMENTS",
    localStartMinute: 600,
    durationMinutes: 30,
    startsAt: windowStart,
    endsAt: windowEnd,
    multiplier: 2,
  } });
  await prisma.globalStepEventEntitlement.createMany({ data: [creator.id, late.id].map((userId) => ({
    eventId: event.id,
    userId,
    timezone: "America/New_York",
    localDate: "2098-08-20",
    startsAt: windowStart,
    endsAt: windowEnd,
    startOutcome: "ACTIVATED_ON_TIME",
    startProcessedAt: windowStart,
    endProcessedAt: windowEnd,
  })) });
  await prisma.globalEventRaceImpact.createMany({ data: [creator.id, late.id].map((userId) => ({
    eventId: event.id, raceId: race.id, userId, status: "PENDING",
  })) });
  const sample = {
    periodStart: windowStart.toISOString(), periodEnd: windowEnd.toISOString(), steps: 100,
  };
  const uploads = await Promise.all([
    request(server.baseUrl, "POST", "/steps/samples", {
      token: creatorToken, body: { samples: [sample] },
    }),
    request(server.baseUrl, "POST", "/steps/samples", {
      token: lateToken, body: { samples: [sample] },
    }),
  ]);
  assert.ok(uploads.every((response) => response.status === 200));
  const response = await request(server.baseUrl, "GET", `/races/${race.id}/progress`, {
    token: lateToken,
  });
  assert.equal(response.status, 200);
  const participants = (await response.json()).progress.participants;
  assert.equal(participants.find((row) => row.userId === creator.id).totalSteps, 150);
  assert.equal(participants.find((row) => row.userId === late.id).totalSteps, 100);
});

test("concurrent HTTP late join and local boundary produce one durable enrollment", async () => {
  const [{ user: creator }, { user: joiner, token }] = await Promise.all([
    createTestUser(), createTestUser(),
  ]);
  const now = new Date();
  const race = await prisma.race.create({ data: {
    creatorId: creator.id,
    name: "Concurrent local boundary join",
    targetSteps: 0,
    timeBased: true,
    maxDurationDays: 1,
    maxParticipants: 4,
    isPublic: true,
    status: "ACTIVE",
    startedAt: new Date(now.getTime() - 60 * 60 * 1000),
    endsAt: new Date(now.getTime() + 23 * 60 * 60 * 1000),
  } });
  await prisma.raceParticipant.create({ data: {
    raceId: race.id, userId: creator.id, status: "ACCEPTED",
    joinedAt: race.startedAt,
  } });
  const startsAt = new Date(now.getTime() - 3 * 60 * 1000);
  const event = await prisma.globalStepEvent.create({ data: {
    eventDay: "2098-08-21",
    scheduleMode: "LOCAL_ENTITLEMENTS",
    localStartMinute: 600,
    durationMinutes: 30,
    startsAt,
    endsAt: new Date(now.getTime() + 30 * 60 * 1000),
    multiplier: 2,
  } });
  await prisma.globalStepEventEntitlement.create({ data: {
    eventId: event.id,
    userId: joiner.id,
    timezone: "America/New_York",
    localDate: "2098-08-21",
    startsAt,
    endsAt: event.endsAt,
  } });

  const [, joinResponse] = await Promise.all([
    processDueEntitlementBoundaries({ now }),
    request(server.baseUrl, "POST", `/races/${race.id}/join`, { token }),
  ]);
  assert.equal(joinResponse.status, 201);
  assert.equal(await prisma.globalEventRaceImpact.count({ where: {
    eventId: event.id, raceId: race.id, userId: joiner.id,
  } }), 1);
  const entitlement = await prisma.globalStepEventEntitlement.findUnique({
    where: { eventId_userId: { eventId: event.id, userId: joiner.id } },
  });
  assert.notEqual(entitlement.startOutcome, "SKIPPED_STALE");
});

test("a boundary processed more than two minutes late still activates the live event and releases its notification", async () => {
  const { user } = await createTestUser({ globalEventTimezone: "UTC" });
  const now = new Date("2098-08-22T12:03:00.000Z");
  const startsAt = new Date("2098-08-22T12:00:00.000Z");
  const endsAt = new Date("2098-08-22T12:30:00.000Z");
  const race = await prisma.race.create({ data: {
    creatorId: user.id, name: "Late local boundary", targetSteps: 0,
    timeBased: true, maxDurationDays: 1, status: "ACTIVE",
    startedAt: new Date("2098-08-22T11:00:00.000Z"), endsAt: endsAt,
  } });
  await prisma.raceParticipant.create({ data: {
    raceId: race.id, userId: user.id, status: "ACCEPTED",
    joinedAt: race.startedAt,
  } });
  const event = await prisma.globalStepEvent.create({ data: {
    eventDay: "2098-08-22", scheduleMode: "LOCAL_ENTITLEMENTS",
    localStartMinute: 720, durationMinutes: 30,
    startsAt: new Date("2098-08-22T00:00:00.000Z"),
    endsAt: new Date("2098-08-23T00:00:00.000Z"), multiplier: 2,
  } });
  const entitlement = await prisma.globalStepEventEntitlement.create({ data: {
    eventId: event.id, userId: user.id, timezone: "UTC", localDate: "2098-08-22",
    startsAt, endsAt,
  } });
  const deliveryKey = `visible:GLOBAL_EVENT_STARTED:${user.id}:${event.id}`;
  await prisma.notificationSchedule.create({ data: {
    recipientUserId: user.id, type: "GLOBAL_EVENT_STARTED",
    title: "2x STEPS EVENT", body: "Double steps are LIVE.",
    payload: { type: "GLOBAL_EVENT_STARTED", route: "home", eventId: event.id },
    deliveryKey, availableAt: startsAt, expiresAt: endsAt,
    sourceRef: entitlement.id,
  } });

  await processDueEntitlementBoundaries({ prisma, now });

  const processed = await prisma.globalStepEventEntitlement.findUniqueOrThrow({
    where: { id: entitlement.id },
  });
  assert.equal(processed.startOutcome, "ACTIVATED_ON_TIME");
  assert.equal(await prisma.globalEventRaceImpact.count({
    where: { eventId: event.id, raceId: race.id, userId: user.id },
  }), 1);
  assert.equal(await prisma.inboxAlert.count({
    where: { userId: user.id, type: "GLOBAL_EVENT_STARTED" },
  }), 1);
  assert.equal((await prisma.notificationSchedule.findUniqueOrThrow({
    where: { recipientUserId_deliveryKey: { recipientUserId: user.id, deliveryKey } },
  })).status, "MATERIALIZED");
});

test("a boundary processed after the event window expires without activating or notifying", async () => {
  const { user } = await createTestUser({ globalEventTimezone: "UTC" });
  const now = new Date("2098-08-22T12:33:00.000Z");
  const startsAt = new Date("2098-08-22T12:00:00.000Z");
  const endsAt = new Date("2098-08-22T12:30:00.000Z");
  const race = await prisma.race.create({ data: {
    creatorId: user.id, name: "Expired local boundary", targetSteps: 0,
    timeBased: true, maxDurationDays: 1, status: "ACTIVE",
    startedAt: new Date("2098-08-22T11:00:00.000Z"), endsAt: now,
  } });
  await prisma.raceParticipant.create({ data: {
    raceId: race.id, userId: user.id, status: "ACCEPTED",
    joinedAt: race.startedAt,
  } });
  const event = await prisma.globalStepEvent.create({ data: {
    eventDay: "2098-08-22", scheduleMode: "LOCAL_ENTITLEMENTS",
    localStartMinute: 720, durationMinutes: 30,
    startsAt: new Date("2098-08-22T00:00:00.000Z"),
    endsAt: new Date("2098-08-23T00:00:00.000Z"), multiplier: 2,
  } });
  const entitlement = await prisma.globalStepEventEntitlement.create({ data: {
    eventId: event.id, userId: user.id, timezone: "UTC", localDate: "2098-08-22",
    startsAt, endsAt,
  } });
  const deliveryKey = `visible:GLOBAL_EVENT_STARTED:${user.id}:${event.id}`;
  await prisma.notificationSchedule.create({ data: {
    recipientUserId: user.id, type: "GLOBAL_EVENT_STARTED",
    title: "2x STEPS EVENT", body: "Double steps are LIVE.",
    payload: { type: "GLOBAL_EVENT_STARTED", route: "home", eventId: event.id },
    deliveryKey, availableAt: startsAt, expiresAt: endsAt,
    sourceRef: entitlement.id,
  } });

  await processDueEntitlementBoundaries({ prisma, now });

  const processed = await prisma.globalStepEventEntitlement.findUniqueOrThrow({
    where: { id: entitlement.id },
  });
  assert.equal(processed.startOutcome, "SKIPPED_STALE");
  assert.equal(await prisma.globalEventRaceImpact.count({
    where: { eventId: event.id, raceId: race.id, userId: user.id },
  }), 0);
  assert.equal(await prisma.inboxAlert.count({
    where: { userId: user.id, type: "GLOBAL_EVENT_STARTED" },
  }), 0);
  assert.equal((await prisma.notificationSchedule.findUniqueOrThrow({
    where: { recipientUserId_deliveryKey: { recipientUserId: user.id, deliveryKey } },
  })).status, "EXPIRED");
});

test("Redis-down cold HTTP progress uses participant-specific PostgreSQL local events", async () => {
  const [{ user: ny, token: nyToken }, { user: madrid, token: madridToken }] =
    await Promise.all([createTestUser(), createTestUser()]);
  const now = new Date();
  const race = await prisma.race.create({ data: {
    creatorId: ny.id,
    name: "Redis-down two-zone progress",
    targetSteps: 0,
    timeBased: true,
    maxDurationDays: 1,
    status: "ACTIVE",
    startedAt: new Date(now.getTime() - 60 * 60 * 1000),
    endsAt: new Date(now.getTime() + 23 * 60 * 60 * 1000),
  } });
  await prisma.raceParticipant.createMany({ data: [
    { raceId: race.id, userId: ny.id, status: "ACCEPTED", joinedAt: race.startedAt,
      totalSteps: 222 },
    { raceId: race.id, userId: madrid.id, status: "ACCEPTED", joinedAt: race.startedAt,
      totalSteps: 111 },
  ] });
  const event = await prisma.globalStepEvent.create({ data: {
    eventDay: "2098-08-22",
    scheduleMode: "LOCAL_ENTITLEMENTS",
    localStartMinute: 600,
    durationMinutes: 30,
    startsAt: new Date(now.getTime() - 12 * 60 * 60 * 1000),
    endsAt: new Date(now.getTime() + 12 * 60 * 60 * 1000),
    multiplier: 2,
  } });
  await prisma.globalStepEventEntitlement.createMany({ data: [
    { eventId: event.id, userId: ny.id, timezone: "America/New_York",
      localDate: "2098-08-22", startsAt: new Date(now.getTime() - 60 * 1000),
      endsAt: new Date(now.getTime() + 29 * 60 * 1000),
      startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: now },
    { eventId: event.id, userId: madrid.id, timezone: "Europe/Madrid",
      localDate: "2098-08-22", startsAt: new Date(now.getTime() + 5 * 60 * 60 * 1000),
      endsAt: new Date(now.getTime() + 5.5 * 60 * 60 * 1000) },
  ] });
  await prisma.globalEventRaceImpact.createMany({ data: [ny.id, madrid.id].map((userId) => ({
    eventId: event.id, raceId: race.id, userId, status: "PENDING",
  })) });

  const priorUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://127.0.0.1:1";
  await redisCache.close();
  await appSettings.setFlag("redisStandingsEnabled", true);
  try {
    const [nyResponse, madridResponse] = await Promise.all([
      request(server.baseUrl, "GET", `/races/${race.id}/progress`, { token: nyToken }),
      request(server.baseUrl, "GET", `/races/${race.id}/progress`, { token: madridToken }),
    ]);
    assert.equal(nyResponse.status, 200);
    assert.equal(madridResponse.status, 200);
    const nyProgress = (await nyResponse.json()).progress;
    const madridProgress = (await madridResponse.json()).progress;
    for (const progress of [nyProgress, madridProgress]) {
      assert.equal(progress.participants.find((row) => row.userId === ny.id).currentMultiplier, 2);
      assert.equal(progress.participants.find((row) => row.userId === madrid.id).currentMultiplier, 1);
    }
    assert.equal(nyProgress.globalEvent.multiplier, 2);
    assert.equal("globalEvent" in madridProgress, false);
  } finally {
    await appSettings.setFlag("redisStandingsEnabled", false);
    if (priorUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = priorUrl;
    await redisCache.close();
  }
});

test("seeded promotion enrolls accepted racers transactionally under the shared boundary lock", async () => {
  const { user } = await createTestUser({ globalEventTimezone: "UTC" });
  const now = new Date();
  await appSettings.setFlag("seededRaceBucketsEnabled", false);
  const seed = await prisma.raceSeed.findUnique({ where: { kind: "DAILY_10K" } });
  const race = await prisma.race.create({ data: {
    seedId: seed.id,
    creatorId: null,
    name: "Due seeded local enrollment",
    targetSteps: seed.targetSteps,
    status: "PENDING",
    isPublic: true,
    maxParticipants: 100,
    timeBased: true,
    timezone: "America/New_York",
    scheduledStartAt: new Date(now.getTime() - 30 * 1000),
    endsAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    maxDurationDays: 1,
  } });
  await prisma.raceParticipant.create({ data: {
    raceId: race.id, userId: user.id, status: "ACCEPTED", joinedAt: now,
  } });
  const event = await prisma.globalStepEvent.create({ data: {
    eventDay: "2098-09-01", scheduleMode: "LOCAL_ENTITLEMENTS",
    localStartMinute: 720, durationMinutes: 30, multiplier: 2,
    startsAt: new Date(now.getTime() - 13 * 60 * 60 * 1000),
    endsAt: new Date(now.getTime() + 13 * 60 * 60 * 1000),
  } });
  await prisma.globalStepEventEntitlement.create({ data: {
    eventId: event.id, userId: user.id, timezone: "UTC", localDate: "2098-09-01",
    startsAt: new Date(now.getTime() - 30 * 1000),
    endsAt: new Date(now.getTime() + 29 * 60 * 1000),
  } });

  const renew = buildRenewSeededRaces({
    prisma, now: () => now,
    logger: { log() {}, error(error) { throw error; } },
    enqueueRaceResolution: async () => ({ id: "test-enqueue" }),
  });
  await Promise.all([
    renew(),
    processDueEntitlementBoundaries({ now }),
  ]);

  assert.equal((await prisma.race.findUnique({ where: { id: race.id } })).status, "ACTIVE");
  assert.equal(await prisma.globalEventRaceImpact.count({ where: {
    eventId: event.id, raceId: race.id, userId: user.id,
  } }), 1);
});

test("HTTP tournament round creation enrolls each matchup participant in the active local event", async () => {
  await appSettings.setFlag("tournamentsEnabled", true);
  await appSettings.setFlag("fundedPrizePoolsEnabled", false);
  const accounts = await Promise.all(Array.from({ length: 4 }, (_, index) =>
    createTestUser({
      displayName: `Local bracket ${index}`,
      globalEventTimezone: "UTC",
      clientFeatures: ["tournaments"],
    })
  ));
  const now = new Date();
  const event = await prisma.globalStepEvent.create({ data: {
    eventDay: "2098-09-02", scheduleMode: "LOCAL_ENTITLEMENTS",
    localStartMinute: 720, durationMinutes: 30, multiplier: 2,
    startsAt: new Date(now.getTime() - 13 * 60 * 60 * 1000),
    endsAt: new Date(now.getTime() + 13 * 60 * 60 * 1000),
  } });
  await prisma.globalStepEventEntitlement.createMany({ data: accounts.map(({ user }) => ({
    eventId: event.id, userId: user.id, timezone: "UTC", localDate: "2098-09-02",
    startsAt: new Date(now.getTime() - 60 * 1000),
    endsAt: new Date(now.getTime() + 29 * 60 * 1000),
    startOutcome: "NO_ACTIVE_RACES", startProcessedAt: now,
  })) });
  const features = { "X-Client-Features": "tournaments" };
  const created = await request(server.baseUrl, "POST", "/tournaments", {
    token: accounts[0].token, headers: features,
    body: {
      name: "Local entitlement bracket", bracketSize: 4,
      matchupDurationDays: 2, buyInAmount: 0, isPublic: true,
    },
  });
  assert.equal(created.status, 201);
  const tournamentId = (await created.json()).tournament.id;
  for (const account of accounts.slice(1)) {
    const response = await request(server.baseUrl, "POST", `/tournaments/${tournamentId}/join`, {
      token: account.token, headers: features,
    });
    assert.equal(response.status, 201);
  }
  const races = await prisma.race.findMany({ where: { tournamentId, status: "ACTIVE" } });
  assert.equal(races.length, 2);
  assert.equal(await prisma.globalEventRaceImpact.count({ where: {
    eventId: event.id, raceId: { in: races.map((race) => race.id) },
  } }), 4);
});

test("durable exposure counts participant-race zero/one/two-plus opportunities with grouped rollout aggregates", async () => {
  const [{ user: zero }, { user: multiple }] = await Promise.all([
    createTestUser({ globalEventTimezone: "UTC" }),
    createTestUser({ globalEventTimezone: "Pacific/Kiritimati" }),
  ]);
  const now = new Date();
  const startedAt = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  const endsAt = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  const race = await prisma.race.create({ data: {
    creatorId: zero.id, name: "Exposure buckets", targetSteps: 0,
    timeBased: true, maxDurationDays: 1, status: "ACTIVE", startedAt, endsAt,
  } });
  await prisma.raceParticipant.createMany({ data: [zero.id, multiple.id].map((userId) => ({
    raceId: race.id, userId, status: "ACCEPTED", joinedAt: startedAt,
  })) });
  for (let index = 0; index < 2; index += 1) {
    const event = await prisma.globalStepEvent.create({ data: {
      eventDay: `2098-09-${10 + index}`, scheduleMode: "LOCAL_ENTITLEMENTS",
      localStartMinute: 720, durationMinutes: 30, multiplier: 2,
      startsAt: startedAt, endsAt,
    } });
    await prisma.globalStepEventEntitlement.create({ data: {
      eventId: event.id, userId: multiple.id, timezone: "Pacific/Kiritimati",
      localDate: `2098-09-${10 + index}`,
      startsAt: new Date(startedAt.getTime() + (index + 1) * 60 * 60 * 1000),
      endsAt: new Date(startedAt.getTime() + (index + 2) * 60 * 60 * 1000),
      startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: now,
    } });
  }

  const snapshot = await captureOperationalSnapshot({ client: prisma, now });
  assert.equal(snapshot.exposureZeroRaces, 1);
  assert.equal(snapshot.exposureOneRaces, 0);
  assert.equal(snapshot.exposureMultipleRaces, 1);
  assert.ok(Object.values(snapshot.exposureBuckets).some((bucket) => bucket.multiple === 1));
  assert.ok(snapshot.rolloutCounters);
  assert.ok(snapshot.entitlementsByOffset);
});

test("retention deletes complete 30-day lifecycle dependents but keeps active-race and unsettled-summary rows", async () => {
  const accounts = await Promise.all(Array.from({ length: 3 }, () => createTestUser()));
  const now = new Date();
  const oldStart = new Date(now.getTime() - 32 * 24 * 60 * 60 * 1000);
  const oldEnd = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
  const cases = ["deletable", "active", "unsettled"];
  const ids = {};
  for (let index = 0; index < cases.length; index += 1) {
    const kind = cases[index];
    const user = accounts[index].user;
    const race = await prisma.race.create({ data: {
      creatorId: user.id, name: `Retention ${kind}`, targetSteps: 0,
      timeBased: true, maxDurationDays: 1,
      status: kind === "active" ? "ACTIVE" : "COMPLETED",
      startedAt: oldStart,
      endsAt: kind === "active" ? new Date(now.getTime() + 60 * 60 * 1000) : oldEnd,
    } });
    const event = await prisma.globalStepEvent.create({ data: {
      eventDay: `2098-10-${10 + index}`, scheduleMode: "LOCAL_ENTITLEMENTS",
      localStartMinute: 720, durationMinutes: 30, multiplier: 2,
      startsAt: oldStart, endsAt: oldEnd,
    } });
    const entitlement = await prisma.globalStepEventEntitlement.create({ data: {
      eventId: event.id, userId: user.id, timezone: "UTC",
      localDate: `2098-10-${10 + index}`, startsAt: oldStart, endsAt: oldEnd,
      startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: oldStart,
      endProcessedAt: oldEnd,
    } });
    await prisma.globalEventRaceImpact.create({ data: {
      eventId: event.id, raceId: race.id, userId: user.id,
      status: "FINAL", deltaSteps: 10, settledAt: oldEnd,
    } });
    await prisma.globalEventUserSummary.create({ data: {
      eventId: event.id, userId: user.id, extraRaceSteps: 10, raceCount: 1,
      settledAt: kind === "unsettled" ? now : oldEnd,
      acknowledgedAt: kind === "deletable" ? now : null,
    } });
    ids[kind] = { entitlementId: entitlement.id, eventId: event.id, userId: user.id };
  }

  const result = await cleanupExpiredEntitlements({ client: prisma, now });
  assert.equal(result.deletedEntitlements, 1);
  assert.equal(result.blockedEntitlements, 2);
  assert.equal(await prisma.globalStepEventEntitlement.count({ where: { id: ids.deletable.entitlementId } }), 0);
  assert.equal(await prisma.globalEventRaceImpact.count({ where: {
    eventId: ids.deletable.eventId, userId: ids.deletable.userId,
  } }), 0);
  assert.equal(await prisma.globalEventUserSummary.count({ where: {
    eventId: ids.deletable.eventId, userId: ids.deletable.userId,
  } }), 0);
  assert.equal(await prisma.globalStepEventEntitlement.count({ where: {
    id: { in: [ids.active.entitlementId, ids.unsettled.entitlementId] },
  } }), 2);
});

test("HTTP live totals settle identically across two races and summarize only the locally eligible participant", async () => {
  const [{ user: eligible, token }, { user: ineligible }] = await Promise.all([
    createTestUser({ globalEventTimezone: "UTC" }), createTestUser(),
  ]);
  const now = new Date();
  const raceStart = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const raceEnd = new Date(now.getTime() - 30 * 60 * 1000);
  const eventStart = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const eventEnd = new Date(now.getTime() - 90 * 60 * 1000);
  const event = await prisma.globalStepEvent.create({ data: {
    eventDay: "2098-11-01", scheduleMode: "LOCAL_ENTITLEMENTS",
    localStartMinute: 720, durationMinutes: 30, multiplier: 2,
    startsAt: eventStart, endsAt: eventEnd,
  } });
  await prisma.globalStepEventEntitlement.create({ data: {
    eventId: event.id, userId: eligible.id, timezone: "UTC", localDate: "2098-11-01",
    startsAt: eventStart, endsAt: eventEnd,
    startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: eventStart,
    endProcessedAt: eventEnd,
  } });
  const races = [];
  for (let index = 0; index < 2; index += 1) {
    const race = await prisma.race.create({ data: {
      creatorId: eligible.id, name: `Settlement parity ${index}`, targetSteps: 0,
      timeBased: true, maxDurationDays: 1, status: "ACTIVE",
      startedAt: raceStart, endsAt: raceEnd,
    } });
    await prisma.raceParticipant.createMany({ data: [eligible.id, ineligible.id].map((userId) => ({
      raceId: race.id, userId, status: "ACCEPTED", joinedAt: raceStart,
    })) });
    await prisma.globalEventRaceImpact.create({ data: {
      eventId: event.id, raceId: race.id, userId: eligible.id, status: "PENDING",
    } });
    races.push(race);
  }
  await prisma.stepSample.createMany({ data: [eligible.id, ineligible.id].map((userId) => ({
    userId, periodStart: eventStart, periodEnd: eventEnd, steps: 100,
  })) });

  const live = await request(server.baseUrl, "GET", `/races/${races[0].id}/progress`, { token });
  assert.equal(live.status, 200);
  const liveParticipants = (await live.json()).progress.participants;
  const liveEligible = liveParticipants.find((row) => row.userId === eligible.id).totalSteps;
  const liveIneligible = liveParticipants.find((row) => row.userId === ineligible.id).totalSteps;
  assert.equal(liveEligible, 200);
  assert.equal(liveIneligible, 100);

  await resolveExpiredRaces();
  for (const race of races) {
    const participants = await prisma.raceParticipant.findMany({ where: { raceId: race.id } });
    assert.equal(participants.find((row) => row.userId === eligible.id).totalSteps, liveEligible);
    assert.equal(participants.find((row) => row.userId === ineligible.id).totalSteps, liveIneligible);
  }
  assert.equal(await prisma.globalEventRaceImpact.count({ where: {
    eventId: event.id, userId: eligible.id, status: "FINAL",
  } }), 2);
  assert.equal(await prisma.globalEventRaceImpact.count({ where: {
    eventId: event.id, userId: ineligible.id,
  } }), 0);
  assert.deepEqual(await buildGlobalEventSummaryTick({ prisma, now: () => now })(), { upserts: 1 });
  const summary = await prisma.globalEventUserSummary.findUnique({
    where: { eventId_userId: { eventId: event.id, userId: eligible.id } },
  });
  assert.equal(summary.raceCount, 2);
  assert.equal(summary.extraRaceSteps, 200);
  assert.equal(await prisma.globalEventUserSummary.count({ where: { userId: ineligible.id } }), 0);
});

test("active-impact capture stacks only the recipient's local entitlement through HTTP upload and worker", async () => {
  const [{ user: eligible, token: eligibleToken }, { user: ineligible, token: ineligibleToken }] =
    await Promise.all([createTestUser(), createTestUser()]);
  const now = new Date();
  const raceStart = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  const race = await prisma.race.create({ data: {
    creatorId: eligible.id, name: "Participant-specific active impact", targetSteps: 0,
    timeBased: true, maxDurationDays: 1, status: "ACTIVE", powerupsEnabled: true,
    startedAt: raceStart, endsAt: new Date(now.getTime() + 4 * 60 * 60 * 1000),
  } });
  const participants = await Promise.all([eligible.id, ineligible.id].map((userId) =>
    prisma.raceParticipant.create({ data: {
      raceId: race.id, userId, status: "ACCEPTED", joinedAt: raceStart,
    } })
  ));
  const eventStart = new Date(now.getTime() - 80 * 60 * 1000);
  const eventEnd = new Date(now.getTime() - 10 * 60 * 1000);
  const event = await prisma.globalStepEvent.create({ data: {
    eventDay: "2098-11-04", scheduleMode: "LOCAL_ENTITLEMENTS",
    localStartMinute: 720, durationMinutes: 30, multiplier: 2,
    startsAt: eventStart, endsAt: eventEnd,
  } });
  await prisma.globalStepEventEntitlement.create({ data: {
    eventId: event.id, userId: eligible.id, timezone: "UTC", localDate: "2098-11-04",
    startsAt: eventStart, endsAt: eventEnd,
    startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: eventStart,
    endProcessedAt: eventEnd,
  } });
  await prisma.globalEventRaceImpact.create({ data: {
    eventId: event.id, raceId: race.id, userId: eligible.id, status: "PENDING",
  } });
  const effectStart = new Date(now.getTime() - 70 * 60 * 1000);
  const effectEnd = new Date(now.getTime() - 20 * 60 * 1000);
  const sampleStart = new Date(now.getTime() - 60 * 60 * 1000);
  const sampleEnd = new Date(now.getTime() - 50 * 60 * 1000);
  await appSettings.setFlagsAtomically([
    ["apiImpactNoticesEnabled", true],
  ]);
  const effects = [];
  for (const participant of participants) {
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id, participantId: participant.id, userId: participant.userId,
      type: "RUNNERS_HIGH", rarity: "RARE", status: "USED", earnedAtSteps: 990001,
    } });
    effects.push(await prisma.raceActiveEffect.create({ data: {
      raceId: race.id, targetParticipantId: participant.id,
      targetUserId: participant.userId, sourceUserId: participant.userId,
      powerupId: powerup.id, type: "RUNNERS_HIGH", status: "ACTIVE",
      startsAt: effectStart, expiresAt: effectEnd, metadata: { multiplier: 2 },
    } }));
  }

  try {
    for (const [token, offset] of [[eligibleToken, 0], [ineligibleToken, 1]]) {
      const upload = await request(server.baseUrl, "POST", "/steps/samples", {
        token,
        body: { samples: [{
          periodStart: new Date(sampleStart.getTime() + offset).toISOString(),
          periodEnd: new Date(sampleEnd.getTime() + offset).toISOString(),
          steps: 1000,
        }] },
      });
      assert.equal(upload.status, 200);
    }
    // Exercise the production time-boundary scheduler. STEP_SYNC itself must
    // not probe v2 sources; placement recompute discovers the naturally due
    // effect and adds the EFFECT_BOUNDARY envelope consumed by the worker.
    await buildRecomputePlacements({
      requestStepSyncForUsers: async () => {},
      logger: { log() {}, warn() {}, error() {} },
    })();
    const scheduled = await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId: race.id },
    });
    assert.ok(
      scheduled.dirtyReasons.includes("EFFECT_BOUNDARY"),
      `expected a natural EFFECT_BOUNDARY envelope, got ${JSON.stringify(scheduled.dirtyReasons)}`,
    );
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error(error) { throw error; } },
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!(await worker.processOne())) break;
    }
    const impacts = await prisma.raceImpactEvent.findMany({
      where: { raceId: race.id }, orderBy: { recipientUserId: "asc" },
    });
    assert.equal(impacts.length, 2);
    const byUser = new Map(impacts.map((impact) => [impact.recipientUserId, impact]));
    assert.equal(byUser.get(eligible.id).sourceId, effects[0].id);
    // V2 owns only the effect's raw marginal: the overlapping local global
    // event is deliberately not reassigned to RUNNERS_HIGH.
    assert.equal(byUser.get(eligible.id).deltaSteps, 1000);
    assert.equal(byUser.get(ineligible.id).sourceId, effects[1].id);
    assert.equal(byUser.get(ineligible.id).deltaSteps, 1000);
    const stored = await prisma.raceParticipant.findMany({
      where: { raceId: race.id },
      orderBy: { userId: "asc" },
    });
    const totalByUser = new Map(stored.map((participant) => [
      participant.userId,
      participant.totalSteps,
    ]));
    // Authoritative totals retain participant-specific entitlement stacking:
    // eligible = raw 1000 + effect 1000 + separately owned global term 2000;
    // ineligible = raw 1000 + effect 1000.
    assert.equal(totalByUser.get(eligible.id), 4000);
    assert.equal(totalByUser.get(ineligible.id), 2000);
  } finally {
    await appSettings.setFlagsAtomically([
      ["apiImpactNoticesEnabled", false],
    ]);
  }
});

test("boundary transaction crash rolls back impact and outbox, then retry creates each exactly once", async () => {
  const { user } = await createTestUser({ globalEventTimezone: "UTC" });
  const now = new Date();
  const race = await prisma.race.create({ data: {
    creatorId: user.id, name: "Outbox retry", targetSteps: 0,
    timeBased: true, maxDurationDays: 1, status: "ACTIVE",
    startedAt: new Date(now.getTime() - 60 * 60 * 1000),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000),
  } });
  await prisma.raceParticipant.create({ data: {
    raceId: race.id, userId: user.id, status: "ACCEPTED",
    joinedAt: race.startedAt,
  } });
  const event = await prisma.globalStepEvent.create({ data: {
    eventDay: "2098-11-02", scheduleMode: "LOCAL_ENTITLEMENTS",
    localStartMinute: 720, durationMinutes: 30, multiplier: 2,
    startsAt: new Date(now.getTime() - 13 * 60 * 60 * 1000),
    endsAt: new Date(now.getTime() + 13 * 60 * 60 * 1000),
  } });
  const entitlement = await prisma.globalStepEventEntitlement.create({ data: {
    eventId: event.id, userId: user.id, timezone: "UTC", localDate: "2098-11-02",
    startsAt: new Date(now.getTime() - 30 * 1000),
    endsAt: new Date(now.getTime() + 29 * 60 * 1000),
  } });
  await assert.rejects(processDueEntitlementBoundaries({
    prisma, now,
    createInboxAlert: async (input) => {
      await createInboxAlert(input);
      throw new Error("injected crash after durable outbox write");
    },
  }), /injected crash/);
  assert.equal(await prisma.globalEventRaceImpact.count(), 0);
  assert.equal(await prisma.inboxAlert.count(), 0);
  assert.equal((await prisma.globalStepEventEntitlement.findUnique({ where: { id: entitlement.id } })).startProcessedAt, null);

  await processDueEntitlementBoundaries({ prisma, now });
  await processDueEntitlementBoundaries({ prisma, now });
  assert.equal(await prisma.globalEventRaceImpact.count(), 1);
  assert.equal(await prisma.inboxAlert.count({ where: { type: "GLOBAL_EVENT_STARTED" } }), 1);
  assert.equal(await prisma.inboxDeliveryOutbox.count(), 1);
});

test("HTTP step-sync dependency closure fails closed while that participant's local event is active", async () => {
  const { user, token } = await createTestUser();
  const now = new Date();
  const race = await prisma.race.create({ data: {
    creatorId: user.id, name: "Local closure boundary", targetSteps: 0,
    timeBased: true, maxDurationDays: 1, status: "ACTIVE", powerupsEnabled: true,
    startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
    endsAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
  } });
  const participant = await prisma.raceParticipant.create({ data: {
    raceId: race.id, userId: user.id, status: "ACCEPTED", joinedAt: race.startedAt,
  } });
  const event = await prisma.globalStepEvent.create({ data: {
    eventDay: "2098-11-06", scheduleMode: "LOCAL_ENTITLEMENTS",
    localStartMinute: 720, durationMinutes: 30, multiplier: 2,
    startsAt: new Date(now.getTime() - 60 * 60 * 1000),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000),
  } });
  await prisma.globalStepEventEntitlement.create({ data: {
    eventId: event.id, userId: user.id, timezone: "UTC", localDate: "2098-11-06",
    startsAt: event.startsAt, endsAt: event.endsAt,
    startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: event.startsAt,
  } });
  await prisma.globalEventRaceImpact.create({ data: {
    eventId: event.id, raceId: race.id, userId: user.id, status: "PENDING",
  } });
  const powerup = await prisma.racePowerup.create({ data: {
    raceId: race.id, participantId: participant.id, userId: user.id,
    type: "RUNNERS_HIGH", rarity: "RARE", status: "USED", earnedAtSteps: 990002,
  } });
  await prisma.raceActiveEffect.create({ data: {
    raceId: race.id, targetParticipantId: participant.id,
    targetUserId: user.id, sourceUserId: user.id, powerupId: powerup.id,
    type: "RUNNERS_HIGH", status: "ACTIVE",
    startsAt: new Date(now.getTime() - 30 * 60 * 1000),
    expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
    metadata: { multiplier: 2 },
  } });
  await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);
  try {
    const uploaded = await request(server.baseUrl, "POST", "/steps/samples", {
      token,
      body: { samples: [{
        periodStart: new Date(now.getTime() - 20 * 60 * 1000).toISOString(),
        periodEnd: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
        steps: 100,
      }] },
    });
    assert.equal(uploaded.status, 200);
    const events = [];
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: {
        log(line) { try { events.push(JSON.parse(line)); } catch {} },
        error(error) { throw error; },
      },
    });
    assert.ok(await worker.processOne());
    const committed = events.find((entry) => entry.event === "race_resolution_v2");
    assert.equal(committed?.resolutionPlan, "FULL", JSON.stringify(events));
    assert.equal(committed?.shadowClosurePlan, null, JSON.stringify(events));
    assert.equal(committed?.shadowClosureFallbackReason, null);
  } finally {
    await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", false);
  }
});

test("enabled dependency closure delivers a due legacy global-event boundary through the real cursor", async () => {
  const { user } = await createTestUser();
  const now = new Date("2026-08-20T18:00:00.000Z");
  const race = await prisma.race.create({ data: {
    creatorId: user.id,
    name: "Legacy boundary closure rollout",
    targetSteps: 0,
    timeBased: true,
    maxDurationDays: 1,
    status: "ACTIVE",
    startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
    endsAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
  } });
  await prisma.raceParticipant.create({ data: {
    raceId: race.id,
    userId: user.id,
    status: "ACCEPTED",
    joinedAt: race.startedAt,
  } });
  const event = await prisma.globalStepEvent.create({ data: {
    eventDay: "2026-08-20",
    scheduleMode: "LEGACY_GLOBAL",
    startsAt: new Date(now.getTime() - 30 * 60 * 1000),
    endsAt: new Date(now.getTime() + 30 * 60 * 1000),
    multiplier: 2,
  } });
  await prisma.globalStepEventBoundaryCursor.upsert({
    where: { key: "global" },
    update: {
      boundaryAt: new Date(0),
      eventId: "",
      boundaryKind: "",
      leaseToken: null,
      leaseExpiresAt: null,
    },
    create: {
      key: "global",
      boundaryAt: new Date(0),
      eventId: "",
      boundaryKind: "",
    },
  });
  const tick = buildMaybeStartGlobalEvent({
    now: () => now,
    localGlobalStepEventTick: async () => {},
  });
  await tick();

  const job = await prisma.raceResolutionJobV2.findUnique({
    where: { raceId: race.id },
  });
  assert.ok(job, "the boundary must durably enqueue every active race");
  const cursor = await prisma.globalStepEventBoundaryCursor.findUnique({
    where: { key: "global" },
  });
  assert.equal(cursor?.eventId, event.id);
  assert.equal(cursor?.boundaryKind, "START");
  assert.equal(cursor?.boundaryAt.toISOString(), event.startsAt.toISOString());
  assert.equal(cursor?.leaseToken, null);
});

test("enabled Home cache is user-isolated, invalidated at end, and progress does not reuse an active boundary", async () => {
  const [{ user: active, token: activeToken }, { user: inactive, token: inactiveToken }] =
    await Promise.all([createTestUser(), createTestUser()]);
  const now = new Date();
  const race = await prisma.race.create({ data: {
    creatorId: active.id, name: "Home local cache", targetSteps: 0,
    timeBased: true, maxDurationDays: 1, status: "ACTIVE",
    startedAt: new Date(now.getTime() - 60 * 60 * 1000),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000),
  } });
  await prisma.raceParticipant.createMany({ data: [active.id, inactive.id].map((userId) => ({
    raceId: race.id, userId, status: "ACCEPTED", joinedAt: race.startedAt,
  })) });
  const event = await prisma.globalStepEvent.create({ data: {
    eventDay: "2098-11-03", scheduleMode: "LOCAL_ENTITLEMENTS",
    localStartMinute: 720, durationMinutes: 30, multiplier: 2,
    startsAt: new Date(now.getTime() - 13 * 60 * 60 * 1000),
    endsAt: new Date(now.getTime() + 13 * 60 * 60 * 1000),
  } });
  const endsAt = new Date(Date.now() + 1200);
  await prisma.globalStepEventEntitlement.create({ data: {
    eventId: event.id, userId: active.id, timezone: "UTC", localDate: "2098-11-03",
    startsAt: new Date(now.getTime() - 60 * 1000), endsAt,
    startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: now,
  } });
  await prisma.globalEventRaceImpact.create({ data: {
    eventId: event.id, raceId: race.id, userId: active.id, status: "PENDING",
  } });
  const previousRedisUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://127.0.0.1:6379/15";
  await redisCache.close();
  derivedCache.reset();
  await appSettings.setFlag("redisCacheHomeActiveGlobalEventEnabled", true);
  try {
    const [activeHome, inactiveHome, activeProgress] = await Promise.all([
      request(server.baseUrl, "GET", "/home/race-card", { token: activeToken }),
      request(server.baseUrl, "GET", "/home/race-card", { token: inactiveToken }),
      request(server.baseUrl, "GET", `/races/${race.id}/progress`, { token: activeToken }),
    ]);
    assert.equal((await activeHome.json()).globalEvent.multiplier, 2);
    assert.equal("globalEvent" in await inactiveHome.json(), false);
    assert.equal((await activeProgress.json()).progress.participants
      .find((row) => row.userId === active.id).currentMultiplier, 2);
    assert.ok(await redisCache.getJSON(cacheKeys.homeActiveGlobalEvent(active.id)));

    await new Promise((resolve) => setTimeout(resolve, 1300));
    await processDueEntitlementBoundaries({ prisma, now: new Date() });
    assert.equal(await redisCache.getJSON(cacheKeys.homeActiveGlobalEvent(active.id)), null);
    const afterHome = await request(server.baseUrl, "GET", "/home/race-card", { token: activeToken });
    const afterProgress = await request(server.baseUrl, "GET", `/races/${race.id}/progress`, {
      token: activeToken,
    });
    assert.equal("globalEvent" in await afterHome.json(), false);
    const progress = (await afterProgress.json()).progress;
    assert.equal("globalEvent" in progress, false);
    assert.equal(progress.participants.find((row) => row.userId === active.id).currentMultiplier, 1);
  } finally {
    await appSettings.setFlag("redisCacheHomeActiveGlobalEventEnabled", false);
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
    await redisCache.close();
    derivedCache.reset();
  }
});

test("HTTP display artifact cannot cross a participant's local entitlement end fingerprint", async () => {
  const { user, token } = await createTestUser();
  const now = new Date();
  const race = await prisma.race.create({ data: {
    creatorId: user.id, name: "Local artifact boundary", targetSteps: 0,
    timeBased: true, maxDurationDays: 1, status: "ACTIVE",
    startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
    endsAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
  } });
  await prisma.raceParticipant.create({ data: {
    raceId: race.id, userId: user.id, status: "ACCEPTED", joinedAt: race.startedAt,
  } });
  const entitlementStart = new Date(now.getTime() - 60 * 60 * 1000);
  const entitlementEnd = new Date(Date.now() + 1800);
  const event = await prisma.globalStepEvent.create({ data: {
    eventDay: "2098-11-05", scheduleMode: "LOCAL_ENTITLEMENTS",
    localStartMinute: 720, durationMinutes: 30, multiplier: 2,
    startsAt: entitlementStart, endsAt: entitlementEnd,
  } });
  await prisma.globalStepEventEntitlement.create({ data: {
    eventId: event.id, userId: user.id, timezone: "UTC", localDate: "2098-11-05",
    startsAt: entitlementStart, endsAt: entitlementEnd,
    startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: entitlementStart,
  } });
  await prisma.globalEventRaceImpact.create({ data: {
    eventId: event.id, raceId: race.id, userId: user.id, status: "PENDING",
  } });

  const previousRedisUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://127.0.0.1:6379/15";
  await redisCache.close();
  derivedCache.reset();
  await appSettings.setFlagsAtomically([
    ["redisStandingsEnabled", true],
    ["raceResolutionDisplayArtifactReuseV1Enabled", true],
  ]);
  try {
    const uploaded = await request(server.baseUrl, "POST", "/steps/samples", {
      token,
      body: { samples: [{
        periodStart: new Date(now.getTime() - 50 * 60 * 1000).toISOString(),
        periodEnd: new Date(now.getTime() - 40 * 60 * 1000).toISOString(),
        steps: 100,
      }] },
    });
    assert.equal(uploaded.status, 200);
    const initialWorker = buildRaceResolutionWorkerV2({
      bootAt: 0, logger: { log() {}, error(error) { throw error; } },
    });
    assert.ok(await initialWorker.processOne());
    assert.equal((await prisma.raceParticipant.findFirst({ where: { raceId: race.id } })).totalSteps, 200);

    await redisCache.del(cacheKeys.raceProgress(race.id));
    const activeProgress = await request(server.baseUrl, "GET", `/races/${race.id}/progress`, {
      token,
    });
    assert.equal(activeProgress.status, 200);
    assert.equal((await activeProgress.json()).progress.participants[0].totalSteps, 200);
    const queuedWithArtifact = await prisma.raceResolutionJobV2.findUnique({
      where: { raceId: race.id },
    });
    assert.ok(queuedWithArtifact.displayArtifactId);
    assert.match(queuedWithArtifact.displayArtifactDigest, /^[a-f0-9]{64}$/);

    await new Promise((resolve) => setTimeout(
      resolve,
      Math.max(0, entitlementEnd.getTime() - Date.now() + 50),
    ));
    await processDueEntitlementBoundaries({ prisma, now: new Date() });
    const events = [];
    const boundaryWorker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: {
        log(line) { try { events.push(JSON.parse(line)); } catch {} },
        error(error) { throw error; },
      },
    });
    assert.ok(await boundaryWorker.processOne());
    const committed = events.find((entry) => entry.event === "race_resolution_v2");
    assert.equal(committed?.resolutionPlan, "FULL", JSON.stringify(events));
    assert.equal(committed?.artifactHit, false, JSON.stringify(events));
    assert.equal(
      (await prisma.raceParticipant.findFirst({ where: { raceId: race.id } })).totalSteps,
      200,
      "the historical in-window bonus remains earned after the live boundary",
    );
    const endedProgress = await request(server.baseUrl, "GET", `/races/${race.id}/progress`, {
      token,
    });
    const ended = (await endedProgress.json()).progress;
    assert.equal(ended.participants[0].currentMultiplier, 1);
    assert.equal("globalEvent" in ended, false);
  } finally {
    await appSettings.setFlagsAtomically([
      ["redisStandingsEnabled", false],
      ["raceResolutionDisplayArtifactReuseV1Enabled", false],
    ]);
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
    await redisCache.close();
    derivedCache.reset();
  }
});
