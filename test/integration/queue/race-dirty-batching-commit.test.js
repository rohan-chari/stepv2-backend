const assert = require("node:assert/strict");
const { beforeEach, describe, it } = require("node:test");
const { cleanDatabase, prisma, createTestUser } = require("../setup");
const { RaceResolutionJobV2 } = require("../../../src/modules/races/models/raceResolutionJobV2");
const { buildRaceDirtyStreamWorker } = require("../../../src/modules/races/jobs/raceDirtyStreamWorker");

describe("batched race wakes use the canonical commit", () => {
  beforeEach(async () => { await cleanDatabase(); });

  it("respects not-before and acknowledges grouped wakes only after a real fenced commit", async () => {
    const users = [(await createTestUser()).user, (await createTestUser()).user];
    const now = new Date();
    const startedAt = new Date(now.getTime() - 60 * 60_000);
    const race = await prisma.race.create({
      data: {
        creatorId: users[0].id, name: "Batched canonical commit", targetSteps: 100000,
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
    const job = await RaceResolutionJobV2.enqueue({
      raceId: race.id, triggeredUserIds: users.map((user) => user.id), now,
      dirtyEnvelope: {
        reason: "GLOBAL_EVENT_BOUNDARY", dirtyUserIds: users.map((user) => user.id),
        dirtyParticipantIds: [], powerupTypes: [], priority: "COALESCE",
      },
    });
    await prisma.raceResolutionJobV2.update({
      where: { raceId: race.id }, data: { notBeforeAt: new Date(now.getTime() + 60_000) },
    });
    const acknowledged = [];
    let claims = 0;
    const errors = [];
    const worker = buildRaceDirtyStreamWorker({
      prisma,
      RaceResolutionJobV2: {
        ...RaceResolutionJobV2,
        async claimNext(options) {
          assert.equal(options.force, false);
          claims += 1;
          return RaceResolutionJobV2.claimNext(options);
        },
      },
      queue: {
        STREAMS: { RACE_DIRTY: "race" }, GROUPS: { RACE_DIRTY: "race-workers" },
        async ack(_stream, _group, id) { acknowledged.push(id); },
      },
      logger: { log() {}, warn() {}, error(...args) { errors.push(args); } },
    });
    const entries = ["1-0", "1-1"].map((id) => ({
      id, fields: {
        schemaVersion: "1", raceId: race.id, jobGeneration: String(job.generation),
        reason: "GLOBAL_EVENT_BOUNDARY", requestedAt: now.toISOString(),
      },
    }));

    const deferred = await worker.processEntries(entries);
    assert.ok(deferred.every((result) => result.outcome === "DEFERRED"));
    assert.equal(claims, 0);
    assert.equal(acknowledged.length, 0);

    await prisma.raceResolutionJobV2.update({
      where: { raceId: race.id }, data: { notBeforeAt: new Date(now.getTime() - 1) },
    });
    const results = await worker.processEntries(entries);
    assert.ok(results.every((result) => result.completed), JSON.stringify(errors));
    assert.equal(claims, 1, "one grouped race wake should claim the engine once");
    assert.deepEqual(acknowledged, ["1-0", "1-1"]);
    const committed = await RaceResolutionJobV2.findByRaceId(race.id);
    assert.equal(committed.state, "SUCCEEDED");
    assert.ok(committed.lastCompletedAt);
    assert.ok(Number(committed.processingGeneration) >= Number(job.generation));
  });
});
