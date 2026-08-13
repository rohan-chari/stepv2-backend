const assert = require("node:assert/strict");
const { beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  prisma,
} = require("./setup");
const {
  buildRecomputePlacements,
} = require("../../src/modules/races/jobs/placementRecompute");
const {
  buildRaceProgressPostCommit,
} = require("../../src/modules/races/services/raceProgressSideEffects");
const {
  buildExpireEffects,
} = require("../../src/modules/powerups/commands/expireEffects");
const {
  Notification,
} = require("../../src/modules/notifications/notification");

const NOW = new Date("2026-08-13T16:00:00Z");
const HOUR_MS = 60 * 60 * 1000;

async function createActiveRace(userId, suffix) {
  const race = await prisma.race.create({
    data: {
      creatorId: userId,
      name: `Efficiency ${suffix}`,
      targetSteps: 100000,
      status: "ACTIVE",
      startedAt: new Date(NOW.getTime() - HOUR_MS),
      endsAt: new Date(NOW.getTime() + 24 * HOUR_MS),
      timezone: "UTC",
    },
  });
  await prisma.raceParticipant.create({
    data: {
      raceId: race.id,
      userId,
      status: "ACCEPTED",
      totalSteps: 100,
      lastNotifiedPlacement: 1,
    },
  });
  return race;
}

async function runProductionPath() {
  const run = buildRecomputePlacements({
    now: () => NOW,
    eventBus: { emit() {} },
    requestStepSyncForUsers: async () => {},
    logger: { log() {}, warn() {}, error() {} },
  });
  await run();
}

