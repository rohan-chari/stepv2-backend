const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { before, beforeEach, describe, it } = require("node:test");
const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  createTestUser,
  drainQueueFirstWork,
} = require("../setup");
const { publish, STREAMS } = require("../../../src/shared/queues/redisStreams");

let server;

function dateKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function sampleWindow(steps = 1000) {
  const end = new Date(Date.now() - 5 * 60 * 1000);
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
    headers: { "Idempotency-Key": key, "X-App-Version": "9.9.9" },
    body: { date: dateKey(), steps, samples },
    drainQueue: false,
  });
}

async function activeRaceFor(userId) {
  const startedAt = new Date(Date.now() - 60 * 60 * 1000);
  const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const race = await prisma.race.create({
    data: {
      creatorId: userId,
      name: "Queue-first integration",
      targetSteps: 100000,
      status: "ACTIVE",
      isPublic: false,
      timeBased: true,
      maxDurationDays: 1,
      timezone: "UTC",
      powerupsEnabled: false,
      startedAt,
      endsAt,
    },
  });
  const participant = await prisma.raceParticipant.create({
    data: {
      raceId: race.id,
      userId,
      status: "ACCEPTED",
      joinedAt: startedAt,
      totalSteps: 0,
    },
  });
  return { race, participant };
}

describe("queue-first step and race pipeline", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("returns 202 before Postgres persistence, then commits through STEP_SYNC", async () => {
    const { user, token } = await createTestUser();
    const response = await queueSync(token);
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.state, "QUEUED");

    assert.equal(
      await prisma.stepSyncRequest.count({ where: { userId: user.id } }),
      0,
      "HTTP intake must not synchronously persist the source transaction",
    );
    assert.equal(
      await prisma.stepSample.count({ where: { userId: user.id } }),
      0,
    );

    await drainQueueFirstWork();

    const requestRow = await prisma.stepSyncRequest.findFirstOrThrow({
      where: { userId: user.id },
    });
    assert.equal(requestRow.state, "COMPLETE");
    assert.equal(await prisma.stepSample.count({ where: { userId: user.id } }), 1);
  });

  it("replayed STEP_SYNC delivery is idempotent", async () => {
    const { user, token } = await createTestUser();
    const key = crypto.randomUUID();
    const sample = sampleWindow(700);

    const first = await queueSync(token, { key, steps: 700, samples: [sample] });
    const second = await queueSync(token, { key, steps: 700, samples: [sample] });
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);

    await drainQueueFirstWork();

    assert.equal(
      await prisma.stepSyncRequest.count({
        where: { userId: user.id, idempotencyKey: key },
      }),
      1,
    );
    assert.equal(await prisma.stepSample.count({ where: { userId: user.id } }), 1);

    const generation = await prisma.userScoringInputVersion.findUniqueOrThrow({
      where: { userId: user.id },
    });
    await drainQueueFirstWork();
    const replayed = await prisma.userScoringInputVersion.findUniqueOrThrow({
      where: { userId: user.id },
    });
    assert.equal(String(replayed.generation), String(generation.generation));
  });

  it("STEP_SYNC dirties an active race and the Race Worker writes the final score", async () => {
    const { user, token } = await createTestUser();
    const { race } = await activeRaceFor(user.id);
    const sample = sampleWindow(1000);

    const response = await queueSync(token, {
      steps: 1000,
      samples: [sample],
    });
    assert.equal(response.status, 202);

    const before = await prisma.raceParticipant.findFirstOrThrow({
      where: { raceId: race.id, userId: user.id },
    });
    assert.equal(before.totalSteps, 0);

    await drainQueueFirstWork();

    const after = await prisma.raceParticipant.findFirstOrThrow({
      where: { raceId: race.id, userId: user.id },
    });
    assert.equal(after.totalSteps, 1000);
    assert.equal(
      await prisma.raceResolutionJobV2.count({ where: { raceId: race.id } }),
      1,
    );
  });

  it("duplicate RACE_DIRTY delivery does not double-apply race scoring", async () => {
    const { user, token } = await createTestUser();
    const { race } = await activeRaceFor(user.id);
    const response = await queueSync(token, {
      steps: 1200,
      samples: [sampleWindow(1200)],
    });
    assert.equal(response.status, 202);
    await drainQueueFirstWork();

    const generation = await prisma.userScoringInputVersion.findUniqueOrThrow({
      where: { userId: user.id },
    });
    const before = await prisma.raceParticipant.findFirstOrThrow({
      where: { raceId: race.id, userId: user.id },
    });

    const message = {
      schemaVersion: 1,
      raceId: race.id,
      userId: user.id,
      timeZone: "UTC",
      sourceGeneration: String(generation.generation),
      reason: "TEST_REPLAY",
      requestedAt: new Date().toISOString(),
    };
    await publish(STREAMS.RACE_DIRTY, message);
    await publish(STREAMS.RACE_DIRTY, message);
    await drainQueueFirstWork();

    const after = await prisma.raceParticipant.findFirstOrThrow({
      where: { raceId: race.id, userId: user.id },
    });
    assert.equal(after.totalSteps, before.totalSteps);
    assert.equal(
      await prisma.raceResolutionJobV2.count({ where: { raceId: race.id } }),
      1,
    );
  });
});
