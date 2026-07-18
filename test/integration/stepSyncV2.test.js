const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  getSharedServer,
  cleanDatabase,
  createTestUser,
  request,
  prisma,
} = require("./setup");

const uuid = () => crypto.randomUUID();
const bodyFor = (steps) => ({ date: "2026-07-17", steps, samples: [] });

describe("POST /steps/sync-v2 (integration)", () => {
  let baseUrl;
  before(async () => {
    baseUrl = (await getSharedServer()).baseUrl;
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("persists steps, returns 202 CURRENT, and creates a COMPLETE reservation + QUEUED job", async () => {
    const { token, user } = await createTestUser();
    const key = uuid();
    const res = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": key },
      body: bodyFor(12345),
    });
    assert.equal(res.status, 202);
    const json = await res.json();
    assert.equal(json.record.steps, 12345);
    assert.equal(json.record.stepGoal, 5000); // 1.1.4 compat default
    assert.equal(json.uploaderReconciliation.state, "CURRENT");
    assert.equal(json.uploaderReconciliation.resolvedRaceCount, 0); // no active races
    assert.equal(json.raceResolution.state, "QUEUED");
    assert.equal(json.raceResolution.generation, 1);
    assert.ok(json.raceResolution.jobId);

    const step = await prisma.step.findUnique({
      where: { userId_date: { userId: user.id, date: new Date("2026-07-17") } },
    });
    assert.equal(step.steps, 12345);

    const reservation = await prisma.stepSyncRequest.findUnique({
      where: { userId_idempotencyKey: { userId: user.id, idempotencyKey: key } },
    });
    assert.equal(reservation.state, "COMPLETE");
    assert.equal(reservation.resolutionTimeZone, "America/New_York"); // default tz

    const job = await prisma.raceResolutionJob.findUnique({ where: { userId: user.id } });
    assert.equal(job.state, "QUEUED");
    assert.equal(job.generation, 1);
  });

  it("same-key replay with equivalent input returns the stored response and does not bump the generation", async () => {
    const { token, user } = await createTestUser();
    const key = uuid();
    const first = await (
      await request(baseUrl, "POST", "/steps/sync-v2", {
        token,
        headers: { "Idempotency-Key": key },
        body: bodyFor(500),
      })
    ).json();

    const replay = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": key },
      body: bodyFor(500),
    });
    assert.equal(replay.status, 202);
    const replayJson = await replay.json();
    assert.deepEqual(replayJson, first);

    const job = await prisma.raceResolutionJob.findUnique({ where: { userId: user.id } });
    assert.equal(job.generation, 1); // NOT incremented by a replay
  });

  it("same key with different canonical input returns 409 IDEMPOTENCY_CONFLICT", async () => {
    const { token } = await createTestUser();
    const key = uuid();
    await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": key },
      body: bodyFor(500),
    });
    const conflict = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": key },
      body: bodyFor(999),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, "IDEMPOTENCY_CONFLICT");
  });

  it("a fresh key coalesces into the one per-user job and bumps the generation", async () => {
    const { token, user } = await createTestUser();
    await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": uuid() },
      body: bodyFor(100),
    });
    const second = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": uuid() },
      body: bodyFor(200),
    });
    const secondJson = await second.json();
    assert.equal(secondJson.raceResolution.generation, 2);

    const jobs = await prisma.raceResolutionJob.findMany({ where: { userId: user.id } });
    assert.equal(jobs.length, 1); // ONE row per user (coalesced)
    assert.equal(jobs[0].generation, 2);
  });

  it("a non-UUID idempotency key is rejected 400 INVALID_STEP_SYNC", async () => {
    const { token } = await createTestUser();
    const res = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": "not-a-uuid" },
      body: bodyFor(100),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "INVALID_STEP_SYNC");
  });

  it("owner-only status endpoint returns the job state; a foreign job is a non-leaking 404", async () => {
    const { token, user } = await createTestUser();
    const post = await (
      await request(baseUrl, "POST", "/steps/sync-v2", {
        token,
        headers: { "Idempotency-Key": uuid() },
        body: bodyFor(100),
      })
    ).json();
    const jobId = post.raceResolution.jobId;

    const ok = await request(baseUrl, "GET", `/steps/race-resolution/${jobId}?generation=1`, { token });
    assert.equal(ok.status, 200);
    const okJson = await ok.json();
    assert.ok(["QUEUED", "RUNNING", "SUCCEEDED"].includes(okJson.raceResolution.state));

    const { token: otherToken } = await createTestUser();
    const forbidden = await request(baseUrl, "GET", `/steps/race-resolution/${jobId}?generation=1`, {
      token: otherToken,
    });
    assert.equal(forbidden.status, 404);
  });
});