describe("placement recompute efficiency", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("does not re-enqueue fresh successful races when no race data changed", async () => {
    const { user } = await createTestUser({ appleId: "cron-fresh-user" });
    const races = [];
    for (let i = 0; i < 3; i += 1) {
      races.push(await createActiveRace(user.id, `fresh-${i}`));
    }
    await prisma.raceResolutionJobV2.createMany({
      data: races.map((race) => ({
        raceId: race.id,
        generation: 1,
        state: "SUCCEEDED",
        requestedAt: new Date(NOW.getTime() - 10_000),
        completedAt: NOW,
        lastCompletedAt: NOW,
      })),
    });

    await runProductionPath();

    const jobs = await prisma.raceResolutionJobV2.findMany({
      orderBy: { raceId: "asc" },
    });
    assert.equal(jobs.length, 3);
    assert.ok(jobs.every((job) => job.generation === 1));
    assert.ok(jobs.every((job) => job.state === "SUCCEEDED"));
  });

  it("enqueues at most two recovery races in one five-minute tick", async () => {
    const { user } = await createTestUser({ appleId: "cron-recovery-user" });
    for (let i = 0; i < 4; i += 1) {
      await createActiveRace(user.id, `missing-${i}`);
    }

    await runProductionPath();

    const jobs = await prisma.raceResolutionJobV2.findMany();
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every((job) => job.state === "QUEUED"));
  });

  it("prioritizes missing and failed jobs ahead of stale insurance replays", async () => {
    const { user } = await createTestUser({ appleId: "cron-priority-user" });
    const missing = await createActiveRace(user.id, "missing");
    const failed = await createActiveRace(user.id, "failed");
    const stale = await createActiveRace(user.id, "stale");
    const fresh = await createActiveRace(user.id, "fresh");

    await prisma.raceResolutionJobV2.createMany({
      data: [
        {
          raceId: failed.id,
          state: "FAILED",
          requestedAt: new Date(NOW.getTime() - 10 * HOUR_MS),
          completedAt: new Date(NOW.getTime() - 9 * HOUR_MS),
          lastCompletedAt: new Date(NOW.getTime() - 9 * HOUR_MS),
        },
        {
          raceId: stale.id,
          state: "SUCCEEDED",
          requestedAt: new Date(NOW.getTime() - 3 * HOUR_MS),
          completedAt: new Date(NOW.getTime() - 2 * HOUR_MS),
          lastCompletedAt: new Date(NOW.getTime() - 2 * HOUR_MS),
        },
        {
          raceId: fresh.id,
          state: "SUCCEEDED",
          requestedAt: new Date(NOW.getTime() - 10_000),
          completedAt: NOW,
          lastCompletedAt: NOW,
        },
      ],
    });

    await runProductionPath();

    const jobs = await prisma.raceResolutionJobV2.findMany();
    const byRaceId = new Map(jobs.map((job) => [job.raceId, job]));
    assert.equal(byRaceId.get(missing.id)?.state, "QUEUED");
    assert.equal(byRaceId.get(failed.id)?.state, "QUEUED");
    assert.equal(byRaceId.get(stale.id)?.state, "SUCCEEDED");
    assert.equal(byRaceId.get(fresh.id)?.state, "SUCCEEDED");
  });

  it("queues every due-effect race outside the two-race recovery cap", async () => {
    const { user } = await createTestUser({ appleId: "cron-effect-user" });
    const staleRaces = [];
    for (let i = 0; i < 3; i += 1) {
      staleRaces.push(await createActiveRace(user.id, `stale-effect-${i}`));
    }
    const dueRace = await createActiveRace(user.id, "due-effect");
    const allRaces = [...staleRaces, dueRace];
    await prisma.raceResolutionJobV2.createMany({
      data: allRaces.map((race) => ({
        raceId: race.id,
        state: "SUCCEEDED",
        requestedAt: new Date(NOW.getTime() - 3 * HOUR_MS),
        completedAt:
          race.id === dueRace.id
            ? NOW
            : new Date(NOW.getTime() - 2 * HOUR_MS),
        lastCompletedAt:
          race.id === dueRace.id
            ? NOW
            : new Date(NOW.getTime() - 2 * HOUR_MS),
      })),
    });
    const participant = await prisma.raceParticipant.findFirstOrThrow({
      where: { raceId: dueRace.id, userId: user.id },
    });
    const powerup = await prisma.racePowerup.create({
      data: {
        raceId: dueRace.id,
        participantId: participant.id,
        userId: user.id,
        type: "FANNY_PACK",
        rarity: "RARE",
        status: "USED",
        earnedAtSteps: 1,
      },
    });
    await prisma.raceActiveEffect.create({
      data: {
        raceId: dueRace.id,
        targetParticipantId: participant.id,
        targetUserId: user.id,
        sourceUserId: user.id,
        powerupId: powerup.id,
        type: "FANNY_PACK",
        status: "ACTIVE",
        startsAt: new Date(NOW.getTime() - HOUR_MS),
        expiresAt: new Date(NOW.getTime() - 60_000),
      },
    });

    await runProductionPath();

    const jobs = await prisma.raceResolutionJobV2.findMany();
    const byRaceId = new Map(jobs.map((job) => [job.raceId, job]));
    assert.equal(byRaceId.get(dueRace.id)?.state, "QUEUED");
    assert.equal(byRaceId.get(dueRace.id)?.generation, 2);
    assert.equal(
      staleRaces.filter((race) => byRaceId.get(race.id)?.state === "QUEUED")
        .length,
      2
    );
  });

  it("atomically claims a reminder once across concurrent cron runs", async () => {
    const { user } = await createTestUser({ appleId: "cron-claim-user" });
    const race = await createActiveRace(user.id, "claim");
    await prisma.race.update({
      where: { id: race.id },
      data: {
        startedAt: new Date(NOW.getTime() - 5 * HOUR_MS),
        endsAt: new Date(NOW.getTime() + HOUR_MS),
      },
    });
    await prisma.raceResolutionJobV2.create({
      data: {
        raceId: race.id,
        state: "SUCCEEDED",
        requestedAt: new Date(NOW.getTime() - 10_000),
        completedAt: NOW,
        lastCompletedAt: NOW,
      },
    });

    const emitted = [];
    const makeRun = () =>
      buildRecomputePlacements({
        now: () => NOW,
        eventBus: {
          emit(event, data) {
            emitted.push({ event, data });
          },
        },
        requestStepSyncForUsers: async () => {},
        logger: { log() {}, warn() {}, error() {} },
      });

    await Promise.all([makeRun()(), makeRun()()]);

    const ending = emitted.filter(
      (entry) => entry.event === "RACE_ENDING_SOON"
    );
    assert.equal(ending.length, 1);
    assert.equal(ending[0].data.notificationClaimed, true);
    assert.equal(
      await prisma.notification.count({
        where: {
          deliveryKey: `cron:RACE_ENDING_SOON:${race.id}:${user.id}`,
        },
      }),
      1
    );
  });

  it("preserves a legacy audit row when the bulk notification read degrades", async () => {
    const { user } = await createTestUser({ appleId: "cron-legacy-audit-user" });
    const race = await createActiveRace(user.id, "legacy-audit");
    await prisma.race.update({
      where: { id: race.id },
      data: {
        startedAt: new Date(NOW.getTime() - 5 * HOUR_MS),
        endsAt: new Date(NOW.getTime() + HOUR_MS),
      },
    });
    await prisma.raceResolutionJobV2.create({
      data: {
        raceId: race.id,
        state: "SUCCEEDED",
        requestedAt: new Date(NOW.getTime() - 10_000),
        completedAt: NOW,
        lastCompletedAt: NOW,
      },
    });
    await prisma.notification.create({
      data: {
        userId: user.id,
        type: "RACE_ENDING_SOON",
        raceId: race.id,
        deliveryKey: null,
      },
    });
    const emitted = [];
    const run = buildRecomputePlacements({
      now: () => NOW,
      Notification: {
        ...Notification,
        async findExistingByUserTypeRaceKeys() {
          throw new Error("simulated batch read failure");
        },
      },
      eventBus: {
        emit(event, data) {
          emitted.push({ event, data });
        },
      },
      requestStepSyncForUsers: async () => {},
      logger: { log() {}, warn() {}, error() {} },
    });

    await run();

    assert.equal(
      emitted.filter((entry) => entry.event === "RACE_ENDING_SOON").length,
      0
    );
    assert.equal(
      await prisma.notification.count({ where: { raceId: race.id } }),
      1
    );
  });

  it("the worker post-commit path expires only the queued race's due effects", async () => {
    const { user } = await createTestUser({ appleId: "cron-expiry-scope-user" });
    const queuedRace = await createActiveRace(user.id, "queued-expiry");
    const otherRace = await createActiveRace(user.id, "other-expiry");

    async function createDueEffect(race, suffix) {
      const participant = await prisma.raceParticipant.findFirstOrThrow({
        where: { raceId: race.id, userId: user.id },
      });
      const powerup = await prisma.racePowerup.create({
        data: {
          raceId: race.id,
          participantId: participant.id,
          userId: user.id,
          type: "RUNNERS_HIGH",
          rarity: "COMMON",
          status: "USED",
          earnedAtSteps: suffix,
        },
      });
      return prisma.raceActiveEffect.create({
        data: {
          raceId: race.id,
          targetParticipantId: participant.id,
          targetUserId: user.id,
          sourceUserId: user.id,
          powerupId: powerup.id,
          type: "RUNNERS_HIGH",
          status: "ACTIVE",
          startsAt: new Date(NOW.getTime() - HOUR_MS),
          expiresAt: new Date(NOW.getTime() - 60_000),
        },
      });
    }

    const queuedEffect = await createDueEffect(queuedRace, 11);
    const otherEffect = await createDueEffect(otherRace, 12);
    const expireEffects = buildExpireEffects({ now: () => NOW });
    const onCommitted = buildRaceProgressPostCommit({
      redisStandingsEnabled: true,
      now: () => NOW,
      expireEffects,
      getRaceProgress: {
        async computePersistedSnapshot() {
          return {};
        },
      },
      raceProgressSnapshot: {
        async writeSnapshot() {
          return true;
        },
      },
      logger: { log() {}, warn() {}, error() {} },
    });

    await onCommitted({
      raceId: queuedRace.id,
      job: { processingTimeZone: "UTC" },
      result: {
        race: { ...queuedRace, powerupsEnabled: false, participants: [] },
        baseAdjustedByParticipantId: {},
      },
    });

    const [processed, untouched] = await Promise.all([
      prisma.raceActiveEffect.findUnique({ where: { id: queuedEffect.id } }),
      prisma.raceActiveEffect.findUnique({ where: { id: otherEffect.id } }),
    ]);
    assert.equal(processed.status, "EXPIRED");
    assert.equal(untouched.status, "ACTIVE");
  });
});
