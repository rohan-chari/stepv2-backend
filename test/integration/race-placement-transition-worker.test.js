const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");

const {
  cleanDatabase, prisma, createTestUser, request, getSharedServer,
} = require("./setup");
const {
  RacePlacementTransitionJob,
} = require("../../src/modules/races/models/racePlacementTransitionJob");
const {
  RaceResolutionJobV2,
} = require("../../src/modules/races/models/raceResolutionJobV2");
const {
  buildRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const {
  buildRacePlacementTransitionWorker,
} = require("../../src/modules/races/jobs/racePlacementTransitionWorker");
const {
  buildRecomputePlacements,
} = require("../../src/modules/races/jobs/placementRecompute");
const { appendDomainEvent } = require("../../src/modules/domainEvents");
const {
  buildNotificationProjector,
} = require("../../src/modules/domainEvents/services/notificationProjector");
const { appSettings } = require("../../src/shared/config/appSettings");
const { runInPrismaTransaction } = require("../../src/db");

let server;

before(async () => {
  server = await getSharedServer();
});

async function createActiveRace(participantCount, {
  isTeamRace = false,
  baselines = null,
} = {}) {
  const users = [];
  for (let index = 0; index < participantCount; index += 1) {
    users.push((await createTestUser({
      appleId: `placement-worker-${participantCount}-${index}-${Date.now()}`,
    })).user);
  }
  const race = await prisma.race.create({
    data: {
      creatorId: users[0].id,
      name: `Placement worker ${participantCount}`,
      targetSteps: 1_000_000,
      status: "ACTIVE",
      startedAt: new Date("2026-08-27T00:00:00.000Z"),
      endsAt: new Date("2026-09-03T00:00:00.000Z"),
      timezone: "UTC",
      isTeamRace,
      ...(isTeamRace ? {
        teamSize: Math.ceil(participantCount / 2),
        teamAName: "A",
        teamBName: "B",
        maxParticipants: participantCount,
      } : {}),
    },
  });
  await prisma.raceParticipant.createMany({
    data: users.map((user, index) => ({
      raceId: race.id,
      userId: user.id,
      status: "ACCEPTED",
      totalSteps: participantCount - index,
      joinedAt: new Date(Date.parse("2026-08-27T00:00:00.000Z") + index),
      lastNotifiedPlacement: baselines ? baselines(index) : index + 2,
      ...(isTeamRace ? { team: index % 2 === 0 ? "TEAM_A" : "TEAM_B" } : {}),
    })),
  });
  await prisma.raceResolutionJobV2.create({
    data: {
      raceId: race.id,
      generation: 1,
      processingGeneration: 1,
      state: "SUCCEEDED",
      requestedAt: new Date("2026-08-27T12:00:00.000Z"),
      completedAt: new Date("2026-08-27T12:00:00.000Z"),
      lastCompletedAt: new Date("2026-08-27T12:00:00.000Z"),
    },
  });
  return { race, users };
}

function buildLegacyProductionRecompute({ now, afterDurableEventAppend } = {}) {
  return buildRecomputePlacements({
    prisma,
    durableEvents: true,
    produceScoreDrivenPlacements: true,
    withDomainTransaction: runInPrismaTransaction,
    afterDurableEventAppend,
    RaceActiveEffect: { async findDueRaceIds() { return []; } },
    RaceResolutionJobV2: { async findRecoveryRaceIds() { return []; } },
    Notification: { async findExistingByUserTypeRaceKeys() { return []; } },
    requestStepSyncForUsers: async () => {},
    enqueueRaceResolution: async () => false,
    eventBus: { async emit() {} },
    now: now || (() => new Date()),
    logger: { log() {}, warn() {}, error() {} },
    getPerformanceFlags: () => ({
      placementDistributedClaimEnabled: false,
      placementLeanBaselineWritesEnabled: true,
      placementInertPushSuppressionEnabled: false,
    }),
  });
}

describe("durable race placement transition worker", () => {
  beforeEach(cleanDatabase);

  it("coalesces generations and does not move the observation time on replay", async () => {
    const { race } = await createActiveRace(2);
    const firstAt = new Date("2026-08-27T12:00:00.000Z");
    const later = new Date("2026-08-27T12:00:10.000Z");
    await RacePlacementTransitionJob.enqueueCurrentGeneration({
      raceId: race.id, generation: 1, observedAt: firstAt, now: firstAt,
    });
    await RacePlacementTransitionJob.enqueueCurrentGeneration({
      raceId: race.id, generation: 1, observedAt: later, now: later,
    });
    const replayed = await prisma.racePlacementTransitionJob.findUnique({
      where: { raceId: race.id },
    });
    assert.equal(replayed.requestedGeneration, 1);
    assert.equal(replayed.observedAt.toISOString(), firstAt.toISOString());

    await RacePlacementTransitionJob.enqueueCurrentGeneration({
      raceId: race.id, generation: 2, observedAt: later, now: later,
    });
    const advanced = await prisma.racePlacementTransitionJob.findUnique({
      where: { raceId: race.id },
    });
    assert.equal(advanced.requestedGeneration, 2);
    assert.equal(advanced.observedAt.toISOString(), later.toISOString());
  });

  it("repairs missing handoffs, pages catch-up, and promotes generation zero through real resolution", async () => {
    const first = await createActiveRace(2);
    const second = await createActiveRace(1);
    const missing = await RacePlacementTransitionJob.findMissingHandoffRaceIds({
      raceIds: [first.race.id, second.race.id], limit: 100,
    });
    assert.deepEqual(missing, [first.race.id, second.race.id].sort());
    assert.deepEqual(await RacePlacementTransitionJob.recoverSucceededGenerations({
      raceIds: [first.race.id], now: new Date(Date.now() - 2_000),
    }), { placementJobs: 1, resolutionJobs: 0 });
    assert.equal(await prisma.racePlacementTransitionJob.count(), 1);
    const catchup = await RacePlacementTransitionJob.catchUpActiveSucceededPage({
      limit: 1, now: new Date(Date.now() - 2_000),
    });
    assert.equal(catchup.count, 1);
    assert.equal(await prisma.racePlacementTransitionJob.count(), 2);

    await prisma.racePlacementTransitionJob.deleteMany({ where: { raceId: second.race.id } });
    await prisma.raceResolutionJobV2.delete({ where: { raceId: second.race.id } });
    await prisma.$transaction((tx) => RaceResolutionJobV2.acquireForWrite(tx, {
      raceId: second.race.id,
    }));
    const zero = await prisma.raceResolutionJobV2.findUnique({
      where: { raceId: second.race.id },
    });
    assert.equal(zero.generation, 0);
    assert.deepEqual(await RacePlacementTransitionJob.recoverSucceededGenerations({
      raceIds: [second.race.id], now: new Date(),
    }), { placementJobs: 0, resolutionJobs: 1 });
    assert.equal(await prisma.racePlacementTransitionJob.count({
      where: { raceId: second.race.id },
    }), 0);
    assert.deepEqual(await RaceResolutionJobV2.findRecoveryRaceIds({
      raceIds: [second.race.id], limit: 2, now: new Date(),
    }), [second.race.id]);

    await RaceResolutionJobV2.enqueue({
      raceId: second.race.id,
      dirtyEnvelope: {
        reason: "FULL", dirtyUserIds: [], dirtyParticipantIds: [],
        powerupTypes: [], priority: "IMMEDIATE",
      },
      bypassDebounce: true,
      now: new Date(),
    });
    assert.ok(await buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, warn() {}, error() {} },
    }).processOne());
    const real = await prisma.raceResolutionJobV2.findUnique({
      where: { raceId: second.race.id },
    });
    assert.ok(real.generation > 0);
    assert.equal(real.state, "SUCCEEDED");
    assert.equal((await prisma.racePlacementTransitionJob.findUnique({
      where: { raceId: second.race.id },
    })).requestedGeneration, real.generation);
  });

  it("an expired placement lease cannot write and the reclaimed lease commits once", async () => {
    const { race } = await createActiveRace(2);
    const requestedAt = new Date(Date.now() - 2_000);
    await RacePlacementTransitionJob.enqueueCurrentGeneration({
      raceId: race.id,
      generation: 1,
      observedAt: requestedAt,
      now: requestedAt,
    });
    const expiredOwner = buildRacePlacementTransitionWorker({
      now: () => new Date(),
      logger: { log() {}, warn() {}, error() {} },
      async beforePersist({ job }) {
        await prisma.$executeRawUnsafe(
          `UPDATE race_placement_transition_jobs
              SET lease_expires_at=clock_timestamp() - interval '1 second'
            WHERE id=$1::uuid`,
          job.id,
        );
        const [lease] = await prisma.$queryRawUnsafe(
          `SELECT lease_expires_at <= clock_timestamp() AS expired
             FROM race_placement_transition_jobs WHERE id=$1::uuid`,
          job.id,
        );
        assert.ok(lease.expired, `expected expired DB lease, got ${JSON.stringify(lease)}`);
      },
    });
    const expiredResult = await expiredOwner.processOne();
    assert.equal(expiredResult.error?.code, "LEASE_LOST");
    assert.deepEqual((await prisma.raceParticipant.findMany({
      where: { raceId: race.id },
      orderBy: { totalSteps: "desc" },
    })).map((row) => row.lastNotifiedPlacement), [2, 3]);
    assert.equal(await prisma.domainEventOutbox.count({
      where: { aggregateId: race.id },
    }), 0);
    assert.equal((await prisma.racePlacementTransitionJob.findUnique({
      where: { raceId: race.id },
    })).state, "RUNNING");

    const reclaimed = await buildRacePlacementTransitionWorker({
      now: () => new Date(),
    }).processOne();
    assert.equal(reclaimed.metrics.placementOutcome, "committed");
    assert.equal(await prisma.domainEventOutbox.count({
      where: { aggregateId: race.id },
    }), 2);
  });

  it("completes a placement handoff silently when the race becomes terminal before claim", async () => {
    const { race } = await createActiveRace(2);
    const requestedAt = new Date(Date.now() - 2_000);
    await RacePlacementTransitionJob.enqueueCurrentGeneration({
      raceId: race.id,
      generation: 1,
      observedAt: requestedAt,
      now: requestedAt,
    });
    await prisma.race.update({
      where: { id: race.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    const result = await buildRacePlacementTransitionWorker({
      now: () => new Date(),
    }).processOne();
    assert.equal(result.metrics.placementOutcome, "terminal_skip");
    assert.equal(await prisma.domainEventOutbox.count({
      where: { aggregateId: race.id },
    }), 0);
    assert.deepEqual((await prisma.raceParticipant.findMany({
      where: { raceId: race.id },
      orderBy: { totalSteps: "desc" },
    })).map((row) => row.lastNotifiedPlacement), [2, 3]);
    const completed = await prisma.racePlacementTransitionJob.findUnique({
      where: { raceId: race.id },
    });
    assert.equal(completed.state, "SUCCEEDED");
    assert.equal(completed.completedGeneration, 1);
    assert.equal(await buildRacePlacementTransitionWorker({
      now: () => new Date(Date.now() + 60_000),
    }).processOne(), null);
  });

  it("retries an active race whose accepted roster is transiently incomplete", async () => {
    const { race } = await createActiveRace(1);
    await prisma.raceParticipant.deleteMany({ where: { raceId: race.id } });
    const requestedAt = new Date(Date.now() - 2_000);
    await RacePlacementTransitionJob.enqueueCurrentGeneration({
      raceId: race.id,
      generation: 1,
      observedAt: requestedAt,
      now: requestedAt,
    });

    const result = await buildRacePlacementTransitionWorker({
      now: () => new Date(),
      logger: { log() {}, warn() {}, error() {} },
    }).processOne();
    assert.equal(result.metrics.placementOutcome, "incomplete_roster_retry");
    assert.equal(await prisma.domainEventOutbox.count({
      where: { aggregateId: race.id },
    }), 0);
    const retry = await prisma.racePlacementTransitionJob.findUnique({
      where: { raceId: race.id },
    });
    assert.equal(retry.state, "RETRY");
    assert.equal(retry.lastErrorCode, "INCOMPLETE_ROSTER");
  });

  it("atomically advances baselines and appends deterministic events", async () => {
    const { race } = await createActiveRace(3);
    const at = new Date("2026-08-27T12:00:00.000Z");
    await RacePlacementTransitionJob.enqueueCurrentGeneration({
      raceId: race.id, generation: 1, observedAt: at, now: at,
    });
    const worker = buildRacePlacementTransitionWorker({ now: () => new Date(at.getTime() + 2000) });
    assert.ok(await worker.processOne());

    const participants = await prisma.raceParticipant.findMany({
      where: { raceId: race.id }, orderBy: { totalSteps: "desc" },
    });
    assert.deepEqual(participants.map((row) => row.lastNotifiedPlacement), [1, 2, 3]);
    assert.deepEqual(participants.map((row) => row.totalSteps), [3, 2, 1]);
    assert.equal(await prisma.domainEventOutbox.count({
      where: { eventType: "PLACEMENT_CHANGED_V1", aggregateId: race.id },
    }), 3);
    assert.equal(await prisma.domainEventAudience.count(), 3);
    assert.equal((await prisma.racePlacementTransitionJob.findUnique({
      where: { raceId: race.id },
    })).state, "SUCCEEDED");

    assert.equal(await worker.processOne(), null);
    assert.equal(await prisma.domainEventOutbox.count({ where: { aggregateId: race.id } }), 3);
  });

  it("proves the old production transaction rolls back team baselines, claim, and event together", async () => {
    const { race } = await createActiveRace(4, { isTeamRace: true });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id, team: "TEAM_A" },
      data: { lastNotifiedPlacement: 2 },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id, team: "TEAM_B" },
      data: { lastNotifiedPlacement: 1 },
    });
    let reachedAppend = false;
    await buildLegacyProductionRecompute({
      now: () => new Date("2026-08-27T12:05:00.000Z"),
      async afterDurableEventAppend({ eventName }) {
        if (eventName === "TEAM_LEAD_CHANGED") {
          reachedAppend = true;
          throw new Error("old production process crashed before outer commit");
        }
      },
    })();

    assert.equal(reachedAppend, true, "failure must occur after the durable append statement");
    const participants = await prisma.raceParticipant.findMany({
      where: { raceId: race.id },
    });
    assert.ok(participants.filter((row) => row.team === "TEAM_A")
      .every((row) => row.lastNotifiedPlacement === 2));
    assert.ok(participants.filter((row) => row.team === "TEAM_B")
      .every((row) => row.lastNotifiedPlacement === 1));
    assert.equal(await prisma.jobRun.count({
      where: { jobName: `team-lead:${race.id}` },
    }), 0);
    assert.equal(await prisma.domainEventOutbox.count({
      where: { aggregateId: race.id, eventType: "TEAM_LEAD_CHANGED_V1" },
    }), 0);
  });

  it("dedupes concurrent old and new individual producers through baseline CAS", async () => {
    const { race } = await createActiveRace(2);
    const observedAt = new Date("2026-08-27T12:00:00.000Z");
    await RacePlacementTransitionJob.enqueueCurrentGeneration({
      raceId: race.id,
      generation: 1,
      observedAt,
      now: observedAt,
    });

    let releaseNew;
    let newPlanned;
    const planned = new Promise((resolve) => { newPlanned = resolve; });
    const release = new Promise((resolve) => { releaseNew = resolve; });
    const newRun = buildRacePlacementTransitionWorker({
      now: () => new Date(observedAt.getTime() + 10_000),
      logger: { log() {}, warn() {}, error() {} },
      async beforePersist() {
        newPlanned();
        await release;
      },
    }).processOne();
    await planned;

    await buildLegacyProductionRecompute({
      now: () => new Date(observedAt.getTime() + 5 * 60 * 1000),
    })();
    assert.equal(await prisma.domainEventOutbox.count({
      where: { aggregateId: race.id, eventType: "PLACEMENT_CHANGED_V1" },
    }), 2);

    releaseNew();
    const result = await newRun;
    assert.equal(result.metrics.placementBaselineWinners, 0);
    assert.equal(result.metrics.placementCasLosses, 2);
    assert.equal(result.metrics.placementEventReplays, 0);
    assert.equal(result.metrics.placementEventInserts, 0);
    assert.equal(await prisma.domainEventOutbox.count({
      where: { aggregateId: race.id, eventType: "PLACEMENT_CHANGED_V1" },
    }), 2, "the new CAS loser must not duplicate the old producer's events");
    assert.deepEqual((await prisma.raceParticipant.findMany({
      where: { raceId: race.id },
      orderBy: { totalSteps: "desc" },
    })).map((row) => row.lastNotifiedPlacement), [1, 2]);
  });

  it("verifies an ambiguous deterministic replay and projects it once after restart", async () => {
    const { race, users } = await createActiveRace(1);
    const participant = await prisma.raceParticipant.findFirst({
      where: { raceId: race.id },
    });
    const observedAt = new Date(Date.now() - 2_000);
    const transitionId = `placement:${participant.id}:resolution:1:2->1`;
    await prisma.$transaction((tx) => appendDomainEvent(tx, {
      eventKey: `PLACEMENT_CHANGED_V1:${transitionId}`,
      eventType: "PLACEMENT_CHANGED_V1",
      schemaVersion: 1,
      aggregateType: "RACE",
      aggregateId: race.id,
      occurredAt: observedAt,
      payload: {
        transitionId,
        raceId: race.id,
        raceName: race.name,
        userId: users[0].id,
        previousPlacement: 2,
        placement: 1,
        paidPlaces: 0,
        endsAt: race.endsAt,
      },
      audience: [{ recipientId: users[0].id, facts: {} }],
    }));
    await RacePlacementTransitionJob.enqueueCurrentGeneration({
      raceId: race.id, generation: 1, observedAt, now: observedAt,
    });
    const replay = await buildRacePlacementTransitionWorker({
      now: () => new Date(),
    }).processOne();
    assert.equal(replay.metrics.placementEventInserts, 0);
    assert.equal(replay.metrics.placementEventReplays, 1);
    assert.equal(await prisma.domainEventOutbox.count({ where: { aggregateId: race.id } }), 1);

    // The process can disappear after placement commit. A fresh projector
    // drains the durable event and repeated drains remain idempotent.
    const projector = buildNotificationProjector({
      prisma,
      logger: { log() {}, warn() {}, error() {} },
    });
    await projector.run();
    await projector.run();
    assert.equal(await prisma.domainEventNotificationProjection.count({
      where: { recipientUserId: users[0].id },
    }), 1);
  });

  it("rolls placement facts back on injected bulk-event failure, then retries", async () => {
    const { race } = await createActiveRace(2);
    const at = new Date("2026-08-27T12:00:00.000Z");
    await RacePlacementTransitionJob.enqueueCurrentGeneration({
      raceId: race.id, generation: 1, observedAt: at, now: at,
    });
    const failing = buildRacePlacementTransitionWorker({
      now: () => new Date(at.getTime() + 2000),
      bulkAppendDomainEvents: async () => { throw Object.assign(new Error("injected"), { code: "INJECTED" }); },
      logger: { log() {}, warn() {}, error() {} },
    });
    assert.ok(await failing.processOne());
    assert.deepEqual((await prisma.raceParticipant.findMany({
      where: { raceId: race.id }, orderBy: { totalSteps: "desc" },
    })).map((row) => row.lastNotifiedPlacement), [2, 3]);
    assert.equal(await prisma.domainEventOutbox.count({ where: { aggregateId: race.id } }), 0);
    assert.equal((await prisma.racePlacementTransitionJob.findUnique({ where: { raceId: race.id } })).state, "RETRY");

    const retryAt = new Date(at.getTime() + 4000);
    assert.ok(await buildRacePlacementTransitionWorker({ now: () => retryAt }).processOne());
    assert.equal(await prisma.domainEventOutbox.count({ where: { aggregateId: race.id } }), 2);
  });

  it("rolls outbox rows and baselines back when audience persistence fails", async () => {
    const { race } = await createActiveRace(2);
    const observedAt = new Date(Date.now() - 2_000);
    await RacePlacementTransitionJob.enqueueCurrentGeneration({
      raceId: race.id, generation: 1, observedAt, now: observedAt,
    });
    const failed = await buildRacePlacementTransitionWorker({
      now: () => new Date(),
      logger: { log() {}, warn() {}, error() {} },
      async bulkAppendDomainEvents(tx, events) {
        if (events.length > 0) {
          const event = events[0];
          await tx.domainEventOutbox.create({
            data: {
              eventKey: event.eventKey,
              eventType: event.eventType,
              schemaVersion: event.schemaVersion,
              aggregateType: event.aggregateType,
              aggregateId: event.aggregateId,
              payload: event.payload,
              occurredAt: event.occurredAt,
              availableAt: event.occurredAt,
            },
          });
        }
        throw Object.assign(new Error("injected audience write failure"), {
          code: "INJECTED_AUDIENCE_FAILURE",
        });
      },
    }).processOne();
    assert.equal(failed.error?.code, "INJECTED_AUDIENCE_FAILURE");
    assert.equal(await prisma.domainEventOutbox.count({ where: { aggregateId: race.id } }), 0);
    assert.equal(await prisma.domainEventAudience.count(), 0);
    assert.deepEqual((await prisma.raceParticipant.findMany({
      where: { raceId: race.id }, orderBy: { totalSteps: "desc" },
    })).map((row) => row.lastNotifiedPlacement), [2, 3]);

    await prisma.racePlacementTransitionJob.update({
      where: { raceId: race.id }, data: { retryAt: new Date(0) },
    });
    assert.equal((await buildRacePlacementTransitionWorker({
      now: () => new Date(),
    }).processOne()).metrics.placementOutcome, "committed");
    assert.equal(await prisma.domainEventAudience.count(), 2);
  });

  it("treats a concurrently advanced baseline as a CAS loss and emits no stale event", async () => {
    const { race, users } = await createActiveRace(2);
    const at = new Date("2026-08-27T12:00:00.000Z");
    await RacePlacementTransitionJob.enqueueCurrentGeneration({
      raceId: race.id, generation: 1, observedAt: at, now: at,
    });
    const result = await buildRacePlacementTransitionWorker({
      now: () => new Date(at.getTime() + 2000),
      async beforePersist() {
        await prisma.raceParticipant.updateMany({
          where: { raceId: race.id, userId: users[0].id },
          data: { lastNotifiedPlacement: 99 },
        });
      },
    }).processOne();
    assert.equal(result.metrics.placementCasLosses, 1);
    assert.equal((await prisma.raceParticipant.findFirst({
      where: { raceId: race.id, userId: users[0].id },
    })).lastNotifiedPlacement, 99);
    assert.equal(await prisma.domainEventOutbox.count({
      where: { aggregateId: race.id, payload: { path: ["userId"], equals: users[0].id } },
    }), 0);
    assert.equal(await prisma.domainEventOutbox.count({ where: { aggregateId: race.id } }), 1);
  });

  it("fences a plan when notification mute changes before persistence", async () => {
    const { race, users } = await createActiveRace(2);
    const requestedAt = new Date(Date.now() - 2_000);
    await RacePlacementTransitionJob.enqueueCurrentGeneration({
      raceId: race.id, generation: 1, observedAt: requestedAt, now: requestedAt,
    });
    const result = await buildRacePlacementTransitionWorker({
      now: () => new Date(),
      async beforePersist() {
        await prisma.raceParticipant.updateMany({
          where: { raceId: race.id, userId: users[0].id },
          data: { placementAlertsMuted: true },
        });
      },
    }).processOne();
    assert.equal(result.metrics.placementOutcome, "superseded_skip");
    assert.equal(await prisma.domainEventOutbox.count({ where: { aggregateId: race.id } }), 0);
    assert.deepEqual((await prisma.raceParticipant.findMany({
      where: { raceId: race.id }, orderBy: { totalSteps: "desc" },
    })).map((row) => row.lastNotifiedPlacement), [2, 3]);
  });

  it("fences stale notification payloads when race planning facts change", async () => {
    const { race } = await createActiveRace(2);
    const requestedAt = new Date(Date.now() - 2_000);
    await RacePlacementTransitionJob.enqueueCurrentGeneration({
      raceId: race.id, generation: 1, observedAt: requestedAt, now: requestedAt,
    });
    const result = await buildRacePlacementTransitionWorker({
      now: () => new Date(),
      async beforePersist() {
        await prisma.race.update({
          where: { id: race.id },
          data: { name: "Changed after placement planning", potCoins: 100 },
        });
      },
    }).processOne();
    assert.equal(result.metrics.placementOutcome, "superseded_skip");
    assert.equal(await prisma.domainEventOutbox.count({ where: { aggregateId: race.id } }), 0);
  });

  it("fences a claimed placement plan when a newer score generation arrives", async () => {
    const { race } = await createActiveRace(2);
    const at = new Date("2026-08-27T12:00:00.000Z");
    await RacePlacementTransitionJob.enqueueCurrentGeneration({
      raceId: race.id, generation: 1, observedAt: at, now: at,
    });
    const first = await buildRacePlacementTransitionWorker({
      now: () => new Date(at.getTime() + 2000),
      async beforePersist() {
        await prisma.raceResolutionJobV2.update({
          where: { raceId: race.id },
          data: { generation: 2, processingGeneration: 2, state: "SUCCEEDED" },
        });
        await RacePlacementTransitionJob.enqueueCurrentGeneration({
          raceId: race.id,
          generation: 2,
          observedAt: new Date(at.getTime() + 2500),
          now: new Date(at.getTime() + 2500),
        });
      },
    }).processOne();
    assert.equal(first.metrics.placementOutcome, "superseded_skip");
    assert.equal(await prisma.domainEventOutbox.count({ where: { aggregateId: race.id } }), 0);
    const queued = await prisma.racePlacementTransitionJob.findUnique({ where: { raceId: race.id } });
    assert.equal(queued.requestedGeneration, 2);
    assert.equal(queued.state, "QUEUED");

    const second = await buildRacePlacementTransitionWorker({
      now: () => new Date(at.getTime() + 5000),
    }).processOne();
    assert.equal(second.metrics.placementOutcome, "committed");
    const keys = (await prisma.domainEventOutbox.findMany({
      where: { aggregateId: race.id }, select: { eventKey: true },
    })).map((row) => row.eventKey);
    assert.ok(keys.every((key) => key.includes(":resolution:2:")));
  });

  it("keeps the team transition claim, baselines, and event in one retryable transaction", async () => {
    const { race } = await createActiveRace(4, { isTeamRace: true });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id, team: "TEAM_A" },
      data: { lastNotifiedPlacement: 2 },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id, team: "TEAM_B" },
      data: { lastNotifiedPlacement: 1 },
    });
    const at = new Date("2026-08-27T12:00:00.000Z");
    await RacePlacementTransitionJob.enqueueCurrentGeneration({ raceId: race.id, generation: 1, observedAt: at, now: at });
    await buildRacePlacementTransitionWorker({
      now: () => new Date(at.getTime() + 2000),
      bulkAppendDomainEvents: async () => { throw Object.assign(new Error("injected"), { code: "INJECTED" }); },
      logger: { log() {}, warn() {}, error() {} },
    }).processOne();
    assert.equal(await prisma.jobRun.count({ where: { jobName: `team-lead:${race.id}` } }), 0);
    assert.equal(await prisma.domainEventOutbox.count({ where: { aggregateId: race.id } }), 0);
    const unchanged = await prisma.raceParticipant.findMany({ where: { raceId: race.id } });
    assert.ok(unchanged.filter((row) => row.team === "TEAM_A").every((row) => row.lastNotifiedPlacement === 2));

    const committed = await buildRacePlacementTransitionWorker({
      now: () => new Date(at.getTime() + 4000),
    }).processOne();
    assert.equal(committed.metrics.placementPersistStatements, 10);
    assert.equal(await prisma.jobRun.count({ where: { jobName: `team-lead:${race.id}` } }), 1);
    assert.equal(await prisma.domainEventOutbox.count({
      where: { aggregateId: race.id, eventType: "TEAM_LEAD_CHANGED_V1" },
    }), 1);
  });

  it("dedupes concurrent old and new team producers through atomic JobRun claim", async () => {
    const { race } = await createActiveRace(4, { isTeamRace: true });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id, team: "TEAM_A" },
      data: { lastNotifiedPlacement: 2 },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id, team: "TEAM_B" },
      data: { lastNotifiedPlacement: 1 },
    });
    const observedAt = new Date(Date.now() - 60_000);
    await RacePlacementTransitionJob.enqueueCurrentGeneration({
      raceId: race.id, generation: 1, observedAt, now: observedAt,
    });

    let releaseNew;
    let newPlanned;
    const planned = new Promise((resolve) => { newPlanned = resolve; });
    const release = new Promise((resolve) => { releaseNew = resolve; });
    const newRun = buildRacePlacementTransitionWorker({
      now: () => new Date(),
      logger: { log() {}, warn() {}, error() {} },
      async beforePersist() {
        newPlanned();
        await release;
      },
    }).processOne();
    await planned;

    let oldHoldingResolve;
    let releaseOldResolve;
    const oldHolding = new Promise((resolve) => { oldHoldingResolve = resolve; });
    const releaseOld = new Promise((resolve) => { releaseOldResolve = resolve; });
    const oldRun = buildLegacyProductionRecompute({
      now: () => new Date(observedAt.getTime() + 5 * 60 * 1000),
      async afterDurableEventAppend({ eventName }) {
        if (eventName !== "TEAM_LEAD_CHANGED") return;
        oldHoldingResolve();
        await releaseOld;
      },
    })();
    await oldHolding;
    releaseNew();
    assert.equal(await Promise.race([
      newRun.then(() => "completed"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]), "blocked", "the new CAS must wait while the old outer transaction owns participant rows");
    releaseOldResolve();
    await oldRun;
    const result = await newRun;
    assert.equal(result.metrics.placementOutcome, "committed");
    assert.equal(result.metrics.placementBaselineWinners, 0);
    assert.equal(result.metrics.placementEventInserts, 0);
    assert.equal(await prisma.jobRun.count({
      where: { jobName: `team-lead:${race.id}` },
    }), 1);
    assert.equal(await prisma.domainEventOutbox.count({
      where: { aggregateId: race.id, eventType: "TEAM_LEAD_CHANGED_V1" },
    }), 1);
    assert.equal(await prisma.domainEventOutbox.count({
      where: {
        aggregateId: race.id,
        eventType: "TEAM_LEAD_CHANGED_V1",
        eventKey: { contains: ":resolution:" },
      },
    }), 0);
  });

  it("preserves three distinct team flips across A to B to A", async () => {
    const { race } = await createActiveRace(4, { isTeamRace: true });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id, team: "TEAM_A" }, data: { lastNotifiedPlacement: 2 },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id, team: "TEAM_B" }, data: { lastNotifiedPlacement: 1 },
    });
    for (let generation = 1; generation <= 3; generation += 1) {
      if (generation > 1) {
        const aLeads = generation === 3;
        await prisma.raceParticipant.updateMany({
          where: { raceId: race.id, team: "TEAM_A" },
          data: { totalSteps: aLeads ? 10_000 : 1_000 },
        });
        await prisma.raceParticipant.updateMany({
          where: { raceId: race.id, team: "TEAM_B" },
          data: { totalSteps: aLeads ? 1_000 : 10_000 },
        });
        await prisma.raceResolutionJobV2.update({
          where: { raceId: race.id },
          data: { generation, processingGeneration: generation },
        });
      }
      const observedAt = new Date(Date.now() - 2_000 + generation);
      await RacePlacementTransitionJob.enqueueCurrentGeneration({
        raceId: race.id, generation, observedAt, now: observedAt,
      });
      await prisma.racePlacementTransitionJob.update({
        where: { raceId: race.id }, data: { notBeforeAt: new Date(0) },
      });
      assert.equal((await buildRacePlacementTransitionWorker({
        now: () => new Date(),
      }).processOne()).metrics.placementOutcome, "committed");
    }
    const events = await prisma.domainEventOutbox.findMany({
      where: { aggregateId: race.id, eventType: "TEAM_LEAD_CHANGED_V1" },
      orderBy: { occurredAt: "asc" },
    });
    assert.equal(events.length, 3);
    assert.equal(new Set(events.map((event) => event.eventKey)).size, 3);
    assert.deepEqual(events.map((event) => event.payload.transitionId.split(":").at(-1)), [
      "TEAM_B->TEAM_A", "TEAM_A->TEAM_B", "TEAM_B->TEAM_A",
    ]);
  });

  it("seeds null and muted baselines silently and freezes finished baselines", async () => {
    const { race, users } = await createActiveRace(4, {
      baselines(index) { return index === 0 ? null : index + 2; },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id, userId: users[1].id },
      data: { placementAlertsMuted: true },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id, userId: users[2].id },
      data: { finishedAt: new Date("2026-08-27T10:00:00.000Z"), placement: 3 },
    });
    const at = new Date("2026-08-27T12:00:00.000Z");
    await RacePlacementTransitionJob.enqueueCurrentGeneration({ raceId: race.id, generation: 1, observedAt: at, now: at });
    await buildRacePlacementTransitionWorker({ now: () => new Date(at.getTime() + 2000) }).processOne();
    const rows = await prisma.raceParticipant.findMany({ where: { raceId: race.id } });
    const byUser = new Map(rows.map((row) => [row.userId, row]));
    assert.equal(byUser.get(users[0].id).lastNotifiedPlacement, 2);
    assert.equal(byUser.get(users[1].id).lastNotifiedPlacement, 3);
    assert.equal(byUser.get(users[2].id).lastNotifiedPlacement, 4, "finished baseline is frozen");
    assert.equal(await prisma.domainEventOutbox.count({ where: { aggregateId: race.id } }), 1);
  });

  it("persists 750 placement changes in checked 250-row pages without touching totals", async () => {
    const { race } = await createActiveRace(750);
    const at = new Date("2026-08-27T12:00:00.000Z");
    await RacePlacementTransitionJob.enqueueCurrentGeneration({ raceId: race.id, generation: 1, observedAt: at, now: at });
    const result = await buildRacePlacementTransitionWorker({ now: () => new Date(at.getTime() + 2000) }).processOne();
    assert.equal(result.metrics.placementProposed, 750);
    assert.equal(result.metrics.pages, 3);
    assert.equal(result.metrics.placementPersistStatements, 17);
    assert.equal(await prisma.domainEventOutbox.count({ where: { aggregateId: race.id } }), 750);
    const rows = await prisma.raceParticipant.findMany({ where: { raceId: race.id }, orderBy: { totalSteps: "desc" } });
    assert.deepEqual(rows.map((row) => row.lastNotifiedPlacement), Array.from({ length: 750 }, (_, index) => index + 1));
    assert.deepEqual(rows.map((row) => row.totalSteps), Array.from({ length: 750 }, (_, index) => 750 - index));
  });

  it("drains a 250-person real HTTP sync burst through score, placement, and projector queues", async () => {
    await appSettings.setFlag("raceQueueV2ClaimingDisabled", false);
    await appSettings.setFlag("inlineRaceResolutionFallback", false);
    await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);
    await appSettings.setFlag("raceResolutionQueuedGenerationMergeV1Enabled", true);
    const runners = [];
    for (let index = 0; index < 250; index += 1) {
      runners.push(await createTestUser({
        appleId: `placement-http-250-${index}-${Date.now()}`,
      }));
    }
    const race = await prisma.race.create({
      data: {
        creatorId: runners[0].user.id,
        name: "HTTP 250 placement correctness",
        targetSteps: 1_000_000,
        status: "ACTIVE",
        startedAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        timezone: "UTC",
      },
    });
    await prisma.raceParticipant.createMany({
      data: runners.map((runner, index) => ({
        raceId: race.id,
        userId: runner.user.id,
        status: "ACCEPTED",
        totalSteps: 250 - index,
        lastNotifiedPlacement: index + 1,
        joinedAt: new Date(Date.now() - 7 * 60 * 60 * 1000 + index),
      })),
    });
    const sampleEnd = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const sampleStart = new Date(sampleEnd.getTime() - 60 * 60 * 1000);
    const post = (runner, steps) => request(server.baseUrl, "POST", "/steps/samples", {
      token: runner.token,
      body: { samples: [{
        periodStart: sampleStart.toISOString(),
        periodEnd: sampleEnd.toISOString(),
        steps,
      }] },
    });
    assert.equal((await post(runners[249], 10_000)).status, 200);
    assert.equal((await post(runners[248], 8_000)).status, 200);
    assert.equal((await post(runners[249], 12_000)).status, 200);
    const queued = await prisma.raceResolutionJobV2.findUnique({
      where: { raceId: race.id },
    });
    assert.equal(new Set(queued.dirtyParticipantIds).size, 2);
    assert.equal(new Set(queued.triggeredByUserIds).size, 2);

    await prisma.raceResolutionJobV2.update({
      where: { raceId: race.id }, data: { notBeforeAt: new Date(0) },
    });
    assert.ok(await buildRaceResolutionWorkerV2({
      bootAt: 0,
      now: () => new Date(),
      logger: { log() {}, warn() {}, error() {} },
    }).processOne());
    await prisma.racePlacementTransitionJob.update({
      where: { raceId: race.id }, data: { notBeforeAt: new Date(0) },
    });
    const placement = await buildRacePlacementTransitionWorker({
      now: () => new Date(),
    }).processOne();
    assert.equal(placement.metrics.placementProposed, 250);
    assert.equal(placement.metrics.pages, 1);
    assert.equal(placement.metrics.placementPersistStatements, 9);
    assert.equal(await prisma.domainEventOutbox.count({
      where: { aggregateId: race.id, eventType: "PLACEMENT_CHANGED_V1" },
    }), 250);
    assert.equal(await prisma.domainEventAudience.count({
      where: { event: { aggregateId: race.id } },
    }), 250);
    const ranked = await prisma.raceParticipant.findMany({
      where: { raceId: race.id },
      orderBy: [{ totalSteps: "desc" }, { joinedAt: "asc" }, { userId: "asc" }],
    });
    assert.deepEqual(ranked.map((row) => row.lastNotifiedPlacement),
      Array.from({ length: 250 }, (_, index) => index + 1));
    assert.equal(ranked[0].totalSteps, 12_000);
    assert.equal(ranked[1].totalSteps, 8_000);

    const projector = buildNotificationProjector({
      prisma,
      logger: { log() {}, warn() {}, error() {} },
    });
    for (let index = 0; index < 30; index += 1) await projector.run();
    assert.equal(await prisma.domainEventNotificationProjection.count({
      where: { event: { aggregateId: race.id } },
    }), 250);
    assert.equal(await buildRacePlacementTransitionWorker({
      now: () => new Date(Date.now() + 60_000),
    }).processOne(), null);
  });
});
