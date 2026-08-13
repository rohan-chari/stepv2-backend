const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");

const body = (steps) => ({ date: "2026-08-12", steps, samples: [] });
const key = () => crypto.randomUUID();
const homePull = { "X-Step-Sync-Intent": "home-pull" };

async function activeRaceFor(userId) {
  const race = await prisma.race.create({
    data: {
      creatorId: userId,
      name: "Cooldown race",
      targetSteps: 0,
      timeBased: true,
      maxDurationDays: 1,
      status: "ACTIVE",
      startedAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 86_400_000),
    },
  });
  await prisma.raceParticipant.create({
    data: { raceId: race.id, userId, status: "ACCEPTED" },
  });
  return race.id;
}

async function jobGeneration(raceId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT generation FROM race_resolution_jobs_v2 WHERE race_id = $1`,
    raceId
  );
  return rows[0]?.generation ?? null;
}

describe("Home pull step-sync cooldown (integration)", () => {
  let baseUrl;
  before(async () => {
    baseUrl = (await getSharedServer()).baseUrl;
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("stamps the first exact home-pull, then returns the no-work 429 contract", async () => {
    const { user, token } = await createTestUser();
    const raceId = await activeRaceFor(user.id);
    const first = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": key(), ...homePull },
      body: body(100),
    });
    assert.equal(first.status, 202);
    const stamp = await prisma.$queryRawUnsafe(
      `SELECT last_home_pull_step_sync_at AS "lastHomePullStepSyncAt" FROM users WHERE id = $1`,
      user.id
    );
    assert.ok(stamp[0].lastHomePullStepSyncAt instanceof Date);
    assert.equal(await jobGeneration(raceId), 1);

    const rejected = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": key(), ...homePull },
      body: body(200),
    });
    assert.equal(rejected.status, 429);
    assert.equal(rejected.headers.get("cache-control"), "no-store");
    assert.match(rejected.headers.get("retry-after") || "", /^(?:[1-9]|[12][0-9]|30)$/);
    assert.deepEqual(await rejected.json(), {
      error: "Step sync is cooling down",
      code: "STEP_SYNC_COOLDOWN",
      retryAfterSeconds: 30,
    });
    assert.equal(await jobGeneration(raceId), 1, "cooldown does not enqueue");
    const saved = await prisma.step.findUnique({
      where: { userId_date: { userId: user.id, date: new Date("2026-08-12") } },
    });
    assert.equal(saved.steps, 100, "cooldown does not write steps");
  });

  it("replays an accepted same-key request before cooldown admission", async () => {
    const { user, token } = await createTestUser();
    const raceId = await activeRaceFor(user.id);
    const idempotencyKey = key();
    const first = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": idempotencyKey, ...homePull },
      body: body(100),
    });
    assert.equal(first.status, 202);
    const firstBody = await first.json();
    const replay = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": idempotencyKey, ...homePull },
      body: body(100),
    });
    assert.equal(replay.status, 202);
    assert.deepEqual(await replay.json(), firstBody);
    assert.equal(await jobGeneration(raceId), 1);
  });

  it("recovers an expired same-key reservation before cooldown admission", async () => {
    const { user, token } = await createTestUser();
    const idempotencyKey = key();
    const first = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": idempotencyKey, ...homePull },
      body: body(100),
    });
    assert.equal(first.status, 202);
    // Simulate the ambiguous-response recovery path after Transaction A. A
    // retry with this same key must recover/replay—not be rejected as a fresh
    // cooldown attempt.
    await prisma.stepSyncRequest.update({
      where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } },
      data: { state: "PROCESSING", leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    const recovered = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": idempotencyKey, ...homePull },
      body: body(100),
    });
    assert.equal(recovered.status, 202);
  });

  it("admits an exact home-pull after the 30-second window", async () => {
    const { user, token } = await createTestUser();
    await prisma.$executeRawUnsafe(
      `UPDATE users SET last_home_pull_step_sync_at = CURRENT_TIMESTAMP - INTERVAL '31 seconds' WHERE id = $1`,
      user.id
    );
    const res = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": key(), ...homePull },
      body: body(500),
    });
    assert.equal(res.status, 202);
  });

  it("is opt-in only and atomically admits exactly one concurrent exact home-pull", async () => {
    const { user, token } = await createTestUser();
    const [a, b] = await Promise.all(
      [key(), key()].map((idempotencyKey, index) =>
        request(baseUrl, "POST", "/steps/sync-v2", {
          token,
          headers: { "Idempotency-Key": idempotencyKey, ...homePull },
          body: body(100 + index),
        })
      )
    );
    assert.deepEqual([a.status, b.status].sort(), [202, 429]);

    const headerless = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": key() },
      body: body(300),
    });
    assert.equal(headerless.status, 202, "old clients remain unrestricted");
    const otherIntent = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": key(), "X-Step-Sync-Intent": "HOME-PULL" },
      body: body(400),
    });
    assert.equal(otherIntent.status, 202, "only exact lowercase intent opts in");
    const row = await prisma.$queryRawUnsafe(
      `SELECT last_home_pull_step_sync_at AS "lastHomePullStepSyncAt" FROM users WHERE id = $1`,
      user.id
    );
    assert.ok(row[0].lastHomePullStepSyncAt);
  });

  it("does not stamp an invalid request", async () => {
    const { user, token } = await createTestUser();
    const invalid = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": key(), ...homePull },
      body: { date: "not-a-date", steps: -1, samples: [] },
    });
    assert.equal(invalid.status, 400);
    const row = await prisma.$queryRawUnsafe(
      `SELECT last_home_pull_step_sync_at AS "lastHomePullStepSyncAt" FROM users WHERE id = $1`,
      user.id
    );
    assert.equal(row[0].lastHomePullStepSyncAt, null);
  });
});
