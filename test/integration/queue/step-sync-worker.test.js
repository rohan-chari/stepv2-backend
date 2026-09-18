const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { after, afterEach, before, beforeEach, describe, it } = require("node:test");
const IORedis = require("ioredis");
const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
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
  ensureGroup,
  readGroup,
  reclaimIdle,
  pendingSummary,
  close: closeQueueRedis,
} = require("../../../src/shared/queues/redisStreams");
const {
  buildStepSyncStreamWorker,
} = require("../../../src/modules/steps/jobs/stepSyncStreamWorker");

let server;
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

function dateKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function sampleWindow(steps = 1000, minutesAgo = 10) {
  const end = new Date(Date.now() - minutesAgo * 60 * 1000);
  const start = new Date(end.getTime() - 5 * 60 * 1000);
  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    steps,
  };
}

async function queueSync(token, {
  key = crypto.randomUUID(),
  steps = 1000,
  samples = [sampleWindow(1000)],
} = {}) {
  return request(server.baseUrl, "POST", "/steps/sync-v2", {
    token,
    headers: {
      "Idempotency-Key": key,
      "X-App-Version": "9.9.9",
    },
    body: {
      date: dateKey(),
      steps,
      samples,
    },
    drainQueue: false,
  });
}

async function createRaceForUser(userId, {
  powerupsEnabled = false,
  powerupStepInterval = null,
  forfeited = false,
  name = "STEP_SYNC fanout",
} = {}) {
  const startedAt = new Date(Date.now() - 60 * 60 * 1000);
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
      powerupsEnabled,
      powerupStepInterval,
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
      nextBoxAtSteps: powerupsEnabled && powerupStepInterval
        ? powerupStepInterval
        : null,
      forfeitedAt: forfeited ? new Date() : null,
    },
  });
  return { race, participant };
}

async function readStepEntries(consumer = "step-sync-worker-test", count = 10) {
  return readGroup({
    stream: STREAMS.STEP_SYNC,
    group: GROUPS.STEP_SYNC,
    consumer,
    count,
    blockMs: 5,
  });
}

async function streamEntries(stream) {
  return inspector.xrange(streamName(stream), "-", "+");
}

function worker() {
  return buildStepSyncStreamWorker({
    logger: { log() {}, warn() {}, error() {} },
    findHistoricalRaces: async () => ({ rows: [], nextCursor: null }),
  });
}

