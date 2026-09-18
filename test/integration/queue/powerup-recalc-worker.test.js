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
  closedPort,
} = require("../redisTestServer");
const {
  STREAMS,
  GROUPS,
  streamName,
  publish,
  ensureGroup,
  readGroup,
  reclaimIdle,
  pendingSummary,
  close: closeQueueRedis,
} = require("../../../src/shared/queues/redisStreams");
const {
  POWERUP_RECALC_VERSION,
} = require("../../../src/shared/queues/workMessages");
const {
  buildPowerupRecalcStreamWorker,
} = require("../../../src/modules/powerups/jobs/powerupRecalcStreamWorker");

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

  it("recovers after DB commit + downstream publish failure without losing RACE_DIRTY or duplicating the box", async () => {
    const { user } = await createTestUser();
    const { race, participant } = await seedRace({ userId: user.id });
    const worker = workerForSteps(user.id, 5000);

    await publishRecalc({
      raceId: race.id,
      userId: user.id,
      participantId: participant.id,
    });
    const [entry] = await readRecalc("powerup-first-attempt");
    assert.ok(entry);

    const deadPort = await closedPort();
    await closeQueueRedis();
    process.env.REDIS_URL = `redis://127.0.0.1:${deadPort}/15`;

    assert.equal(
      await worker.processEntry(entry),
      false,
      "downstream publish failure must leave the original message unacked",
    );

    assert.equal(
      await prisma.racePowerup.count({ where: { participantId: participant.id } }),
      1,
      "the first attempt committed the box before the downstream failure",
    );

    await closeQueueRedis();
    process.env.REDIS_URL = redisUrl;

    assert.equal(
      (await pendingSummary(STREAMS.POWERUP_RECALC, GROUPS.POWERUP_RECALC)).count,
      1,
      "failed work must remain pending for reclaim",
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    const reclaimed = await reclaimIdle({
      stream: STREAMS.POWERUP_RECALC,
      group: GROUPS.POWERUP_RECALC,
      consumer: "powerup-retry",
      minIdleMs: 1,
      count: 10,
    });
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0].id, entry.id);

    assert.equal(await worker.processEntry(reclaimed[0]), true);

    assert.equal(
      await prisma.racePowerup.count({ where: { participantId: participant.id } }),
      1,
      "retry must not mint the threshold twice",
    );
    assert.equal(
      await raceDirtyCount(),
      1,
      "retry must recover the downstream race handoff that failed after the DB commit",
    );
    assert.equal(
      (await pendingSummary(STREAMS.POWERUP_RECALC, GROUPS.POWERUP_RECALC)).count,
      0,
      "recovered work must eventually ACK",
    );
  });
});
