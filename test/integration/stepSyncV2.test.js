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

// POST /steps/sync-v2 — the durable async sync contract.
//
// UPDATED FOR C0 (docs/redis-derived-data-layer-requirements.md §5a): the
// resolution queue is keyed by RACE, not by user. A sync therefore enqueues one
// `race_resolution_jobs_v2` row per ACTIVE race the uploader is in, appending
// the uploader to that job's `triggeredByUserIds`, and a user with no active
// races enqueues nothing at all (there is nothing to resolve).
//
// The wire contract is unchanged and is asserted here for frozen clients:
// `raceResolution` is still an object with `jobId` / `generation` / `state` /
// `requestedAt`, still reports ONE job (the uploader's lexicographically-first
// active race — the one `GET /steps/race-resolution/:jobId` polls), and now
// carries `jobId: null` when there is no race to resolve. The shipped client
// already models `jobId` as nullable (backend_api_service.dart parses it as
// `rawJobId is String && isNotEmpty ? … : null`) and simply skips its poll.

const uuid = () => crypto.randomUUID();
const { appSettings } = require("../../src/shared/config/appSettings");
const bodyFor = (steps) => ({ date: "2026-07-17", steps, samples: [] });

const HOUR_MS = 60 * 60 * 1000;

async function activeRaceWith(userId, name) {
  const startedAt = new Date(Date.now() - 3 * HOUR_MS);
  const race = await prisma.race.create({
    data: {
      creatorId: userId,
      name,
      targetSteps: 0,
      isPublic: false,
      timeBased: true,
      timezone: "UTC",
      maxParticipants: 10,
      maxDurationDays: 7,
      status: "ACTIVE",
      startedAt,
      endsAt: new Date(Date.now() + 24 * HOUR_MS),
      potCoins: 0,
    },
    select: { id: true },
  });
  await prisma.raceParticipant.create({
    data: { raceId: race.id, userId, status: "ACCEPTED", joinedAt: startedAt },
  });
  return race.id;
}

function jobsForRace(raceId) {
  return prisma.$queryRawUnsafe(
    `SELECT race_id AS "raceId", generation, state::text AS state,
            triggered_by_user_ids AS "triggeredByUserIds"
     FROM race_resolution_jobs_v2 WHERE race_id = $1`,
    raceId
  );
}

