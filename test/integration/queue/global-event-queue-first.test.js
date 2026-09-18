const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { after, afterEach, before, beforeEach, describe, it } = require("node:test");
const IORedis = require("ioredis");

const {
  cleanDatabase,
  prisma,
  createTestUser,
} = require("../setup");
const {
  STREAMS,
  ensureGroup,
  readGroup,
  publish,
  streamName,
  close: closeQueueRedis,
} = require("../../../src/shared/queues/redisStreams");
const {
  materializeEntitlementsForActiveRacers,
} = require("../../../src/modules/steps/services/globalStepEventEntitlement");
const {
  localEventWindowForZone,
} = require("../../../src/modules/steps/globalStepEvent");
const {
  startTestRedis,
} = require("../redisTestServer");

const EVENT_BOUNDARY_STREAM = "queue:global-event-boundary:v1";
const EVENT_BOUNDARY_GROUP = "global-event-boundary-workers-v1";
const NOTIFICATION_STREAM = "queue:notification-delivery:v1";
const NOTIFICATION_GROUP = "notification-workers-v1";
const SCHEDULE_KEY_SUFFIX = "schedule:global-event-boundaries:v1";

let ownedRedis = null;
let redisUrl;
let inspector;
let originalRedisUrl;
let originalPrefix;
let testPrefix;

function quietLogger() {
  return { log() {}, warn() {}, error() {} };
}

function scheduleKey() {
  return `${process.env.CACHE_ENV_PREFIX || ""}${SCHEDULE_KEY_SUFFIX}`;
}

function decodeEntry([id, raw]) {
  const fields = {};
  for (let index = 0; index < raw.length; index += 2) {
    fields[raw[index]] = raw[index + 1];
  }
  return { id, fields };
}

async function rawStreamEntries(stream) {
  return (await inspector.xrange(streamName(stream), "-", "+")).map(decodeEntry);
}

async function deletePrefix(prefix) {
  if (!inspector || !prefix) return;
  let cursor = "0";
  do {
    const [next, keys] = await inspector.scan(
      cursor,
      "MATCH",
      `${prefix}*`,
      "COUNT",
      100,
    );
    cursor = next;
    if (keys.length) await inspector.del(...keys);
  } while (cursor !== "0");
}

async function createActiveRace(userId, now, name = "Global event queue integration") {
  const startedAt = new Date(now.getTime() - 60 * 60 * 1000);
  const race = await prisma.race.create({
    data: {
      creatorId: userId,
      name,
      targetSteps: 100000,
      status: "ACTIVE",
      isPublic: false,
      timeBased: true,
      maxDurationDays: 1,
      timezone: "UTC",
      powerupsEnabled: false,
      startedAt,
      endsAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    },
  });
  const participant = await prisma.raceParticipant.create({
    data: {
      raceId: race.id,
      userId,
      status: "ACCEPTED",
      joinedAt: startedAt,
      totalSteps: 0,
      rawSteps: 0,
    },
  });
  return { race, participant };
}

async function createEntitlementFixture({
  now = new Date("2098-08-26T10:00:00.000Z"),
  withRace = true,
  startProcessed = false,
  ended = false,
} = {}) {
  const { user } = await createTestUser({
    timezone: "UTC",
    globalEventTimezone: "UTC",
  });
  const raceFixture = withRace
    ? await createActiveRace(user.id, now)
    : null;
  const startsAt = new Date(now.getTime() - 60 * 1000);
  const endsAt = ended
    ? new Date(now.getTime() - 1000)
    : new Date(now.getTime() + 29 * 60 * 1000);
  const event = await prisma.globalStepEvent.create({
    data: {
      startsAt,
      endsAt,
      multiplier: 2,
      scheduleMode: "LOCAL_ENTITLEMENTS",
      eventDay: "2098-08-26",
      localStartMinute: 600,
      durationMinutes: 30,
      schedulePolicyVersion: 1,
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
      startOutcome: startProcessed ? "ACTIVATED_ON_TIME" : "PENDING",
      startProcessedAt: startProcessed ? startsAt : null,
      scheduleRevision: 0,
    },
  });
  if (startProcessed && raceFixture) {
    await prisma.globalEventRaceImpact.create({
      data: {
        eventId: event.id,
        raceId: raceFixture.race.id,
        userId: user.id,
      },
    });
  }
  return {
    now,
    user,
    event,
    entitlement,
    race: raceFixture?.race || null,
    participant: raceFixture?.participant || null,
  };
}