describe("STEP_SYNC queue worker core behavior", () => {
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

    process.env.REDIS_URL = redisUrl;
    server = await getSharedServer();
    inspector = new IORedis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    await inspector.connect();
  });

  beforeEach(async () => {
    if (!redisUrl) return;
    await closeQueueRedis();
    testPrefix = `${originalPrefix || "integration:"}step-worker:${crypto.randomUUID()}:`;
    process.env.REDIS_URL = redisUrl;
    process.env.CACHE_ENV_PREFIX = testPrefix;
    await cleanDatabase();
    await ensureGroup(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC);
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

  it("fans one committed sync out to every active race and only eligible powerup races", async () => {
    const { user, token } = await createTestUser();
    const plain = await createRaceForUser(user.id, {
      powerupsEnabled: false,
      name: "plain",
    });
    const powerup = await createRaceForUser(user.id, {
      powerupsEnabled: true,
      powerupStepInterval: 5000,
      name: "powerup",
    });
    const forfeited = await createRaceForUser(user.id, {
      powerupsEnabled: true,
      powerupStepInterval: 5000,
      forfeited: true,
      name: "forfeited",
    });

    const response = await queueSync(token, {
      steps: 1200,
      samples: [sampleWindow(1200)],
    });
    assert.equal(response.status, 202);

    const [entry] = await readStepEntries();
    assert.ok(entry);
    assert.equal(await worker().processEntry(entry), true);

    const raceDirty = await streamEntries(STREAMS.RACE_DIRTY);
    assert.equal(raceDirty.length, 3);
    const dirtyRaceIds = raceDirty
      .map(([, fields]) => fields[fields.indexOf("raceId") + 1])
      .sort();
    assert.deepEqual(
      dirtyRaceIds,
      [plain.race.id, powerup.race.id, forfeited.race.id].sort(),
    );

    const powerupRecalc = await streamEntries(STREAMS.POWERUP_RECALC);
    assert.equal(powerupRecalc.length, 1);
    const fields = powerupRecalc[0][1];
    assert.equal(fields[fields.indexOf("raceId") + 1], powerup.race.id);
    assert.equal(fields[fields.indexOf("participantId") + 1], powerup.participant.id);

    assert.equal(
      (await pendingSummary(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC)).count,
      0,
    );
  });

  it("recovers after source commit when downstream Redis publishing fails", async () => {
    const { user, token } = await createTestUser();
    const { race } = await createRaceForUser(user.id, {
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    });
    const key = crypto.randomUUID();
    const response = await queueSync(token, {
      key,
      steps: 1500,
      samples: [sampleWindow(1500)],
    });
    assert.equal(response.status, 202);

    const [entry] = await readStepEntries("step-first-attempt");
    assert.ok(entry);

    const deadPort = await closedPort();
    await closeQueueRedis();
    process.env.REDIS_URL = `redis://127.0.0.1:${deadPort}/15`;

    const firstAttempt = worker();
    assert.equal(
      await firstAttempt.processEntry(entry),
      false,
      "downstream publish failure must leave STEP_SYNC pending",
    );

    const committedRequest = await prisma.stepSyncRequest.findFirstOrThrow({
      where: { userId: user.id, idempotencyKey: key },
    });
    assert.equal(committedRequest.state, "COMPLETE");
    assert.equal(await prisma.stepSample.count({ where: { userId: user.id } }), 1);

    const generationBeforeRetry =
      await prisma.userScoringInputVersion.findUniqueOrThrow({
        where: { userId: user.id },
      });

    await closeQueueRedis();
    process.env.REDIS_URL = redisUrl;

    assert.equal(
      (await pendingSummary(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC)).count,
      1,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    const reclaimed = await reclaimIdle({
      stream: STREAMS.STEP_SYNC,
      group: GROUPS.STEP_SYNC,
      consumer: "step-retry",
      minIdleMs: 1,
      count: 10,
    });
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0].id, entry.id);

    assert.equal(await worker().processEntry(reclaimed[0]), true);

    assert.equal(
      await prisma.stepSample.count({ where: { userId: user.id } }),
      1,
      "retry must not duplicate source samples",
    );
    const generationAfterRetry =
      await prisma.userScoringInputVersion.findUniqueOrThrow({
        where: { userId: user.id },
      });
    assert.equal(
      String(generationAfterRetry.generation),
      String(generationBeforeRetry.generation),
      "retry must not bump scoring generation twice",
    );

    const raceDirty = await streamEntries(STREAMS.RACE_DIRTY);
    const powerupRecalc = await streamEntries(STREAMS.POWERUP_RECALC);
    assert.equal(raceDirty.length, 1);
    assert.equal(powerupRecalc.length, 1);
    const raceFields = raceDirty[0][1];
    assert.equal(raceFields[raceFields.indexOf("raceId") + 1], race.id);

    assert.equal(
      (await pendingSummary(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC)).count,
      0,
    );
  });

  it("a same-key replay never duplicates the committed source write or generation", async () => {
    const { user, token } = await createTestUser();
    const key = crypto.randomUUID();
    const sample = sampleWindow(800);

    const first = await queueSync(token, {
      key,
      steps: 800,
      samples: [sample],
    });
    const second = await queueSync(token, {
      key,
      steps: 800,
      samples: [sample],
    });
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);

    const entries = await readStepEntries("step-replay", 10);
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.equal(await worker().processEntry(entry), true);
    }

    assert.equal(
      await prisma.stepSyncRequest.count({
        where: { userId: user.id, idempotencyKey: key },
      }),
      1,
    );
    assert.equal(await prisma.stepSample.count({ where: { userId: user.id } }), 1);
    const version = await prisma.userScoringInputVersion.findUniqueOrThrow({
      where: { userId: user.id },
    });
    assert.equal(String(version.generation), "1");
  });

  it("an older same-user sync processed after a newer sync cannot overwrite newer state", async () => {
    const { user, token } = await createTestUser();
    const olderSample = sampleWindow(1000, 20);
    const newerSample = sampleWindow(2000, 10);

    const older = await queueSync(token, {
      key: crypto.randomUUID(),
      steps: 1000,
      samples: [olderSample],
    });
    const newer = await queueSync(token, {
      key: crypto.randomUUID(),
      steps: 2000,
      samples: [newerSample],
    });
    assert.equal(older.status, 202);
    assert.equal(newer.status, 202);

    const entries = await readStepEntries("step-out-of-order", 10);
    assert.equal(entries.length, 2);

    // Explicitly reverse queue order to model retry/reclaim or another worker
    // allowing the newer payload to commit before the older one.
    assert.equal(await worker().processEntry(entries[1]), true);
    assert.equal(await worker().processEntry(entries[0]), true);

    const daily = await prisma.steps.findFirstOrThrow({
      where: { userId: user.id, date: new Date(dateKey()) },
    });
    assert.equal(
      daily.steps,
      2000,
      "older payload must never roll the canonical daily total backward",
    );

    const samples = await prisma.stepSample.findMany({
      where: { userId: user.id },
      orderBy: { periodStart: "asc" },
    });
    assert.equal(samples.length, 2);
    assert.deepEqual(samples.map((sample) => sample.steps), [1000, 2000]);
  });
});
