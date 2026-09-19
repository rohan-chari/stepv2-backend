const assert = require("node:assert/strict");
const { beforeEach, describe, it } = require("node:test");
const { cleanDatabase, prisma, createTestUser } = require("../setup");
const {
  buildGlobalEventBoundaryStreamWorker,
} = require("../../../src/modules/steps/jobs/globalEventBoundaryStreamWorker");

const now = new Date("2098-09-19T12:00:00.000Z");

async function cohort(size = 5) {
  const users = [];
  for (let i = 0; i < size; i += 1) users.push((await createTestUser()).user);
  const startedAt = new Date(now.getTime() - 60 * 60_000);
  const race = await prisma.race.create({
    data: {
      creatorId: users[0].id, name: "Daily event batching", targetSteps: 100000,
      status: "ACTIVE", isPublic: false, timeBased: true, maxDurationDays: 1,
      timezone: "UTC", powerupsEnabled: false, startedAt,
      endsAt: new Date(now.getTime() + 24 * 60 * 60_000),
    },
  });
  await prisma.raceParticipant.createMany({
    data: users.map((user) => ({
      raceId: race.id, userId: user.id, status: "ACCEPTED", joinedAt: startedAt,
      totalSteps: 0, rawSteps: 0,
    })),
  });
  const event = await prisma.globalStepEvent.create({
    data: {
      eventDay: "2098-09-19", scheduleMode: "LOCAL_ENTITLEMENTS",
      localStartMinute: 720, durationMinutes: 30, multiplier: 2,
      startsAt: new Date(now.getTime() - 60_000),
      endsAt: new Date(now.getTime() + 29 * 60_000),
    },
  });
  await prisma.globalStepEventEntitlement.createMany({
    data: users.map((user) => ({
      eventId: event.id, userId: user.id, timezone: "UTC", localDate: "2098-09-19",
      startsAt: event.startsAt, endsAt: event.endsAt, scheduleRevision: 0,
    })),
  });
  const entitlements = await prisma.globalStepEventEntitlement.findMany({
    where: { eventId: event.id }, orderBy: { id: "asc" },
  });
  return { users, race, event, entitlements };
}

function entriesFor(entitlements, boundaryType) {
  return entitlements.map((row, index) => ({
    id: `${boundaryType === "START" ? 1 : 2}-${index}`,
    fields: {
      schemaVersion: "1", boundaryType, entitlementId: row.id, scheduleRevision: "0",
      scheduledAt: (boundaryType === "START" ? row.startsAt : row.endsAt).toISOString(),
      enqueuedAt: now.toISOString(),
    },
  }));
}

function harness() {
  const messages = [];
  const receipts = new Map();
  const acknowledged = [];
  const invalidations = [];
  let transactions = 0;
  let current = now;
  let failNotification = false;
  const countedPrisma = new Proxy(prisma, {
    get(target, key) {
      if (key === "$transaction") return (...args) => {
        transactions += 1;
        return target.$transaction(...args);
      };
      return Reflect.get(target, key);
    },
  });
  const queue = {
    STREAMS: { GLOBAL_EVENT_BOUNDARY: "boundary", RACE_DIRTY: "race", NOTIFICATION_DELIVERY: "notification" },
    GROUPS: { GLOBAL_EVENT_BOUNDARY: "boundary-workers" },
    async publish(stream, fields) {
      if (stream === "notification" && failNotification) throw new Error("temporary publish failure");
      messages.push({ stream, fields });
    },
    async ack(_stream, _group, id) { acknowledged.push(id); },
    async withCommandClient(fn) {
      return fn({
        async mget(...keys) { return keys.map((key) => receipts.get(key) || null); },
        async set(key, value) { receipts.set(key, value); },
      });
    },
  };
  const worker = buildGlobalEventBoundaryStreamWorker({
    prisma: countedPrisma, queue, now: () => current,
    invalidateHomeActiveGlobalEvent: async (ids) => invalidations.push(ids),
    logger: { log() {}, warn() {}, error() {} },
  });
  return {
    worker, messages, acknowledged, invalidations,
    transactionCount: () => transactions,
    setNow(value) { current = value; },
    failNotification(value) { failNotification = value; },
  };
}

describe("daily event stream batches", () => {
  beforeEach(cleanDatabase);

  it("processes shared-race START and END cohorts in one transaction per boundary", async () => {
    const fixture = await cohort();
    const h = harness();
    const starts = entriesFor(fixture.entitlements, "START");
    assert.equal(await h.worker.processEntries(starts), 5);
    assert.equal(h.transactionCount(), 1);
    assert.equal(await prisma.globalEventRaceImpact.count({ where: { eventId: fixture.event.id } }), 5);
    const job = await prisma.raceResolutionJobV2.findUniqueOrThrow({ where: { raceId: fixture.race.id } });
    assert.deepEqual([...job.triggeredByUserIds].sort(), fixture.users.map((u) => u.id).sort());
    assert.ok(job.dirtyReasons.includes("GLOBAL_EVENT_BOUNDARY"));
    assert.equal(h.messages.filter((m) => m.stream === "race").length, 1);
    assert.ok(Number(h.messages.find((m) => m.stream === "race").fields.jobGeneration) > 0);
    assert.equal(h.messages.filter((m) => m.stream === "notification").length, 5);
    assert.equal(h.invalidations.length, 1);
    assert.equal(h.invalidations[0].length, 5);

    h.setNow(new Date(fixture.event.endsAt.getTime() + 1));
    assert.equal(await h.worker.processEntries(entriesFor(fixture.entitlements, "END")), 5);
    assert.equal(h.transactionCount(), 2);
    assert.equal(await prisma.globalStepEventEntitlement.count({
      where: { eventId: fixture.event.id, endProcessedAt: { not: null } },
    }), 5);
    assert.equal(h.messages.filter((m) => m.stream === "race").length, 2);
    assert.equal(h.messages.filter((m) => m.stream === "notification").length, 5);
    assert.equal(h.acknowledged.length, 10);
  });

  it("reconstructs the cohort after a post-commit fanout failure and receipts suppress completed replay", async () => {
    const fixture = await cohort(3);
    const h = harness();
    const starts = entriesFor(fixture.entitlements, "START");
    h.failNotification(true);
    assert.equal(await h.worker.processEntries(starts), 0);
    assert.equal(h.acknowledged.length, 0);
    assert.equal(await prisma.globalEventRaceImpact.count({ where: { eventId: fixture.event.id } }), 3);

    h.failNotification(false);
    assert.equal(await h.worker.processEntries(starts), 3);
    assert.equal(await prisma.globalEventRaceImpact.count({ where: { eventId: fixture.event.id } }), 3);
    assert.equal(h.messages.filter((m) => m.stream === "notification").length, 3);
    const published = h.messages.length;
    const transactions = h.transactionCount();
    assert.equal(await h.worker.processEntries(starts), 3);
    assert.equal(h.messages.length, published);
    assert.equal(h.transactionCount(), transactions);
  });
});