async function publishAndReadBoundary(fields) {
  await ensureGroup(EVENT_BOUNDARY_STREAM, EVENT_BOUNDARY_GROUP);
  await publish(EVENT_BOUNDARY_STREAM, fields);
  const entries = await readGroup({
    stream: EVENT_BOUNDARY_STREAM,
    group: EVENT_BOUNDARY_GROUP,
    consumer: "itest-global-event-boundary",
    count: 10,
    blockMs: 5,
  });
  assert.equal(entries.length, 1, "expected one boundary message");
  return entries[0];
}

async function publishAndReadNotification(fields) {
  await ensureGroup(NOTIFICATION_STREAM, NOTIFICATION_GROUP);
  await publish(NOTIFICATION_STREAM, fields);
  const entries = await readGroup({
    stream: NOTIFICATION_STREAM,
    group: NOTIFICATION_GROUP,
    consumer: "itest-notification-delivery",
    count: 10,
    blockMs: 5,
  });
  assert.equal(entries.length, 1, "expected one notification message");
  return entries[0];
}

function loadExpectedModule(path, exportName) {
  let loaded;
  try {
    loaded = require(path);
  } catch (error) {
    assert.fail(
      `Expected queue-first implementation module ${path} to exist: ${error.message}`,
    );
  }
  assert.equal(
    typeof loaded?.[exportName],
    "function",
    `Expected ${path} to export ${exportName}()`,
  );
  return loaded[exportName];
}

