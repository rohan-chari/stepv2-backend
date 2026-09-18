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
  startTestRedis,
} = require("../redisTestServer");
const {
  STREAMS,
  GROUPS,
  streamName,
  publish,
  ensureGroup,
  readGroup,
  pendingSummary,
  close: closeQueueRedis,
} = require("../../../src/shared/queues/redisStreams");
const {
  POWERUP_RECALC_VERSION,
} = require("../../../src/shared/queues/workMessages");
const {
  buildPowerupRecalcStreamWorker,
} = require("../../../src/modules/powerups/jobs/powerupRecalcStreamWorker");
const {
  RaceResolutionJobV2,
} = require("../../../src/modules/races/models/raceResolutionJobV2");

let ownedRedis = null;
let redisUrl;
let inspector;
let originalRedisUrl;
let originalPrefix;
let testPrefix;

async function deletePrefix(prefix) {
  if (!inspector || !prefix) return;
  let cursor = "0";
  do {
    const [next, keys] = await inspector.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 100);
    cursor = next;
    if (keys.length) await inspector.del(...keys);
  } while (cursor !== "0");
}

async function seedRace({
  userId,
  interval = 5000,
  nextBoxAtSteps = interval,
  powerupSlots = 3,
  status = "ACTIVE",
  powerupsEnabled = true,
} = {}) {
  const startedAt = new Date(Date.now() - 60 * 60 * 1000);
  const race = await prisma.race.create({
    data: {
      creatorId: userId,
      name: "Powerup queue integration",
      targetSteps: 500000,
      status,
      isPublic: false,
      timeBased: true,
      maxDurationDays: 7,
      timezone: "UTC",
      powerupsEnabled,
      powerupStepInterval: interval,
      startedAt,
      endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
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
      nextBoxAtSteps,
      powerupSlots,
    },
  });
  return { race, participant };
}

function workerForSteps(userId, boxEffectiveSteps) {
  return buildPowerupRecalcStreamWorker({
    computeRaceState: async ({ raceId }) => ({
      result: { race: { id: raceId } },
      boxEffectiveStepsByUser: {
        [userId]: boxEffectiveSteps,
      },
    }),
    logger: { log() {}, warn() {}, error() {} },
  });
}

function workerForAnyUser(boxEffectiveSteps, dependencies = {}) {
  return buildPowerupRecalcStreamWorker({
    computeRaceState: async ({ raceId, userIds = [] }) => ({
      result: { race: { id: raceId } },
      boxEffectiveStepsByUser: Object.fromEntries(
        userIds.map((userId) => [userId, boxEffectiveSteps]),
      ),
    }),
    logger: { log() {}, warn() {}, error() {} },
    ...dependencies,
  });
}

async function addParticipants(raceId, count) {
  const now = Date.now();
  const users = Array.from({ length: count }, (_, index) => ({
    id: crypto.randomUUID(),
    appleId: `queue-burst-${now}-${index}-${crypto.randomUUID()}`,
    email: `queue-burst-${now}-${index}@example.com`,
  }));
  await prisma.user.createMany({ data: users });
  const joinedAt = new Date(Date.now() - 60 * 60 * 1000);
  const participants = users.map((user) => ({
    id: crypto.randomUUID(),
    raceId,
    userId: user.id,
    status: "ACCEPTED",
    joinedAt,
    totalSteps: 0,
    rawSteps: 0,
    nextBoxAtSteps: 5000,
    powerupSlots: 3,
  }));
  await prisma.raceParticipant.createMany({ data: participants });
  return participants;
}

async function publishRecalc({ raceId, userId, participantId, generation = 1 }) {
  return publish(STREAMS.POWERUP_RECALC, {
    schemaVersion: POWERUP_RECALC_VERSION,
    userId,
    raceId,
    participantId,
    sourceGeneration: generation,
    requestedAt: new Date().toISOString(),
  });
}

async function readRecalc(consumer = "powerup-test") {
  const entries = await readGroup({
    stream: STREAMS.POWERUP_RECALC,
    group: GROUPS.POWERUP_RECALC,
    consumer,
    count: 10,
    blockMs: 5,
  });
  return entries;
}

