const assert = require("node:assert/strict");
const { beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  prisma,
  createTestUser,
} = require("../setup");
const {
  buildGlobalEventBoundaryStreamWorker,
} = require("../../../src/modules/steps/jobs/globalEventBoundaryStreamWorker");

function quietLogger() {
  return { log() {}, warn() {}, error() {} };
}

async function createActiveRace(userId, now) {
  const startedAt = new Date(now.getTime() - 60 * 60 * 1000);
  const race = await prisma.race.create({
    data: {
      creatorId: userId,
      name: "Global event crash recovery",
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

  await prisma.raceParticipant.create({
    data: {
      raceId: race.id,
      userId,
      status: "ACCEPTED",
      joinedAt: startedAt,
      totalSteps: 0,
      rawSteps: 0,
    },
  });

  return race;
}

async function createStartBoundaryFixture() {
  const now = new Date("2098-08-26T10:00:00.000Z");
  const { user } = await createTestUser({
    timezone: "UTC",
    globalEventTimezone: "UTC",
  });
  const race = await createActiveRace(user.id, now);

  const startsAt = new Date(now.getTime() - 60 * 1000);
  const endsAt = new Date(now.getTime() + 29 * 60 * 1000);
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
      startOutcome: "PENDING",
      scheduleRevision: 0,
    },
  });

  return {
    now,
    user,
    race,
    event,
    entitlement,
    message: {
      schemaVersion: 1,
      boundaryType: "START",
      entitlementId: entitlement.id,
      scheduleRevision: 0,
      scheduledAt: startsAt.toISOString(),
      enqueuedAt: now.toISOString(),
    },
  };
}

describe("global event boundary crash recovery", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("reconstructs START fanout when the worker crashes after the DB commit but before Redis fanout", async () => {
    const fixture = await createStartBoundaryFixture();
    const worker = buildGlobalEventBoundaryStreamWorker({
      prisma,
      now: () => fixture.now,
      logger: quietLogger(),
    });

    // First delivery: the authoritative DB transaction commits successfully.
    // Simulate the process dying immediately afterward by deliberately NOT
    // calling publishFanout and therefore never ACKing the boundary message.
    const firstAttempt = await worker.processStart(fixture.message);

    assert.deepEqual(firstAttempt.raceIds, [fixture.race.id]);
    assert.equal(firstAttempt.notify?.recipientUserId, fixture.user.id);

    const committed = await prisma.globalStepEventEntitlement.findUniqueOrThrow({
      where: { id: fixture.entitlement.id },
    });
    assert.equal(committed.startOutcome, "ACTIVATED_ON_TIME");
    assert.ok(committed.startProcessedAt);

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

    // Redis redelivers the same unacked boundary after the crash. Durable DB
    // state must be enough to reconstruct the exact downstream work that may
    // have been lost between COMMIT and XADD.
    const retry = await worker.processStart(fixture.message);

    assert.deepEqual(
      retry.raceIds,
      [fixture.race.id],
      "retry must reconstruct RACE_DIRTY fanout after a post-commit crash",
    );
    assert.equal(
      retry.userId,
      fixture.user.id,
      "retry must retain the entitlement owner for downstream fanout",
    );
    assert.equal(
      retry.notify?.recipientUserId,
      fixture.user.id,
      "retry must reconstruct GLOBAL_EVENT_STARTED notification work",
    );
    assert.equal(
      retry.notify?.entitlementId,
      fixture.entitlement.id,
      "retry must reconstruct notification source identity",
    );

    // Recovery must not create duplicate durable impact rows.
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
  });
});