describe("queue-first global event core contracts", () => {
  before(async (t) => {
    originalRedisUrl = process.env.REDIS_URL;
    originalPrefix = process.env.CACHE_ENV_PREFIX;

    if (String(process.env.REDIS_URL || "").trim()) {
      redisUrl = process.env.REDIS_URL;
    } else {
      ownedRedis = await startTestRedis();
      if (!ownedRedis) {
        t.skip("real Redis/Valkey is unavailable");
        return;
      }
      redisUrl = ownedRedis.url;
    }

    inspector = new IORedis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    await inspector.connect();
  });

  beforeEach(async () => {
    if (!redisUrl) return;
    await closeQueueRedis();
    testPrefix = `${originalPrefix || "integration:"}global-event-queue:${crypto.randomUUID()}:`;
    process.env.REDIS_URL = redisUrl;
    process.env.CACHE_ENV_PREFIX = testPrefix;
    await cleanDatabase();
  });

  afterEach(async () => {
    if (!redisUrl) return;
    await closeQueueRedis();
    await deletePrefix(testPrefix);
    process.env.REDIS_URL = redisUrl;
    process.env.CACHE_ENV_PREFIX = originalPrefix || "";
  });

  after(async () => {
    await closeQueueRedis();
    if (inspector) await inspector.quit().catch(() => inspector.disconnect());
    if (ownedRedis) await ownedRedis.close();
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    if (originalPrefix === undefined) delete process.env.CACHE_ENV_PREFIX;
    else process.env.CACHE_ENV_PREFIX = originalPrefix;
  });

  it("materializing a future entitlement also schedules its START and END boundaries in Redis", async () => {
    const current = new Date("2098-08-25T10:00:00.000Z");
    const { user } = await createTestUser({
      timezone: "UTC",
      globalEventTimezone: "UTC",
    });
    await createActiveRace(user.id, current, "Future event schedule");

    const eventDay = "2098-08-27";
    const window = localEventWindowForZone({
      eventDay,
      localStartMinute: 600,
      durationMinutes: 30,
      timeZone: "UTC",
    });
    const event = await prisma.globalStepEvent.create({
      data: {
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        multiplier: 2,
        scheduleMode: "LOCAL_ENTITLEMENTS",
        eventDay,
        localStartMinute: 600,
        durationMinutes: 30,
        schedulePolicyVersion: 1,
      },
    });

    const created = await materializeEntitlementsForActiveRacers(event, {
      prisma,
      now: current,
      batchSize: 10,
      generationUsable: async () => false,
      recordCounters: async () => {},
    });
    assert.equal(created, 1);

    const entitlement = await prisma.globalStepEventEntitlement.findFirstOrThrow({
      where: { eventId: event.id, userId: user.id },
    });
    const scheduled = await inspector.zrange(scheduleKey(), 0, -1, "WITHSCORES");
    assert.deepEqual(
      scheduled.filter((_, index) => index % 2 === 0).sort(),
      [
        `END:${entitlement.id}:0`,
        `START:${entitlement.id}:0`,
      ].sort(),
    );
    assert.equal(
      Number(scheduled[scheduled.indexOf(`START:${entitlement.id}:0`) + 1]),
      entitlement.startsAt.getTime(),
    );
    assert.equal(
      Number(scheduled[scheduled.indexOf(`END:${entitlement.id}:0`) + 1]),
      entitlement.endsAt.getTime(),
    );
  });

  it("the Redis boundary scheduler publishes due work without polling Postgres for the event boundary", async () => {
    const now = new Date("2098-08-26T10:00:00.000Z");
    const fixture = await createEntitlementFixture({ now, withRace: true });

    await inspector.zadd(
      scheduleKey(),
      fixture.entitlement.startsAt.getTime(),
      `START:${fixture.entitlement.id}:0`,
      fixture.entitlement.endsAt.getTime(),
      `END:${fixture.entitlement.id}:0`,
    );

    const buildScheduler = loadExpectedModule(
      "../../../src/modules/steps/jobs/globalEventBoundaryStreamScheduler",
      "buildGlobalEventBoundaryStreamScheduler",
    );
    const scheduler = buildScheduler({
      now: () => now,
      logger: quietLogger(),
    });
    assert.equal(typeof scheduler.tick, "function");
    await scheduler.tick();

    const queued = await rawStreamEntries(EVENT_BOUNDARY_STREAM);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].fields.boundaryType, "START");
    assert.equal(queued[0].fields.entitlementId, fixture.entitlement.id);
    assert.equal(queued[0].fields.scheduleRevision, "0");

    const remaining = await inspector.zrange(scheduleKey(), 0, -1);
    assert.deepEqual(remaining, [`END:${fixture.entitlement.id}:0`]);
    await scheduler.stop?.();
  });

  it("a due START activates the entitlement, records its race impact, and fans out race plus notification work", async () => {
    const fixture = await createEntitlementFixture({ withRace: true });
    const entry = await publishAndReadBoundary({
      schemaVersion: 1,
      boundaryType: "START",
      entitlementId: fixture.entitlement.id,
      scheduleRevision: "0",
      scheduledAt: fixture.entitlement.startsAt.toISOString(),
      enqueuedAt: fixture.now.toISOString(),
    });

    const buildWorker = loadExpectedModule(
      "../../../src/modules/steps/jobs/globalEventBoundaryStreamWorker",
      "buildGlobalEventBoundaryStreamWorker",
    );
    const worker = buildWorker({
      now: () => fixture.now,
      logger: quietLogger(),
    });
    await worker.processEntry(entry);

    const updated = await prisma.globalStepEventEntitlement.findUniqueOrThrow({
      where: { id: fixture.entitlement.id },
    });
    assert.equal(updated.startOutcome, "ACTIVATED_ON_TIME");
    assert.ok(updated.startProcessedAt);

    assert.equal(
      await prisma.globalEventRaceImpact.count({
        where: {
          eventId: fixture.event.id,
          raceId: fixture.race.id,
          userId: fixture.user.id,
        },
      }),
      1,
    );

    const dirty = await rawStreamEntries(STREAMS.RACE_DIRTY);
    assert.equal(dirty.length, 1);
    assert.equal(dirty[0].fields.raceId, fixture.race.id);
    assert.equal(dirty[0].fields.reason, "GLOBAL_EVENT_BOUNDARY");

    const notifications = await rawStreamEntries(NOTIFICATION_STREAM);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].fields.recipientUserId, fixture.user.id);
    assert.equal(notifications[0].fields.type, "GLOBAL_EVENT_STARTED");
    assert.equal(notifications[0].fields.sourceId, fixture.entitlement.id);
  });

  it("a due START with no active race records NO_ACTIVE_RACES and does not fan out race or notification work", async () => {
    const fixture = await createEntitlementFixture({ withRace: false });
    const entry = await publishAndReadBoundary({
      schemaVersion: 1,
      boundaryType: "START",
      entitlementId: fixture.entitlement.id,
      scheduleRevision: "0",
      scheduledAt: fixture.entitlement.startsAt.toISOString(),
      enqueuedAt: fixture.now.toISOString(),
    });

    const buildWorker = loadExpectedModule(
      "../../../src/modules/steps/jobs/globalEventBoundaryStreamWorker",
      "buildGlobalEventBoundaryStreamWorker",
    );
    const worker = buildWorker({
      now: () => fixture.now,
      logger: quietLogger(),
    });
    await worker.processEntry(entry);

    const updated = await prisma.globalStepEventEntitlement.findUniqueOrThrow({
      where: { id: fixture.entitlement.id },
    });
    assert.equal(updated.startOutcome, "NO_ACTIVE_RACES");
    assert.ok(updated.startProcessedAt);
    assert.equal(
      await prisma.globalEventRaceImpact.count({
        where: { eventId: fixture.event.id, userId: fixture.user.id },
      }),
      0,
    );
    assert.equal((await rawStreamEntries(STREAMS.RACE_DIRTY)).length, 0);
    assert.equal((await rawStreamEntries(NOTIFICATION_STREAM)).length, 0);
  });

  it("replaying the same START boundary is idempotent", async () => {
    const fixture = await createEntitlementFixture({ withRace: true });
    const message = {
      schemaVersion: 1,
      boundaryType: "START",
      entitlementId: fixture.entitlement.id,
      scheduleRevision: "0",
      scheduledAt: fixture.entitlement.startsAt.toISOString(),
      enqueuedAt: fixture.now.toISOString(),
    };

    const buildWorker = loadExpectedModule(
      "../../../src/modules/steps/jobs/globalEventBoundaryStreamWorker",
      "buildGlobalEventBoundaryStreamWorker",
    );
    const worker = buildWorker({
      now: () => fixture.now,
      logger: quietLogger(),
    });

    await worker.processEntry(await publishAndReadBoundary(message));
    await worker.processEntry(await publishAndReadBoundary(message));

    assert.equal(
      await prisma.globalEventRaceImpact.count({
        where: {
          eventId: fixture.event.id,
          raceId: fixture.race.id,
          userId: fixture.user.id,
        },
      }),
      1,
    );
    assert.equal((await rawStreamEntries(STREAMS.RACE_DIRTY)).length, 1);
    assert.equal((await rawStreamEntries(NOTIFICATION_STREAM)).length, 1);
  });

  it("a due END marks the entitlement ended and dirties each affected race once", async () => {
    const fixture = await createEntitlementFixture({
      withRace: true,
      startProcessed: true,
      ended: true,
    });
    const entry = await publishAndReadBoundary({
      schemaVersion: 1,
      boundaryType: "END",
      entitlementId: fixture.entitlement.id,
      scheduleRevision: "0",
      scheduledAt: fixture.entitlement.endsAt.toISOString(),
      enqueuedAt: fixture.now.toISOString(),
    });

    const buildWorker = loadExpectedModule(
      "../../../src/modules/steps/jobs/globalEventBoundaryStreamWorker",
      "buildGlobalEventBoundaryStreamWorker",
    );
    const worker = buildWorker({
      now: () => fixture.now,
      logger: quietLogger(),
    });
    await worker.processEntry(entry);

    const updated = await prisma.globalStepEventEntitlement.findUniqueOrThrow({
      where: { id: fixture.entitlement.id },
    });
    assert.ok(updated.endProcessedAt);

    const dirty = await rawStreamEntries(STREAMS.RACE_DIRTY);
    assert.equal(dirty.length, 1);
    assert.equal(dirty[0].fields.raceId, fixture.race.id);
    assert.equal(dirty[0].fields.reason, "GLOBAL_EVENT_BOUNDARY");
  });

  it("the recovery hydrator restores missing Redis boundaries from authoritative Postgres state", async () => {
    const now = new Date("2098-08-26T09:00:00.000Z");
    const fixture = await createEntitlementFixture({
      now: new Date("2098-08-26T10:00:00.000Z"),
      withRace: true,
    });

    await inspector.del(scheduleKey());
    assert.equal(await inspector.zcard(scheduleKey()), 0);

    const hydrate = loadExpectedModule(
      "../../../src/modules/steps/jobs/globalEventRedisScheduleHydrator",
      "hydrateGlobalEventRedisSchedule",
    );
    await hydrate({
      prisma,
      now,
      horizonEnd: new Date("2098-08-29T09:00:00.000Z"),
      logger: quietLogger(),
    });

    const scheduled = await inspector.zrange(scheduleKey(), 0, -1);
    assert.deepEqual(
      scheduled.sort(),
      [
        `START:${fixture.entitlement.id}:0`,
        `END:${fixture.entitlement.id}:0`,
      ].sort(),
    );
  });

  it("GLOBAL_EVENT_STARTED notification work produces one provider send and one Inbox alert even if the queue message is replayed", async () => {
    const fixture = await createEntitlementFixture({
      withRace: true,
      startProcessed: true,
    });
    await prisma.deviceToken.create({
      data: {
        userId: fixture.user.id,
        token: "integration-apns-token",
        platform: "ios",
        status: "ACTIVE",
        lastRegisteredAt: fixture.now,
      },
    });

    const deliveryKey = `global-event-start:${fixture.entitlement.id}:0`;
    const message = {
      schemaVersion: 1,
      recipientUserId: fixture.user.id,
      type: "GLOBAL_EVENT_STARTED",
      deliveryKey,
      sourceType: "GLOBAL_STEP_EVENT_ENTITLEMENT",
      sourceId: fixture.entitlement.id,
      sourceRevision: "0",
      availableAt: fixture.entitlement.startsAt.toISOString(),
      expiresAt: fixture.entitlement.endsAt.toISOString(),
    };

    let sends = 0;
    const apnsService = {
      async sendNotification(input) {
        sends += 1;
        assert.equal(input.deviceToken, "integration-apns-token");
        return {
          success: true,
          unregistered: false,
          providerMessageId: `apns-${sends}`,
        };
      },
    };
    const fcmService = {
      async sendNotification() {
        assert.fail("iOS event notification must not route through FCM");
      },
    };

    const buildWorker = loadExpectedModule(
      "../../../src/modules/notifications/jobs/notificationDeliveryStreamWorker",
      "buildNotificationDeliveryStreamWorker",
    );
    const worker = buildWorker({
      now: () => fixture.now,
      apnsService,
      fcmService,
      logger: quietLogger(),
    });

    await worker.processEntry(await publishAndReadNotification(message));
    await worker.processEntry(await publishAndReadNotification(message));

    assert.equal(sends, 1);
    assert.equal(
      await prisma.inboxAlert.count({
        where: { userId: fixture.user.id, sourceKey: deliveryKey },
      }),
      1,
    );
  });
});