async function raceDirtyCount() {
  return Number(await inspector.xlen(streamName(STREAMS.RACE_DIRTY)));
}

describe("POWERUP_RECALC queue worker", () => {
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
    testPrefix = `${originalPrefix || "integration:"}powerup-worker:${crypto.randomUUID()}:`;
    process.env.REDIS_URL = redisUrl;
    process.env.CACHE_ENV_PREFIX = testPrefix;
    await cleanDatabase();
    await ensureGroup(STREAMS.POWERUP_RECALC, GROUPS.POWERUP_RECALC);
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

  it("ACKs a recalculation with no crossed threshold and makes no mutation", async () => {
    const { user } = await createTestUser();
    const { race, participant } = await seedRace({ userId: user.id });
    const worker = workerForSteps(user.id, 4999);

    await publishRecalc({
      raceId: race.id,
      userId: user.id,
      participantId: participant.id,
    });
    const [entry] = await readRecalc();
    assert.ok(entry);

    assert.equal(await worker.processEntry(entry), true);
    assert.equal(
      await prisma.racePowerup.count({ where: { participantId: participant.id } }),
      0,
    );
    assert.equal(await raceDirtyCount(), 0);
    assert.equal(
      (await pendingSummary(STREAMS.POWERUP_RECALC, GROUPS.POWERUP_RECALC)).count,
      0,
    );
  });

  it("crossing one threshold mints exactly one mystery box, publishes RACE_DIRTY, and ACKs", async () => {
    const { user } = await createTestUser();
    const { race, participant } = await seedRace({ userId: user.id });
    const worker = workerForSteps(user.id, 5000);

    await publishRecalc({
      raceId: race.id,
      userId: user.id,
      participantId: participant.id,
    });
    const [entry] = await readRecalc();
    assert.equal(await worker.processEntry(entry), true);

    const boxes = await prisma.racePowerup.findMany({
      where: { participantId: participant.id },
      orderBy: { earnedAtSteps: "asc" },
    });
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].status, "MYSTERY_BOX");
    assert.equal(boxes[0].earnedAtSteps, 5000);
    assert.equal(await raceDirtyCount(), 1);
    assert.equal(
      await prisma.raceResolutionJobV2.count({ where: { raceId: race.id } }),
      1,
      "powerup mutation must durably enqueue the race in Postgres",
    );
    assert.equal(
      (await pendingSummary(STREAMS.POWERUP_RECALC, GROUPS.POWERUP_RECALC)).count,
      0,
    );
  });

  it("crossing multiple thresholds preserves slot and queued-box behavior", async () => {
    const { user } = await createTestUser();
    const { race, participant } = await seedRace({ userId: user.id, powerupSlots: 3 });
    const worker = workerForSteps(user.id, 20000);

    await publishRecalc({
      raceId: race.id,
      userId: user.id,
      participantId: participant.id,
    });
    const [entry] = await readRecalc();
    assert.equal(await worker.processEntry(entry), true);

    const boxes = await prisma.racePowerup.findMany({
      where: { participantId: participant.id },
      orderBy: { earnedAtSteps: "asc" },
    });
    assert.deepEqual(
      boxes.map((box) => [box.earnedAtSteps, box.status]),
      [
        [5000, "MYSTERY_BOX"],
        [10000, "MYSTERY_BOX"],
        [15000, "MYSTERY_BOX"],
        [20000, "QUEUED"],
      ],
    );

    const refreshed = await prisma.raceParticipant.findUniqueOrThrow({
      where: { id: participant.id },
    });
    assert.equal(refreshed.nextBoxAtSteps, 25000);
    assert.equal(await raceDirtyCount(), 1);
  });

  it("promotes a queued box when a slot is available", async () => {
    const { user } = await createTestUser();
    const { race, participant } = await seedRace({
      userId: user.id,
      nextBoxAtSteps: 10000,
      powerupSlots: 1,
    });
    const queued = await prisma.racePowerup.create({
      data: {
        raceId: race.id,
        participantId: participant.id,
        userId: user.id,
        type: null,
        rarity: null,
        status: "QUEUED",
        earnedAtSteps: 5000,
      },
    });
    const worker = workerForSteps(user.id, 5000);

    await publishRecalc({
      raceId: race.id,
      userId: user.id,
      participantId: participant.id,
    });
    const [entry] = await readRecalc();
    assert.equal(await worker.processEntry(entry), true);

    const promoted = await prisma.racePowerup.findUniqueOrThrow({
      where: { id: queued.id },
    });
    assert.equal(promoted.status, "MYSTERY_BOX");
    assert.equal(
      (await pendingSummary(STREAMS.POWERUP_RECALC, GROUPS.POWERUP_RECALC)).count,
      0,
    );
  });

  it("duplicate recalculation delivery does not mint a duplicate box", async () => {
    const { user } = await createTestUser();
    const { race, participant } = await seedRace({ userId: user.id });
    const worker = workerForSteps(user.id, 5000);

    await publishRecalc({
      raceId: race.id,
      userId: user.id,
      participantId: participant.id,
    });
    await publishRecalc({
      raceId: race.id,
      userId: user.id,
      participantId: participant.id,
    });

    const entries = await readRecalc();
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.equal(await worker.processEntry(entry), true);
    }

    assert.equal(
      await prisma.racePowerup.count({ where: { participantId: participant.id } }),
      1,
    );
    assert.equal(
      (await pendingSummary(STREAMS.POWERUP_RECALC, GROUPS.POWERUP_RECALC)).count,
      0,
    );
  });

  it("concurrent duplicate recalculations converge to one box", async () => {
    const { user } = await createTestUser();
    const { race, participant } = await seedRace({ userId: user.id });
    const worker = workerForSteps(user.id, 5000);

    await publishRecalc({
      raceId: race.id,
      userId: user.id,
      participantId: participant.id,
    });
    await publishRecalc({
      raceId: race.id,
      userId: user.id,
      participantId: participant.id,
    });

    const entries = await readRecalc();
    assert.equal(entries.length, 2);
    const results = await Promise.all(entries.map((entry) => worker.processEntry(entry)));
    assert.deepEqual(results, [true, true]);
    assert.equal(
      await prisma.racePowerup.count({ where: { participantId: participant.id } }),
      1,
    );
  });

  it("ACKs inactive or powerup-disabled races without mutating inventory", async () => {
    const { user } = await createTestUser();
    const { race, participant } = await seedRace({
      userId: user.id,
      powerupsEnabled: false,
    });
    const worker = workerForSteps(user.id, 5000);

    await publishRecalc({
      raceId: race.id,
      userId: user.id,
      participantId: participant.id,
    });
    const [entry] = await readRecalc();
    assert.equal(await worker.processEntry(entry), true);

    assert.equal(
      await prisma.racePowerup.count({ where: { participantId: participant.id } }),
      0,
    );
    assert.equal(await raceDirtyCount(), 0);
    assert.equal(
      (await pendingSummary(STREAMS.POWERUP_RECALC, GROUPS.POWERUP_RECALC)).count,
      0,
    );
  });

  it("keeps a durable race recovery candidate when the Redis wake is lost after the powerup commit", async () => {
    const { user } = await createTestUser();
    const { race, participant } = await seedRace({ userId: user.id });

    // Simulate the exact failure window: the durable race generation is written
    // in the SAME transaction as the box, but the after-commit Redis wake never
    // makes it to the stream. The POWERUP_RECALC itself can still ACK safely
    // because recovery no longer depends on replaying the powerup mutation.
    const worker = workerForAnyUser(5000, {
      enqueueRaceResolution: async (args, tx) =>
        RaceResolutionJobV2.enqueue(
          {
            raceId: args.raceId,
            userId: args.userId,
            resolutionTimeZone: args.timeZone,
            now: args.now,
            dirtyEnvelope: {
              reason: "POWERUP_MUTATION",
              dirtyUserIds: [args.userId],
              dirtyParticipantIds: args.dirtyParticipantIds || [],
              powerupTypes: [],
              priority: "IMMEDIATE",
            },
            queuedGenerationMerge: true,
            bypassDebounce: true,
            queuePriority: "LIVE",
          },
          tx,
        ),
    });

    await publishRecalc({
      raceId: race.id,
      userId: user.id,
      participantId: participant.id,
    });
    const [entry] = await readRecalc("powerup-lost-wake");
    assert.ok(entry);

    assert.equal(await worker.processEntry(entry), true);
    assert.equal(
      await prisma.racePowerup.count({ where: { participantId: participant.id } }),
      1,
      "the powerup mutation committed",
    );
    assert.equal(
      (await pendingSummary(STREAMS.POWERUP_RECALC, GROUPS.POWERUP_RECALC)).count,
      0,
      "the original powerup message is safely ACKed",
    );
    assert.equal(await raceDirtyCount(), 0, "the Redis wake was intentionally lost");

    const durableJob = await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId: race.id },
    });
    assert.equal(durableJob.state, "QUEUED");

    const candidates = await RaceResolutionJobV2.listRecoveryCandidates({
      now: new Date(Date.now() + 60_000),
      queuedLimit: 50,
      runningLimit: 50,
    });
    assert.ok(
      candidates.some((candidate) => candidate.raceId === race.id),
      "lost Redis wake must remain discoverable from durable Postgres state",
    );
  });

  it("rolls back the box when durable race handoff persistence fails", async () => {
    const { user } = await createTestUser();
    const { race, participant } = await seedRace({ userId: user.id });
    const worker = workerForAnyUser(5000, {
      enqueueRaceResolution: async () => {
        throw new Error("forced durable handoff failure");
      },
    });

    await publishRecalc({
      raceId: race.id,
      userId: user.id,
      participantId: participant.id,
    });
    const [entry] = await readRecalc("powerup-handoff-failure");
    assert.ok(entry);

    assert.equal(await worker.processEntry(entry), false);
    assert.equal(
      await prisma.racePowerup.count({ where: { participantId: participant.id } }),
      0,
      "box and durable handoff are one atomic transaction",
    );
    assert.equal(
      await prisma.raceResolutionJobV2.count({ where: { raceId: race.id } }),
      0,
    );
    assert.equal(
      (await pendingSummary(STREAMS.POWERUP_RECALC, GROUPS.POWERUP_RECALC)).count,
      1,
      "failed transaction remains retryable",
    );
  });

  it("absorbs a 100-user same-race box burst with production-like concurrency and one durable race row", async () => {
    const { user } = await createTestUser();
    const { race } = await seedRace({
      userId: user.id,
      nextBoxAtSteps: 10000,
    });
    const participants = await addParticipants(race.id, 100);
    const worker = workerForAnyUser(5000);

    for (const [index, participant] of participants.entries()) {
      await publishRecalc({
        raceId: race.id,
        userId: participant.userId,
        participantId: participant.id,
        generation: index + 1,
      });
    }

    const processed = [];
    while (processed.length < participants.length) {
      const batch = await readRecalc(`powerup-burst-${processed.length}`);
      if (!batch.length) break;

      let cursor = 0;
      async function consume() {
        while (true) {
          const index = cursor++;
          if (index >= batch.length) return;
          const ok = await worker.processEntry(batch[index]);
          assert.equal(ok, true);
          processed.push(batch[index].id);
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(3, batch.length) }, consume),
      );
    }

    assert.equal(processed.length, 100, "every queued recalculation was processed");
    assert.equal(
      await prisma.racePowerup.count({
        where: {
          raceId: race.id,
          participantId: { in: participants.map((participant) => participant.id) },
        },
      }),
      100,
      "every threshold crossing minted exactly one box",
    );
    assert.equal(
      await prisma.raceResolutionJobV2.count({ where: { raceId: race.id } }),
      1,
      "same-race burst must coalesce into one durable race job row",
    );
    const job = await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId: race.id },
    });
    assert.ok(Number(job.generation) >= 1);
    assert.ok(Number(job.generation) <= 100);
    assert.equal(
      (await pendingSummary(STREAMS.POWERUP_RECALC, GROUPS.POWERUP_RECALC)).count,
      0,
      "the burst drains cleanly",
    );
  });
});