describe("POST /steps/sync-v2 (integration)", () => {
  let baseUrl;
  before(async () => {
    baseUrl = (await getSharedServer()).baseUrl;
  });
  beforeEach(async () => {
    await cleanDatabase();
    await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", false);
    await appSettings.setFlag("raceResolutionBurstCoalescingV1Enabled", false);
  });

  it("coalescing uses a fixed five-second window that later syncs cannot extend", async () => {
    const { token, user } = await createTestUser();
    const raceId = await activeRaceWith(user.id, "Fixed coalescing race");
    await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);
    await appSettings.setFlag("raceResolutionBurstCoalescingV1Enabled", true);

    const firstRequestedAt = new Date();
    const first = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": uuid() },
      body: bodyFor(100),
    });
    assert.equal(first.status, 202);
    const [firstJob] = await prisma.$queryRawUnsafe(
      `SELECT not_before_at AS "notBeforeAt" FROM race_resolution_jobs_v2 WHERE race_id = $1`,
      raceId
    );
    assert.ok(firstJob.notBeforeAt >= firstRequestedAt);
    assert.ok(firstJob.notBeforeAt.getTime() <= firstRequestedAt.getTime() + 5500);

    const second = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": uuid() },
      body: bodyFor(101),
    });
    assert.equal(second.status, 202);
    const [secondJob] = await prisma.$queryRawUnsafe(
      `SELECT not_before_at AS "notBeforeAt" FROM race_resolution_jobs_v2 WHERE race_id = $1`,
      raceId
    );
    assert.equal(secondJob.notBeforeAt.toISOString(), firstJob.notBeforeAt.toISOString());
  });

  it("reason-aware sync atomically bumps the scoring token and enqueues bounded STEP_SYNC scope", async () => {
    const { token, user } = await createTestUser();
    const raceId = await activeRaceWith(user.id, "Reason-aware sync race");
    await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);

    const res = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": uuid() },
      body: bodyFor(2468),
    });
    assert.equal(res.status, 202);

    const [version] = await prisma.$queryRawUnsafe(
      `SELECT generation FROM user_scoring_input_versions WHERE user_id = $1`,
      user.id
    );
    assert.equal(Number(version.generation), 1);

    const [job] = await prisma.$queryRawUnsafe(
      `SELECT dirty_reasons AS "dirtyReasons",
              dirty_participant_ids AS "dirtyParticipantIds",
              dirty_priority AS "dirtyPriority"
       FROM race_resolution_jobs_v2 WHERE race_id = $1`,
      raceId
    );
    const participant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId, userId: user.id } },
      select: { id: true },
    });
    assert.deepEqual(job.dirtyReasons, ["STEP_SYNC"]);
    assert.deepEqual(job.dirtyParticipantIds, [participant.id]);
    assert.equal(job.dirtyPriority, "COALESCE");
  });

  it("persists steps, returns 202 CURRENT, and completes the reservation", async () => {
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

    const step = await prisma.step.findUnique({
      where: { userId_date: { userId: user.id, date: new Date("2026-07-17") } },
    });
    assert.equal(step.steps, 12345);

    const reservation = await prisma.stepSyncRequest.findUnique({
      where: { userId_idempotencyKey: { userId: user.id, idempotencyKey: key } },
    });
    assert.equal(reservation.state, "COMPLETE");
    assert.equal(reservation.resolutionTimeZone, "America/New_York"); // default tz
  });

  it("with NO active races: enqueues nothing and returns a frozen-client-safe raceResolution with jobId null", async () => {
    const { token } = await createTestUser();
    const res = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": uuid() },
      body: bodyFor(700),
    });
    assert.equal(res.status, 202);
    const json = await res.json();

    // Shape a frozen binary can parse without crashing: the object is present,
    // `state` is still the QUEUED string it always was, `requestedAt` still
    // parses as a date, and `jobId` is null rather than absent.
    assert.equal(typeof json.raceResolution, "object");
    assert.notEqual(json.raceResolution, null);
    assert.ok("jobId" in json.raceResolution);
    assert.equal(json.raceResolution.jobId, null);
    assert.equal(json.raceResolution.generation, null);
    assert.equal(json.raceResolution.state, "QUEUED");
    assert.ok(!Number.isNaN(new Date(json.raceResolution.requestedAt).getTime()));

    const jobCount = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS c FROM race_resolution_jobs_v2`
    );
    assert.equal(jobCount[0].c, 0, "nothing to resolve => nothing enqueued");
  });

  it("enqueues one RACE-keyed job per active race of the uploader, with the uploader in triggeredByUserIds", async () => {
    const { token, user } = await createTestUser();
    const raceA = await activeRaceWith(user.id, "AAA race");
    const raceB = await activeRaceWith(user.id, "BBB race");

    const res = await request(baseUrl, "POST", "/steps/sync-v2", {
      token,
      headers: { "Idempotency-Key": uuid() },
      body: bodyFor(4321),
    });
    assert.equal(res.status, 202);
    const json = await res.json();

    for (const raceId of [raceA, raceB]) {
      const [job] = await jobsForRace(raceId);
      assert.ok(job, `race ${raceId} was enqueued`);
      assert.equal(job.generation, 1);
      assert.equal(job.state, "queued");
      assert.deepEqual(
        job.triggeredByUserIds,
        [user.id],
        "the uploader is recorded so the worker computes THEIR box state"
      );
    }

    // Exactly two rows — race-keyed, never one per user.
    const all = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS c FROM race_resolution_jobs_v2`
    );
    assert.equal(all[0].c, 2);

    // The response reports one pollable job: the lexicographically-first race's.
    const reported = [raceA, raceB].sort((a, b) => a.localeCompare(b))[0];
    const [reportedJob] = await jobsForRace(reported);
    assert.ok(json.raceResolution.jobId);
    assert.equal(json.raceResolution.generation, 1);
    assert.equal(json.raceResolution.state, "QUEUED");
    const rows = await prisma.$queryRawUnsafe(
      `SELECT race_id AS "raceId" FROM race_resolution_jobs_v2 WHERE id = $1`,
      json.raceResolution.jobId
    );
    assert.equal(rows[0].raceId, reported);
    assert.equal(reportedJob.generation, json.raceResolution.generation);
  });

  it("can defer active-race reconciliation to the durable worker without changing the response shape", async () => {
    const { token, user } = await createTestUser();
    const raceId = await activeRaceWith(user.id, "Deferred reconciliation race");
    const previous = process.env.SYNC_V2_INLINE_UPLOADER_RECONCILIATION;
    process.env.SYNC_V2_INLINE_UPLOADER_RECONCILIATION = "false";
    try {
      const res = await request(baseUrl, "POST", "/steps/sync-v2", {
        token,
        headers: { "Idempotency-Key": uuid() },
        body: bodyFor(4321),
      });
      assert.equal(res.status, 202);
      const json = await res.json();

      // Frozen clients already model DEFERRED: they fetch a live home card
      // while the race-keyed worker performs the authoritative reconciliation.
      assert.deepEqual(json.uploaderReconciliation, {
        state: "DEFERRED",
        resolvedRaceCount: 0,
        boxStateCurrent: false,
      });
      assert.ok(json.raceResolution.jobId);

      const [job] = await jobsForRace(raceId);
      assert.ok(job);
      assert.equal(job.state, "queued");
      assert.deepEqual(job.triggeredByUserIds, [user.id]);
    } finally {
      if (previous == null) {
        delete process.env.SYNC_V2_INLINE_UPLOADER_RECONCILIATION;
      } else {
        process.env.SYNC_V2_INLINE_UPLOADER_RECONCILIATION = previous;
      }
    }
  });

  it("same-key replay with equivalent input returns the stored response and does not bump the generation", async () => {
    const { token, user } = await createTestUser();
    const raceId = await activeRaceWith(user.id, "Replay race");
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

    const [job] = await jobsForRace(raceId);
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

  it("a fresh key coalesces into the SAME race job and bumps its generation", async () => {
    const { token, user } = await createTestUser();
    const raceId = await activeRaceWith(user.id, "Coalesce race");

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

    const jobs = await jobsForRace(raceId);
    assert.equal(jobs.length, 1); // ONE row per RACE (coalesced)
    assert.equal(jobs[0].generation, 2);
    assert.deepEqual(jobs[0].triggeredByUserIds, [user.id]);
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

  it("status endpoint returns the job state to a participant; a non-participant is a non-leaking 404", async () => {
    const { token, user } = await createTestUser();
    await activeRaceWith(user.id, "Status race");
    const post = await (
      await request(baseUrl, "POST", "/steps/sync-v2", {
        token,
        headers: { "Idempotency-Key": uuid() },
        body: bodyFor(100),
      })
    ).json();
    const jobId = post.raceResolution.jobId;
    assert.ok(jobId, "an active race means there IS a job to poll");

    const ok = await request(
      baseUrl,
      "GET",
      `/steps/race-resolution/${jobId}?generation=1`,
      { token }
    );
    assert.equal(ok.status, 200);
    const okJson = await ok.json();
    assert.ok(
      ["QUEUED", "RUNNING", "SUCCEEDED"].includes(okJson.raceResolution.state)
    );

    // Ownership is now "is a participant of the job's race" — the job is no
    // longer keyed by a single user. An outsider still gets a bare 404.
    const { token: otherToken } = await createTestUser();
    const forbidden = await request(
      baseUrl,
      "GET",
      `/steps/race-resolution/${jobId}?generation=1`,
      { token: otherToken }
    );
    assert.equal(forbidden.status, 404);
  });
});
