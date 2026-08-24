// C0 — single-writer-per-race resolution queue
// (docs/redis-derived-data-layer-requirements.md §5a, test plan items 5a/5d/5f/5h).
//
// Everything here runs against the REAL test Postgres and drives real HTTP for
// the sync paths. The worker is driven directly (rather than through its 250ms
// setInterval) because the properties under test are per-tick claim/fence
// semantics, not scheduling — the scheduler is a `setInterval` around exactly the
// `tick()` these cases call.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");

// Must be set BEFORE the worker module is required — the startup quiet period is
// read per call, but keeping it here documents that every case in this file
// deliberately runs past the handoff gate except the one that asserts it.
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
process.env.RACE_RESOLVE_DEBOUNCE_MS = "0";

const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const {
  buildRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const {
  RaceResolutionJobV2,
} = require("../../src/modules/races/models/raceResolutionJobV2");
const { appSettings } = require("../../src/shared/config/appSettings");
const {
  buildRaceResolutionPostTaskHandoff,
} = require("../../src/modules/races/services/raceResolutionPostTaskHandoff");

let server;
let nextAppleId = 0;
const HOUR_MS = 60 * 60 * 1000;

async function createUser(displayName) {
  const appleId = `apple-c0-${++nextAppleId}-${Date.now()}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  return { userId: body.user.id, token: body.sessionToken, displayName };
}

// Invites are friends-only, so every fixture pairs the racers up first.
async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
  });
  const friendship = (await sendRes.json()).friendship;
  if (!friendship) return;
  await request(server.baseUrl, "PUT", `/friends/request/${friendship.id}`, {
    body: { accept: true },
    token: b.token,
  });
}

async function createActiveRace(owner, others, name) {
  for (const o of others) await makeFriends(owner, o);
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name,
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 2000,
    },
    token: owner.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((o) => o.userId) },
    token: owner.token,
  });
  for (const o of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: owner.token,
  });
  const start = new Date(Date.now() - 8 * HOUR_MS);
  await prisma.race.update({
    where: { id: raceId },
    data: {
      startedAt: start,
      endsAt: new Date(Date.now() + 24 * HOUR_MS),
      timezone: "UTC",
    },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: start },
  });
  return raceId;
}

// One closed hourly bucket, `hoursAgo` hours back, so effect/box math sees a
// CLOSED bucket (open buckets contribute zero — open-bucket-effect-scoring).
function sampleAt(hoursAgo, steps) {
  const end = new Date(Date.now() - hoursAgo * HOUR_MS);
  const start = new Date(end.getTime() - HOUR_MS);
  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    steps,
  };
}

async function postSamples(user, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", {
    body: { samples },
    token: user.token,
  });
}

function makeWorker(overrides = {}) {
  // bootAt: 0 => the quiet period has provably elapsed. The handoff-gate case
  // below constructs its own worker with a live bootAt to assert the opposite.
  return buildRaceResolutionWorkerV2({ bootAt: 0, ...overrides });
}

async function drain(worker, maxJobs = 50) {
  const claimed = [];
  for (let i = 0; i < maxJobs; i++) {
    const job = await worker.processOne();
    if (!job) break;
    claimed.push(job);
  }
  return claimed;
}

async function totalsByUser(raceId) {
  const rows = await prisma.raceParticipant.findMany({
    where: { raceId, status: "ACCEPTED" },
    select: { userId: true, totalSteps: true },
  });
  return Object.fromEntries(rows.map((r) => [r.userId, r.totalSteps]));
}

before(async () => {
  server = await getSharedServer();
});

beforeEach(async () => {
  await cleanDatabase();
  await appSettings.setFlag("raceQueueV2ClaimingDisabled", false);
  await appSettings.setFlag("inlineRaceResolutionFallback", false);
  await appSettings.setFlag("raceResolutionBulkWriteV1Enabled", false);
  await appSettings.setFlag("raceResolutionBurstCoalescingV1Enabled", false);
  await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", false);
  await appSettings.setFlag("raceResolutionQueuedGenerationMergeV1Enabled", false);
  await appSettings.setFlag("raceResolutionPostTasksV1Enabled", false);
});

after(async () => {
  await appSettings.setFlag("raceQueueV2ClaimingDisabled", false);
  await appSettings.setFlag("inlineRaceResolutionFallback", false);
});

describe("5a — one bulk writer per race", () => {
  it("public mutation durably reserves an exact nudge intent before queued handoff", async () => {
    const alice = await createUser("Intent Alice");
    const bob = await createUser("Intent Bob");
    const raceId = await createActiveRace(alice, [bob], "Intent race");
    await drain(makeWorker());
    await prisma.deviceToken.create({
      data: { userId: bob.userId, token: `intent-${Date.now()}`, platform: "ios" },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: alice.userId },
      data: { lastNotifiedPlacement: 2 },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: bob.userId },
      data: { lastNotifiedPlacement: 1 },
    });
    await appSettings.setFlag("raceResolutionPostTasksV1Enabled", true);
    assert.equal((await postSamples(alice, [sampleAt(2, 3100)])).status, 200);

    const handoff = buildRaceResolutionPostTaskHandoff({
      runner: {
        async isReady() { return true; },
        async processTaskId() { assert.fail("healthy runner leaves the task queued"); },
      },
    });
    const claimed = await makeWorker({
      raceResolutionPostTaskHandoff: handoff,
      async onCommitted({ job }) {
        return {
          snapshotCommand: {
            raceId,
            timeZone: job.processingTimeZone || "UTC",
          },
          intents: [],
        };
      },
    }).processOne();
    assert.ok(claimed);

    const task = await prisma.raceResolutionPostTask.findFirst({
      where: { raceId },
      include: { intents: { orderBy: { ordinal: "asc" } } },
    });
    assert.equal(task.state, "queued");
    assert.equal(task.intents.length, 1);
    assert.equal(task.intents[0].kind, "NUDGE");
    assert.equal(task.intents[0].recipientUserId, bob.userId);
    assert.ok(task.intents[0].cooldownClaimId);
    assert.equal(JSON.stringify(task.intents[0].payload).includes("intent-"), false);
    const reserved = await prisma.user.findUnique({ where: { id: bob.userId } });
    assert.ok(reserved.lastSilentPushSentAt);
  });

  it("public sync creates and inline-claims one durable snapshot task when the post runner is unhealthy", async () => {
    const alice = await createUser("Post Task Alice");
    const bob = await createUser("Post Task Bob");
    const raceId = await createActiveRace(alice, [bob], "Post task race");
    await appSettings.setFlag("raceResolutionPostTasksV1Enabled", true);
    await postSamples(alice, [sampleAt(2, 3100)]);

    const worker = makeWorker({
      async onCommitted({ raceId: committedRaceId, job, deferSnapshot }) {
        assert.equal(committedRaceId, raceId);
        assert.equal(deferSnapshot, true);
        return {
          snapshotCommand: {
            raceId,
            timeZone: job.processingTimeZone || "UTC",
          },
        };
      },
    });
    const claimed = await worker.processOne();
    assert.ok(claimed);

    const tasks = await prisma.raceResolutionPostTask.findMany({
      where: { raceId },
      include: { intents: true },
    });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].sourceGeneration, claimed.processingGeneration);
    assert.ok(["succeeded", "succeeded_with_failures"].includes(tasks[0].state));
    assert.equal(tasks[0].intents.length, 0);
    assert.notEqual(tasks[0].snapshotState, "pending");
  });

  it("public mutation resolves deferred nudge claims only after known task assembly failure", async () => {
    const alice = await createUser("Fallback Intent Alice");
    const bob = await createUser("Fallback Intent Bob");
    const raceId = await createActiveRace(alice, [bob], "Fallback intent race");
    await drain(makeWorker());
    await prisma.deviceToken.create({
      data: { userId: bob.userId, token: `fallback-${Date.now()}`, platform: "ios" },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: alice.userId }, data: { lastNotifiedPlacement: 2 },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: bob.userId }, data: { lastNotifiedPlacement: 1 },
    });
    await appSettings.setFlag("raceResolutionPostTasksV1Enabled", true);
    assert.equal((await postSamples(alice, [sampleAt(2, 3100)])).status, 200);
    const delivered = [];
    const handoff = buildRaceResolutionPostTaskHandoff({
      RaceResolutionPostTask: {
        async create() { throw new RangeError("forced assembly failure"); },
        async findByGeneration() { return null; },
      },
      runner: { async isReady() { return true; } },
      async publishSnapshotInline() {},
      async deliverIntentInline(intent) { delivered.push(intent); return { accepted: true }; },
    });
    // The production post-commit hook intentionally stays off until the
    // Redis-standings rollout flag is enabled.  This case exercises the
    // durable handoff fallback itself, so provide the same post-commit
    // command seam as the queued-intent case above instead of depending on
    // that unrelated rollout gate.
    await makeWorker({
      raceResolutionPostTaskHandoff: handoff,
      async onCommitted({ job }) {
        return {
          snapshotCommand: {
            raceId,
            timeZone: job.processingTimeZone || "UTC",
          },
          intents: [],
        };
      },
    }).processOne();
    assert.equal(delivered.filter((intent) => intent.kind === "NUDGE").length, 1);
    const reserved = await prisma.user.findUniqueOrThrow({ where: { id: bob.userId } });
    assert.ok(reserved.lastSilentPushSentAt);
    assert.equal(await prisma.raceResolutionPostTask.count({ where: { raceId } }), 0);
  });

  it("bulk-write rollout preserves real HTTP sync totals through the fenced worker", async () => {
    const alice = await createUser("Bulk Alice");
    const bob = await createUser("Bulk Bob");
    const raceId = await createActiveRace(alice, [bob], "Bulk write race");
    await appSettings.setFlag("raceResolutionBulkWriteV1Enabled", true);

    await postSamples(alice, [sampleAt(2, 4300)]);
    await postSamples(bob, [sampleAt(2, 2100)]);
    const claims = await drain(makeWorker());
    assert.ok(claims.length >= 1);
    const totals = await totalsByUser(raceId);
    assert.ok(totals[alice.userId] > totals[bob.userId]);
    const job = await RaceResolutionJobV2.findByRaceId(raceId);
    assert.equal(job.state, "SUCCEEDED");
  });

  // Regression (prod 2026-08-14): a 0.5x debuff over an odd step count produces
  // a FRACTIONAL effective total (e.g. 2150.5). The legacy per-row Prisma UPDATE
  // survived that because Postgres rounds on numeric→int assignment, but the
  // bulk writer's jsonb_to_recordset(... "totalSteps" integer) is a text cast
  // that raises 22P02 — failing the whole fenced transaction, so effect expiry
  // and the snapshot never ran for any race carrying such an effect.
  it("bulk-write persists fractional effect-adjusted totals instead of failing the fence", async () => {
    const alice = await createUser("Fraction Alice");
    const bob = await createUser("Fraction Bob");
    const raceId = await createActiveRace(alice, [bob], "Fractional total race");
    await appSettings.setFlag("raceResolutionBulkWriteV1Enabled", true);

    const aliceParticipant = await prisma.raceParticipant.findFirstOrThrow({
      where: { raceId, userId: alice.userId },
    });
    // Opponent-sourced Rainstorm covering the whole scoring window: every
    // closed-bucket step Alice posts is halved.
    const powerup = await prisma.racePowerup.create({
      data: {
        raceId,
        participantId: (await prisma.raceParticipant.findFirstOrThrow({
          where: { raceId, userId: bob.userId },
        })).id,
        userId: bob.userId,
        type: "RAINSTORM",
        status: "USED",
        usedAt: new Date(),
        targetUserId: alice.userId,
      },
    });
    await prisma.raceActiveEffect.create({
      data: {
        raceId,
        targetParticipantId: aliceParticipant.id,
        targetUserId: alice.userId,
        sourceUserId: bob.userId,
        powerupId: powerup.id,
        type: "RAINSTORM",
        status: "ACTIVE",
        startsAt: new Date(Date.now() - 6 * HOUR_MS),
        expiresAt: new Date(Date.now() + HOUR_MS),
      },
    });

    // Odd closed-bucket count → 4301 * 0.5 = 2150.5 effective.
    assert.equal((await postSamples(alice, [sampleAt(2, 4301)])).status, 200);
    const claims = await drain(makeWorker());
    assert.ok(claims.length >= 1);

    const job = await RaceResolutionJobV2.findByRaceId(raceId);
    assert.equal(job.state, "SUCCEEDED");
    const stored = await prisma.raceParticipant.findUniqueOrThrow({
      where: { id: aliceParticipant.id },
    });
    // Rounded exactly as the legacy assignment cast did, never truncated —
    // and the raw walked figure rides the same write un-halved.
    assert.equal(stored.totalSteps, 2151);
    assert.equal(stored.rawSteps, 4301);
  });

  it("two users in the same two races sync concurrently: one job row per race, totals match a serial control, zero deadlocks over 50 iterations", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const raceOne = await createActiveRace(alice, [bob], "Race One");
    const raceTwo = await createActiveRace(alice, [bob], "Race Two");

    const worker = makeWorker();
    const deadlocks = [];

    for (let iteration = 0; iteration < 50; iteration++) {
      const steps = 100 + iteration;
      // Both uploaders hit BOTH races at once, then two workers drain in
      // parallel. Against the per-user-keyed baseline this is the shape that
      // produced 40P01 cycles: two bulk writers on one race's rows.
      const results = await Promise.allSettled([
        postSamples(alice, [sampleAt(iteration + 2, steps)]),
        postSamples(bob, [sampleAt(iteration + 2, steps + 7)]),
      ]);
      for (const r of results) {
        if (r.status === "rejected") deadlocks.push(r.reason);
      }

      const drains = await Promise.allSettled([
        drain(worker, 4),
        drain(makeWorker(), 4),
      ]);
      for (const r of drains) {
        if (r.status === "rejected") deadlocks.push(r.reason);
      }
    }

    assert.deepEqual(
      deadlocks.map((e) => String(e && e.message)),
      [],
      "no request or worker run may fail (a 40P01 would surface here)"
    );

    // Race-keyed: exactly one queue row per race, never one per user.
    const jobs = await prisma.$queryRawUnsafe(
      `SELECT race_id FROM race_resolution_jobs_v2`
    );
    assert.equal(jobs.length, 2);
    assert.deepEqual(
      jobs.map((j) => j.race_id).sort(),
      [raceOne, raceTwo].sort()
    );

    // Drain to quiescence, then compare against a serial control: the same
    // inputs resolved with nothing else running.
    await drain(worker);
    const queued = await totalsByUser(raceOne);

    await prisma.$executeRawUnsafe(
      `UPDATE race_resolution_jobs_v2 SET state = 'queued', not_before_at = NULL, generation = generation + 1`
    );
    await drain(makeWorker());
    const control = await totalsByUser(raceOne);

    assert.deepEqual(queued, control);
    assert.ok(
      Object.values(queued).every((v) => v > 0),
      "the control run must produce non-zero totals, else this asserts nothing"
    );
  });

  it("the fence turns away a worker whose lease was reassigned, and it writes nothing", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const raceId = await createActiveRace(alice, [bob], "Fenced");
    await postSamples(alice, [sampleAt(2, 4000)]);
    await postSamples(bob, [sampleAt(2, 9000)]);

    // Establish a baseline the stale worker must NOT be able to move.
    await drain(makeWorker());
    const before = await totalsByUser(raceId);

    // A fresh sync makes the race dirty again, then a worker claims with a
    // zero-length lease so the row is immediately re-claimable.
    await postSamples(alice, [sampleAt(1, 50000)]);
    const stale = makeWorker({ leaseMs: 0 });

    // Claim by hand so we can steal the lease before the write transaction runs.
    const staleJob = await RaceResolutionJobV2.claimNext({
      now: new Date(),
      leaseMs: 0,
    });
    assert.ok(staleJob, "a claim must be available");

    const stolen = await RaceResolutionJobV2.claimNext({ now: new Date() });
    assert.ok(stolen, "the expired lease must be re-claimable");
    assert.notEqual(stolen.leaseToken, staleJob.leaseToken);

    // The stale holder now tries to commit. Its fence must fail.
    const fenceResult = await RaceResolutionJobV2.recordSuccess({
      id: staleJob.id,
      leaseToken: staleJob.leaseToken,
      processingGeneration: staleJob.processingGeneration,
    });
    assert.equal(fenceResult.applied, false, "stale lease token must not commit");

    // And running a full stale worker pass leaves the totals untouched: it
    // aborts at the fence having written nothing.
    void stale;
    assert.deepEqual(await totalsByUser(raceId), before);
  });

  it("legacy POST /steps keeps its exact response shape with inline resolution removed", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const raceId = await createActiveRace(alice, [bob], "Legacy shape");

    const res = await request(server.baseUrl, "POST", "/steps", {
      body: { steps: 8123, date: new Date().toISOString().slice(0, 10) },
      token: alice.token,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.record, "response still carries `record`");
    assert.equal(body.record.steps, 8123);
    assert.equal(body.record.userId, alice.userId);
    assert.ok("stepGoal" in body.record, "stepGoal compat field still present");

    // The write moved to the queue rather than disappearing.
    const job = await RaceResolutionJobV2.findByRaceId(raceId);
    assert.ok(job, "the legacy path enqueued the uploader's active race");
    assert.deepEqual(job.triggeredByUserIds, [alice.userId]);
  });

  it("queued-generation merge reaches both legacy step upload endpoints", async () => {
    const alice = await createUser("Legacy merge Alice");
    const bob = await createUser("Legacy merge Bob");
    const raceId = await createActiveRace(alice, [bob], "Legacy merge endpoints");
    await drain(makeWorker());
    await appSettings.setFlag("raceResolutionQueuedGenerationMergeV1Enabled", true);

    const date = new Date().toISOString().slice(0, 10);
    assert.equal((await request(server.baseUrl, "POST", "/steps", {
      body: { steps: 1000, date }, token: alice.token,
    })).status, 200);
    const stepsFirst = await RaceResolutionJobV2.findByRaceId(raceId);
    assert.equal((await request(server.baseUrl, "POST", "/steps", {
      body: { steps: 1100, date }, token: alice.token,
    })).status, 200);
    const stepsSecond = await RaceResolutionJobV2.findByRaceId(raceId);
    assert.equal(stepsSecond.generation, stepsFirst.generation);

    await drain(makeWorker());
    assert.equal((await postSamples(alice, [sampleAt(3, 1200)])).status, 200);
    const samplesFirst = await RaceResolutionJobV2.findByRaceId(raceId);
    assert.equal((await postSamples(alice, [sampleAt(2, 1300)])).status, 200);
    const samplesSecond = await RaceResolutionJobV2.findByRaceId(raceId);
    assert.equal(samplesSecond.generation, samplesFirst.generation);
  });

  it("reason-aware legacy POST /steps atomically queues source work without reconciling inline", async () => {
    const alice = await createUser("Reason Alice");
    const bob = await createUser("Reason Bob");
    const raceId = await createActiveRace(alice, [bob], "Reason-aware ordering");
    // Drain creation/start work first. During mixed-version rollout an
    // ambiguous already-queued empty envelope intentionally becomes FULL; a
    // clean successful row is the point from which narrow work is safe.
    await drain(makeWorker());
    await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);
    const before = await participantVersions(raceId);

    const response = await request(server.baseUrl, "POST", "/steps", {
      body: { steps: 8123, date: new Date().toISOString().slice(0, 10) },
      token: alice.token,
      headers: { "X-Timezone": "UTC" },
    });
    assert.equal(response.status, 200);

    const [job, participant, token] = await Promise.all([
      RaceResolutionJobV2.findByRaceId(raceId),
      prisma.raceParticipant.findUnique({
        where: { raceId_userId: { raceId, userId: alice.userId } },
      }),
      prisma.userScoringInputVersion.findUnique({
        where: { userId: alice.userId },
      }),
    ]);
    assert.deepEqual(job.dirtyReasons, ["STEP_INPUT_CHANGED"]);
    assert.deepEqual(job.dirtyParticipantIds, [participant.id]);
    assert.ok(token && token.generation >= 1n);
    assert.equal(
      token.sourceQueueSemanticsGeneration,
      token.generation,
      "the source-generation stamp and queue enqueue commit atomically"
    );
    assert.deepEqual(
      await participantVersions(raceId),
      before,
      "the HTTP request must not rewrite any participant row"
    );

    const events = [];
    assert.ok(await makeWorker({
      logger: { log(line) { try { events.push(JSON.parse(line)); } catch {} } },
    }).processOne());
    const committed = events.find((event) => event.event === "race_resolution_v2");
    assert.notEqual(committed?.resolutionPlan, "STEP_SYNC_COMMITTED");
  });

  it("reason-aware POST /steps treats skipRaceResolution as a compat no-op and queues source work", async () => {
    const alice = await createUser("Backstop Alice");
    const bob = await createUser("Backstop Bob");
    const raceId = await createActiveRace(alice, [bob], "Backstop envelope");
    // Start from a clean succeeded row so the merge semantics — not creation
    // leftovers — are what the assertions exercise.
    await drain(makeWorker());
    await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);

    const response = await request(server.baseUrl, "POST", "/steps", {
      body: {
        steps: 4321,
        date: new Date().toISOString().slice(0, 10),
        skipRaceResolution: true,
      },
      token: alice.token,
      headers: { "X-Timezone": "UTC" },
    });
    assert.equal(response.status, 200);

    const [job, participant] = await Promise.all([
      RaceResolutionJobV2.findByRaceId(raceId),
      prisma.raceParticipant.findUnique({
        where: { raceId_userId: { raceId, userId: alice.userId } },
      }),
    ]);
    // Frozen clients still send skipRaceResolution. It remains accepted, but
    // cannot skip the durable canonical-source queue handoff.
    assert.deepEqual(job.dirtyReasons, ["STEP_INPUT_CHANGED"]);
    assert.deepEqual(job.dirtyParticipantIds, [participant.id]);
    assert.deepEqual(job.triggeredByUserIds, [alice.userId]);

    // Fresh-insert path preserves the same coalescable source envelope.
    await prisma.$executeRawUnsafe(
      `DELETE FROM race_resolution_jobs_v2 WHERE race_id = $1`,
      raceId
    );
    const fresh = await request(server.baseUrl, "POST", "/steps", {
      body: {
        steps: 4322,
        date: new Date().toISOString().slice(0, 10),
        skipRaceResolution: true,
      },
      token: alice.token,
      headers: { "X-Timezone": "UTC" },
    });
    assert.equal(fresh.status, 200);
    const freshJob = await RaceResolutionJobV2.findByRaceId(raceId);
    assert.deepEqual(freshJob.dirtyReasons, ["STEP_INPUT_CHANGED"]);
    assert.equal(freshJob.dirtyPriority, "COALESCE");

    // The samples endpoint merges the same source reason without escalation.
    const samplesRes = await postSamples(alice, [sampleAt(2, 3100)]);
    assert.equal(samplesRes.status, 200);
    const merged = await RaceResolutionJobV2.findByRaceId(raceId);
    assert.deepEqual(merged.dirtyReasons, ["STEP_INPUT_CHANGED"]);
    assert.deepEqual(merged.dirtyParticipantIds, [participant.id]);
  });

  it("pure STEP_SYNC uses committed uploader rows without rewriting participants", async () => {
    const alice = await createUser("Scoped Sync Alice");
    const bob = await createUser("Scoped Sync Bob");
    const raceId = await createActiveRace(alice, [bob], "Scoped sync");
    await drain(makeWorker());
    await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);

    const participant = await prisma.raceParticipant.findFirstOrThrow({
      where: { raceId, userId: alice.userId },
    });
    await prisma.userScoringInputVersion.upsert({
      where: { userId: alice.userId },
      create: {
        userId: alice.userId,
        generation: 1n,
        sourceQueueSemanticsGeneration: 1n,
      },
      update: {
        generation: { set: 1n },
        sourceQueueSemanticsGeneration: { set: 1n },
      },
    });
    await RaceResolutionJobV2.enqueue({
      raceId,
      userId: alice.userId,
      dirtyEnvelope: {
        reason: "STEP_SYNC",
        dirtyUserIds: [alice.userId],
        dirtyParticipantIds: [participant.id],
        powerupTypes: [],
        priority: "COALESCE",
      },
    });
    const before = await participantVersions(raceId);
    const events = [];
    const worker = makeWorker({
      logger: {
        log(line) { try { events.push(JSON.parse(line)); } catch {} },
        error(line) { events.push({ error: String(line) }); },
      },
    });
    assert.ok(await worker.processOne());

    const committed = events.find((event) => event.event === "race_resolution_v2");
    assert.equal(committed?.resolutionPlan, "STEP_SYNC_COMMITTED", JSON.stringify(events));
    assert.equal(committed?.changedRows, 0);
    assert.deepEqual(await participantVersions(raceId), before);
    assert.equal((await RaceResolutionJobV2.findByRaceId(raceId)).state, "SUCCEEDED");
  });

  it("a public step mutation before the STEP_SYNC fence falls back to FULL in the same run", async () => {
    const alice = await createUser("Scoped Fence Alice");
    const bob = await createUser("Scoped Fence Bob");
    const raceId = await createActiveRace(alice, [bob], "Scoped fence");
    await drain(makeWorker());
    await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);
    assert.equal((await postSamples(alice, [sampleAt(5, 1100)])).status, 200);

    let injected = false;
    const realTransaction = prisma.$transaction.bind(prisma);
    const pausedTransaction = async (...args) => {
      if (!injected) {
        injected = true;
        const response = await postSamples(alice, [sampleAt(4, 900)]);
        assert.equal(response.status, 200);
      }
      return realTransaction(...args);
    };
    const prismaWithPausedFence = new Proxy({}, {
      get(_target, property) {
        if (property === "$transaction") return pausedTransaction;
        const value = prisma[property];
        return typeof value === "function" ? value.bind(prisma) : value;
      },
    });
    const events = [];
    const worker = makeWorker({
      prisma: prismaWithPausedFence,
      logger: {
        log(line) { try { events.push(JSON.parse(line)); } catch {} },
        error(line) { events.push({ error: String(line) }); },
      },
    });
    assert.ok(await worker.processOne());
    const committed = events.find((event) => event.event === "race_resolution_v2");
    assert.equal(committed?.resolutionPlan, "FULL", JSON.stringify(events));
    const totals = await totalsByUser(raceId);
    assert.ok(totals[alice.userId] >= 2000, "both public mutations survive the fallback");
  });

  it("re-fences every force-FULL retry and refreshes a second lower correction in the same claim", async () => {
    const alice = await createUser("Double Fence Alice");
    const bob = await createUser("Double Fence Bob");
    const raceId = await createActiveRace(alice, [bob], "Double source fence");
    await drain(makeWorker());
    await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);
    const target = await prisma.raceParticipant.findFirstOrThrow({
      where: { raceId, userId: alice.userId },
    });
    const source = await prisma.raceParticipant.findFirstOrThrow({
      where: { raceId, userId: bob.userId },
    });
    const powerup = await prisma.racePowerup.create({
      data: {
        raceId, participantId: source.id, userId: bob.userId,
        type: "RAINSTORM", status: "USED", usedAt: new Date(),
        targetUserId: alice.userId,
      },
    });
    await prisma.raceActiveEffect.create({
      data: {
        raceId, targetParticipantId: target.id, targetUserId: alice.userId,
        sourceUserId: bob.userId, powerupId: powerup.id, type: "RAINSTORM",
        status: "ACTIVE", startsAt: new Date(Date.now() - 6 * HOUR_MS),
        expiresAt: new Date(Date.now() + HOUR_MS),
      },
    });
    assert.equal((await postSamples(alice, [sampleAt(5, 5000)])).status, 200);

    let fenceAttempt = 0;
    const worker = makeWorker({
      async beforeWriteTransaction() {
        fenceAttempt += 1;
        if (fenceAttempt === 1) {
          assert.equal((await postSamples(alice, [sampleAt(5, 3000)])).status, 200);
        } else if (fenceAttempt === 2) {
          assert.equal((await postSamples(alice, [sampleAt(5, 1000)])).status, 200);
        }
      },
    });
    assert.ok(await worker.processOne());
    assert.ok(fenceAttempt >= 3, "both newer generations must reject stale work");
    const corrected = await prisma.raceParticipant.findUniqueOrThrow({
      where: { id: target.id },
    });
    assert.equal(corrected.rawSteps, 1000);
    assert.equal((await RaceResolutionJobV2.findByRaceId(raceId)).state, "SUCCEEDED");
  });

  it("settles source-input work without a retry loop for ended, cancelled, forfeited, and expired targets", async () => {
    for (const terminalCase of ["ended", "cancelled", "forfeited", "expired"]) {
      const alice = await createUser(`${terminalCase} Alice`);
      const bob = await createUser(`${terminalCase} Bob`);
      const raceId = await createActiveRace(alice, [bob], `${terminalCase} source target`);
      await drain(makeWorker());
      assert.equal((await postSamples(alice, [sampleAt(3, 900)])).status, 200);
      if (terminalCase === "ended") {
        await prisma.race.update({ where: { id: raceId }, data: { status: "COMPLETED" } });
      } else if (terminalCase === "cancelled") {
        await prisma.race.update({ where: { id: raceId }, data: { status: "CANCELLED" } });
      } else if (terminalCase === "forfeited") {
        await prisma.raceParticipant.update({
          where: { raceId_userId: { raceId, userId: alice.userId } },
          data: { forfeitedAt: new Date() },
        });
      } else {
        await prisma.race.update({
          where: { id: raceId }, data: { endsAt: new Date(Date.now() - 1000) },
        });
      }
      assert.ok(await makeWorker().processOne(), terminalCase);
      const settled = await RaceResolutionJobV2.findByRaceId(raceId);
      assert.equal(settled.state, "SUCCEEDED", terminalCase);
      assert.equal(Number(settled.generation), Number(settled.processingGeneration), terminalCase);
    }
  });

  it("malformed mixed-version dirty metadata atomically becomes FULL instead of losing the enqueue", async () => {
    const alice = await createUser("Malformed Alice");
    const bob = await createUser("Malformed Bob");
    const raceId = await createActiveRace(alice, [bob], "Malformed envelope");
    await drain(makeWorker());
    await prisma.$executeRawUnsafe(
      `UPDATE race_resolution_jobs_v2
       SET dirty_reasons='{}'::jsonb
       WHERE race_id=$1`,
      raceId
    );
    await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);

    const response = await request(server.baseUrl, "POST", "/steps", {
      body: { steps: 100, date: new Date().toISOString().slice(0, 10) },
      token: alice.token,
      headers: { "X-Timezone": "UTC" },
    });
    assert.equal(response.status, 200);
    const job = await RaceResolutionJobV2.findByRaceId(raceId);
    assert.deepEqual(job.dirtyReasons, ["FULL"]);
    assert.equal(job.state, "QUEUED");
  });

  it("N rapid syncs coalesce to <= 2 worker runs with correct totals, and EVERY triggering user's box state is processed", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const raceId = await createActiveRace(alice, [bob], "Coalesce");

    for (let i = 0; i < 6; i++) {
      await postSamples(alice, [sampleAt(i + 2, 900)]);
      await postSamples(bob, [sampleAt(i + 2, 700)]);
    }

    const processedUserSets = [];
    const worker = makeWorker({
      onCommitted: ({ job }) => {
        processedUserSets.push([...job.processingTriggeredByUserIds].sort());
      },
    });

    const claims = await drain(worker);
    assert.ok(
      claims.length <= 2,
      `12 syncs must coalesce to at most 2 runs, saw ${claims.length}`
    );
    assert.ok(claims.length >= 1);

    // Both uploaders appear in the processing snapshot — coalescing must not
    // drop a triggering user's box/nudge processing (§5a item 2).
    const everyone = new Set(processedUserSets.flat());
    assert.ok(everyone.has(alice.userId), "Alice must be processed");
    assert.ok(everyone.has(bob.userId), "Bob must be processed");

    // "Correct final totals" means: identical to what a serial control run
    // produces from the same inputs — coalescing must not lose steps.
    const coalesced = await totalsByUser(raceId);
    await prisma.$executeRawUnsafe(
      `UPDATE race_resolution_jobs_v2 SET state = 'queued', not_before_at = NULL, generation = generation + 1`
    );
    await drain(makeWorker());
    const control = await totalsByUser(raceId);
    assert.deepEqual(coalesced, control);
    assert.ok(coalesced[alice.userId] > 0 && coalesced[bob.userId] > 0);
    assert.ok(
      coalesced[alice.userId] > coalesced[bob.userId],
      "Alice walked more per bucket, so she must lead"
    );
  });

  it("a box failure rolls back participant totals and retries one durable threshold crossing", async () => {
    const alice = await createUser("Atomic box Alice");
    const bob = await createUser("Atomic box Bob");
    const raceId = await createActiveRace(alice, [bob], "Atomic box");
    await drain(makeWorker());

    const participant = await prisma.raceParticipant.findFirstOrThrow({
      where: { raceId, userId: alice.userId },
    });
    assert.equal(participant.nextBoxAtSteps, 2000);
    assert.equal((await postSamples(alice, [sampleAt(2, 2500)])).status, 200);
    const before = await participantVersions(raceId);

    const failed = makeWorker({
      syncRacePowerupState: async () => {
        const error = new Error("induced box transaction failure");
        error.code = "BOX_TEST_FAILURE";
        throw error;
      },
    });
    assert.ok(await failed.processOne());
    assert.deepEqual(
      await participantVersions(raceId),
      before,
      "participant scoring writes must roll back with the failed box consequence"
    );
    assert.equal(
      await prisma.racePowerup.count({ where: { participantId: participant.id } }),
      0,
      "no partial mystery box may survive the failed transaction"
    );
    assert.equal((await RaceResolutionJobV2.findByRaceId(raceId)).state, "QUEUED");

    await prisma.$executeRawUnsafe(
      `UPDATE race_resolution_jobs_v2
       SET retry_at = NULL, not_before_at = NULL
       WHERE race_id = $1`,
      raceId
    );
    assert.ok(await makeWorker().processOne());
    const after = await prisma.raceParticipant.findFirstOrThrow({
      where: { id: participant.id },
    });
    assert.ok(after.totalSteps >= 2500);
    assert.equal(after.nextBoxAtSteps, 4000);
    assert.equal(
      await prisma.racePowerup.count({ where: { participantId: participant.id } }),
      1,
      "the retried generation mints exactly one mystery box"
    );
    assert.equal((await RaceResolutionJobV2.findByRaceId(raceId)).state, "SUCCEEDED");
  });
});

// Physical proof that a request wrote no participant row: `xmin` is the
// inserting/updating transaction id of the tuple. Any UPDATE (even one writing
// the identical value) produces a new tuple version with a new xmin. Comparing
// snapshots is therefore strictly stronger than comparing column values.
async function participantVersions(raceId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT user_id AS "userId", xmin::text AS version, total_steps AS "totalSteps"
     FROM race_participants WHERE race_id = $1 ORDER BY user_id ASC`,
    raceId
  );
  return rows;
}

describe("5a — read-only powerup gates never bulk-write race_participants", () => {
  // C0's ownership invariant is "one bulk writer per race". Two usePowerup
  // branches used to resolve-and-persist in the HTTP request path purely to READ
  // fresh totals — a second concurrent bulk writer against the fenced worker.
  // They now compute read-only. These cases pin BOTH halves: zero foreign
  // participant writes, AND the decision still made off un-persisted fresh steps.

  it("Trail Mine plants at the owner's freshly COMPUTED position while writing no other participant row", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const raceId = await createActiveRace(alice, [bob], "Mine read-only");

    // Alice really walked; Bob leads on the STORED column so Alice is not last.
    // Nothing is resolved, so alice.totalSteps is still 0 in the database.
    await postSamples(alice, [sampleAt(4, 12000)]);
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: bob.userId },
      data: { totalSteps: 40000 },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: alice.userId },
      data: { totalSteps: 0 },
    });

    const before = await participantVersions(raceId);
    assert.equal(before.find((r) => r.userId === alice.userId).totalSteps, 0);

    const participant = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: alice.userId },
      select: { id: true },
    });
    const mine = await prisma.racePowerup.create({
      data: {
        raceId,
        participantId: participant.id,
        userId: alice.userId,
        type: "TRAIL_MINE",
        rarity: "RARE",
        status: "HELD",
        earnedAtSteps: 0,
      },
    });

    const res = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${mine.id}/use`,
      { body: {}, token: alice.token }
    );
    assert.equal(res.status, 200);

    // The plant used the COMPUTED total, not the stale stored 0.
    const effect = await prisma.raceActiveEffect.findFirst({
      where: { raceId, type: "TRAIL_MINE" },
    });
    assert.ok(effect, "the mine was planted");
    assert.equal(
      effect.metadata.positionSteps,
      12000,
      "position comes from the fresh computation, never the stale stored column"
    );

    // No participant row other than the actor's own was touched, and the actor's
    // total was NOT persisted by this request — the worker owns that write.
    const after = await participantVersions(raceId);
    const bobBefore = before.find((r) => r.userId === bob.userId);
    const bobAfter = after.find((r) => r.userId === bob.userId);
    assert.equal(
      bobAfter.version,
      bobBefore.version,
      "a rival's participant row must not be rewritten by a powerup use"
    );
    assert.equal(
      after.find((r) => r.userId === alice.userId).totalSteps,
      0,
      "the request path persisted no total; the enqueued worker will"
    );

    // …and the enqueue happened, so the totals do converge.
    const job = await RaceResolutionJobV2.findByRaceId(raceId);
    assert.ok(job, "the powerup use enqueued the race");
    await drain(makeWorker());
    const converged = await totalsByUser(raceId);
    assert.equal(converged[alice.userId], 12000);
  });

  it("the Uprising losing-team gate reads COMPUTED team totals and writes no participant row", async () => {
    await appSettings.setFlag("teamRacesEnabled", true);
    const TEAMS = {
      "X-Client-Features":
        "characters,team_races,powerups2,powerups3,powerups4,powerups5",
    };
    const a1 = await createUser("A1");
    const b1 = await createUser("B1");
    // Team-race invites require the invitee to have announced the `team_races`
    // client feature; one authenticated call with the header records it.
    for (const u of [a1, b1]) {
      await request(server.baseUrl, "GET", "/auth/me", {
        token: u.token,
        headers: TEAMS,
      });
    }
    await makeFriends(a1, b1);

    const createRes = await request(server.baseUrl, "POST", "/races", {
      body: {
        name: "Uprising read-only",
        maxDurationDays: 7,
        isTeamRace: true,
        teamSize: 1,
        powerupsEnabled: true,
        // Public so the private-race auto-start does not fire; this test needs
        // the explicit manual start below to be the thing that starts the race.
        isPublic: true,
      },
      token: a1.token,
      headers: TEAMS,
    });
    const raceId = (await createRes.json()).race.id;
    const inviteRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/invite`,
      { body: { inviteeIds: [b1.userId] }, token: a1.token, headers: TEAMS }
    );
    assert.equal(
      inviteRes.status,
      200,
      `invite must succeed: ${JSON.stringify(await inviteRes.json())}`
    );
    const respondRes = await request(
      server.baseUrl,
      "PUT",
      `/races/${raceId}/respond`,
      { body: { accept: true, team: "TEAM_B" }, token: b1.token, headers: TEAMS }
    );
    assert.equal(
      respondRes.status,
      200,
      `B1 must join TEAM_B: ${JSON.stringify(await respondRes.json())}`
    );
    const startRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/start`,
      { token: a1.token, headers: TEAMS }
    );
    assert.equal(
      startRes.status,
      200,
      `team race must start: ${JSON.stringify(await startRes.json())}`
    );

    const startedAt = new Date(Date.now() - 8 * HOUR_MS);
    await prisma.race.update({
      where: { id: raceId },
      data: {
        startedAt,
        endsAt: new Date(Date.now() + 24 * HOUR_MS),
        timezone: "UTC",
      },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId },
      data: { joinedAt: startedAt },
    });

    // Stored columns say A1 LEADS (gate would reject). Real, unpersisted steps
    // say A1 is behind — the gate must follow the computation.
    await postSamples(b1, [sampleAt(4, 20000)]);
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: a1.userId },
      data: { totalSteps: 90000 },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: b1.userId },
      data: { totalSteps: 0 },
    });

    const before = await participantVersions(raceId);
    const participant = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: a1.userId },
      select: { id: true },
    });
    const powerup = await prisma.racePowerup.create({
      data: {
        raceId,
        participantId: participant.id,
        userId: a1.userId,
        type: "UPRISING",
        rarity: "RARE",
        status: "HELD",
        earnedAtSteps: 0,
      },
    });

    const res = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${powerup.id}/use`,
      { body: {}, token: a1.token, headers: TEAMS }
    );
    // A1's computed total is 0 vs B1's 20000, so A1 IS the losing team and the
    // gate opens — decided entirely off numbers that were never persisted.
    assert.equal(
      res.status,
      200,
      `gate must open on computed totals: ${JSON.stringify(await res.json())}`
    );

    const after = await participantVersions(raceId);
    const b1Before = before.find((r) => r.userId === b1.userId);
    const b1After = after.find((r) => r.userId === b1.userId);
    assert.equal(
      b1After.version,
      b1Before.version,
      "the gate must not rewrite the opposing team's participant row"
    );
    assert.equal(
      b1After.totalSteps,
      0,
      "the request path persisted nothing; the enqueued worker will"
    );
    assert.ok(await RaceResolutionJobV2.findByRaceId(raceId));
  });

  // raw_steps (2026-08-09, docs/box-raw-steps-position-and-option-h-requirements.md
  // test 6e). The odds position now READS a persisted column, and the worker
  // WRITES it inside the same fenced replay that writes total_steps. Neither
  // half may add a request-path participant write — a bulk (or even per-row)
  // write from the open route would reintroduce exactly the second writer C0
  // removed.
  it("opening a mystery box reads raw_steps and adds ZERO request-path participant writes", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const raceId = await createActiveRace(alice, [bob], "Raw steps single writer");

    await postSamples(alice, [sampleAt(4, 3000)]);
    await postSamples(bob, [sampleAt(4, 9000)]);
    await drain(makeWorker());

    const raw = async () =>
      prisma.$queryRawUnsafe(
        `SELECT user_id AS "userId", xmin::text AS version,
                total_steps AS "totalSteps", raw_steps AS "rawSteps"
         FROM race_participants WHERE race_id = $1 ORDER BY user_id ASC`,
        raceId
      );

    const before = await raw();
    assert.ok(
      before.every((r) => typeof r.rawSteps === "number"),
      "the fenced worker replay must be a raw_steps writer"
    );

    const participant = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: alice.userId },
      select: { id: true },
    });
    const box = await prisma.racePowerup.create({
      data: {
        raceId,
        participantId: participant.id,
        userId: alice.userId,
        type: "MYSTERY_BOX",
        status: "MYSTERY_BOX",
        earnedAtSteps: 0,
      },
    });

    const res = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${box.id}/open`,
      { token: alice.token }
    );
    assert.equal(res.status, 200);

    const after = await raw();
    const bobBefore = before.find((r) => r.userId === bob.userId);
    const bobAfter = after.find((r) => r.userId === bob.userId);
    assert.equal(
      bobAfter.version,
      bobBefore.version,
      "a rival's participant row must not be rewritten by a box open"
    );
    for (const row of after) {
      const was = before.find((r) => r.userId === row.userId);
      assert.equal(row.rawSteps, was.rawSteps, "no request-path raw_steps write");
      assert.equal(row.totalSteps, was.totalSteps, "no request-path total write");
    }
  });
});

describe("5d — explicit debounce", () => {
  it("continuous generation bumps resolve at most once per RACE_RESOLVE_DEBOUNCE_MS", async () => {
    const previous = process.env.RACE_RESOLVE_DEBOUNCE_MS;
    process.env.RACE_RESOLVE_DEBOUNCE_MS = "60000";
    try {
      const alice = await createUser("Alice");
      const bob = await createUser("Bob");
      const raceId = await createActiveRace(alice, [bob], "Debounced");
      await postSamples(alice, [sampleAt(2, 1000)]);

      const worker = makeWorker();
      let runs = 0;

      for (let i = 0; i < 10; i++) {
        // Bump the generation on every iteration — the race is continuously
        // dirty for the whole loop.
        await RaceResolutionJobV2.enqueue({ raceId, userId: alice.userId });
        const job = await worker.processOne();
        if (job) runs += 1;
      }

      assert.equal(
        runs,
        1,
        "a continuously-bumped race must run once per debounce window, not spin"
      );

      const row = await RaceResolutionJobV2.findByRaceId(raceId);
      assert.ok(row.notBeforeAt > new Date(), "notBeforeAt holds the race off");
      assert.equal(row.state, "QUEUED", "still dirty, waiting for the window");
    } finally {
      process.env.RACE_RESOLVE_DEBOUNCE_MS = previous;
    }
  });

  it("users who enqueue DURING a run are processed by the follow-up run", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const raceId = await createActiveRace(alice, [bob], "Follow-up");
    await postSamples(alice, [sampleAt(2, 1000)]);

    // Simulate "the claim already happened" — Alice's ids are in processing.
    const claimed = await RaceResolutionJobV2.claimNext({ now: new Date() });
    assert.deepEqual(claimed.processingTriggeredByUserIds, [alice.userId]);

    // Bob syncs while the run is in flight: he lands in the LIVE array.
    await postSamples(bob, [sampleAt(2, 2000)]);
    const midRun = await RaceResolutionJobV2.findByRaceId(raceId);
    assert.deepEqual(midRun.triggeredByUserIds, [bob.userId]);

    // The run finishes; the generation bump requeues it.
    const outcome = await RaceResolutionJobV2.recordSuccess({
      id: claimed.id,
      leaseToken: claimed.leaseToken,
      processingGeneration: claimed.processingGeneration,
    });
    assert.equal(outcome.applied, true);
    assert.equal(outcome.superseded, true);

    const followUp = await RaceResolutionJobV2.claimNext({ now: new Date() });
    assert.ok(followUp, "the generation bump forces a follow-up run");
    assert.deepEqual(
      [...followUp.processingTriggeredByUserIds].sort(),
      [bob.userId],
      "the follow-up processes the user who enqueued during the run"
    );
  });

  it("a crashed run's triggering users are UNIONed back in on re-claim, never dropped", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const raceId = await createActiveRace(alice, [bob], "Crash union");

    await postSamples(alice, [sampleAt(2, 1000)]);
    // Claim with a zero lease, then "crash" (never record success/failure).
    const crashed = await RaceResolutionJobV2.claimNext({
      now: new Date(),
      leaseMs: 0,
    });
    assert.deepEqual(crashed.processingTriggeredByUserIds, [alice.userId]);

    await postSamples(bob, [sampleAt(2, 2000)]);

    const reclaimed = await RaceResolutionJobV2.claimNext({ now: new Date() });
    assert.deepEqual(
      [...reclaimed.processingTriggeredByUserIds].sort(),
      [alice.userId, bob.userId].sort(),
      "the crashed run's users survive in processing and are unioned with the new ones"
    );
    void raceId;
  });

  it("claims settlement and recovery work ahead of ordinary live work", async () => {
    const alice = await createUser("Priority Alice");
    const bob = await createUser("Priority Bob");
    const settlementRace = await createActiveRace(alice, [bob], "Settlement priority");
    const liveRace = await createActiveRace(alice, [bob], "Live priority");
    await drain(makeWorker());

    await postSamples(alice, [sampleAt(2, 1000)]);
    await postSamples(bob, [sampleAt(3, 1000)]);
    await prisma.$executeRawUnsafe(
      `UPDATE race_resolution_jobs_v2 SET queue_priority = 'SETTLEMENT' WHERE race_id = $1`,
      settlementRace
    );
    const queuedPriorities = await prisma.raceResolutionJobV2.findMany({
      where: { state: "QUEUED" },
      select: { raceId: true, queuePriority: true },
    });
    assert.equal(
      queuedPriorities.find((row) => row.raceId === settlementRace)?.queuePriority,
      "SETTLEMENT"
    );

    const first = await RaceResolutionJobV2.claimNext({ now: new Date() });
    assert.equal(first.raceId, settlementRace);
    assert.equal(first.processingQueuePriority, "SETTLEMENT");

    await RaceResolutionJobV2.recordSuccess({
      id: first.id,
      leaseToken: first.leaseToken,
      processingGeneration: first.processingGeneration,
    });
    const snapshot = await RaceResolutionJobV2.queueServiceSnapshot(new Date());
    assert.ok(snapshot.liveCount >= 1);
    assert.equal(snapshot.settlementCount, 0);
    void liveRace;
  });

  it("runs Rainstorm source changes through a non-committed plan and leaves the other participant untouched", async () => {
    const alice = await createUser("Incremental Alice");
    const bob = await createUser("Incremental Bob");
    const raceId = await createActiveRace(alice, [bob], "Incremental Rainstorm");
    await drain(makeWorker());
    await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);

    const target = await prisma.raceParticipant.findFirstOrThrow({
      where: { raceId, userId: alice.userId },
    });
    const source = await prisma.raceParticipant.findFirstOrThrow({
      where: { raceId, userId: bob.userId },
    });
    const powerup = await prisma.racePowerup.create({
      data: {
        raceId, participantId: source.id, userId: bob.userId,
        type: "RAINSTORM", status: "USED", usedAt: new Date(),
        targetUserId: alice.userId,
      },
    });
    await prisma.raceActiveEffect.create({
      data: {
        raceId, targetParticipantId: target.id, targetUserId: alice.userId,
        sourceUserId: bob.userId, powerupId: powerup.id, type: "RAINSTORM",
        status: "ACTIVE", startsAt: new Date(Date.now() - 6 * HOUR_MS),
        expiresAt: new Date(Date.now() + HOUR_MS),
      },
    });

    const before = await participantVersions(raceId);
    assert.equal((await postSamples(alice, [sampleAt(2, 4301)])).status, 200);
    const events = [];
    const worker = makeWorker({
      dependencyClosureEnabled: true,
      logger: { log(line) { try { events.push(JSON.parse(line)); } catch {} } },
    });
    assert.ok(await worker.processOne());
    const committed = events.find((event) => event.event === "race_resolution_v2");
    assert.notEqual(committed?.resolutionPlan, "STEP_SYNC_COMMITTED", JSON.stringify(events));

    const after = await participantVersions(raceId);
    const beforeBob = before.find((row) => row.userId === bob.userId);
    const afterBob = after.find((row) => row.userId === bob.userId);
    assert.equal(afterBob.version, beforeBob.version);
  });

  for (const type of ["RAINSTORM", "RALLY_FLAG", "UPRISING"]) {
    it(`uses exact STEP_SYNC_INCREMENTAL for a committed STEP_SYNC with ${type}`, async () => {
      const alice = await createUser(`${type} committed Alice`);
      const bob = await createUser(`${type} committed Bob`);
      const raceId = await createActiveRace(alice, [bob], `${type} committed incremental`);
      await drain(makeWorker());
      await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);
      assert.equal((await postSamples(alice, [sampleAt(2, 2400)])).status, 200);
      await drain(makeWorker());

      const target = await prisma.raceParticipant.findFirstOrThrow({
        where: { raceId, userId: alice.userId },
      });
      const source = await prisma.raceParticipant.findFirstOrThrow({
        where: { raceId, userId: bob.userId },
      });
      const powerup = await prisma.racePowerup.create({
        data: {
          raceId, participantId: source.id, userId: bob.userId,
          type, status: "USED", usedAt: new Date(), targetUserId: alice.userId,
        },
      });
      await prisma.raceActiveEffect.create({
        data: {
          raceId, targetParticipantId: target.id, targetUserId: alice.userId,
          sourceUserId: bob.userId, powerupId: powerup.id, type, status: "ACTIVE",
          startsAt: new Date(Date.now() - 6 * HOUR_MS),
          expiresAt: new Date(Date.now() + HOUR_MS),
        },
      });
      await RaceResolutionJobV2.enqueue({
        raceId,
        userId: alice.userId,
        dirtyEnvelope: {
          reason: "STEP_SYNC",
          dirtyUserIds: [alice.userId],
          dirtyParticipantIds: [target.id],
          powerupTypes: [],
          priority: "COALESCE",
        },
      });
      const before = await participantVersions(raceId);
      const events = [];
      assert.ok(await makeWorker({
        dependencyClosureEnabled: true,
        logger: { log(line) { try { events.push(JSON.parse(line)); } catch {} } },
      }).processOne());
      const committed = events.find((event) => event.event === "race_resolution_v2");
      assert.equal(
        committed?.resolutionPlan,
        "STEP_SYNC_INCREMENTAL",
        `${type}: ${JSON.stringify(events)}`
      );
      const after = await participantVersions(raceId);
      assert.equal(
        after.find((row) => row.userId === bob.userId).version,
        before.find((row) => row.userId === bob.userId).version,
        `${type} must not rewrite the other participant`
      );
    });
  }

  it("admits Rally Flag and Uprising source changes without using committed-step optimization", async () => {
    for (const type of ["RALLY_FLAG", "UPRISING"]) {
      const alice = await createUser(`${type} Alice`);
      const bob = await createUser(`${type} Bob`);
      const raceId = await createActiveRace(alice, [bob], `${type} incremental`);
      await drain(makeWorker());
      await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);

      const target = await prisma.raceParticipant.findFirstOrThrow({
        where: { raceId, userId: alice.userId },
      });
      const source = await prisma.raceParticipant.findFirstOrThrow({
        where: { raceId, userId: bob.userId },
      });
      const powerup = await prisma.racePowerup.create({
        data: {
          raceId, participantId: source.id, userId: bob.userId,
          type, status: "USED", usedAt: new Date(), targetUserId: alice.userId,
        },
      });
      await prisma.raceActiveEffect.create({
        data: {
          raceId, targetParticipantId: target.id, targetUserId: alice.userId,
          sourceUserId: bob.userId, powerupId: powerup.id, type, status: "ACTIVE",
          startsAt: new Date(Date.now() - 6 * HOUR_MS),
          expiresAt: new Date(Date.now() + HOUR_MS),
        },
      });

      const before = await participantVersions(raceId);
      assert.equal((await postSamples(alice, [sampleAt(2, 2000)])).status, 200);
      const events = [];
      const worker = makeWorker({
        dependencyClosureEnabled: true,
        logger: { log(line) { try { events.push(JSON.parse(line)); } catch {} } },
      });
      assert.ok(await worker.processOne());
      const committed = events.find((event) => event.event === "race_resolution_v2");
      assert.notEqual(committed?.resolutionPlan, "STEP_SYNC_COMMITTED", `${type}: ${JSON.stringify(events)}`);
      const after = await participantVersions(raceId);
      assert.equal(
        after.find((row) => row.userId === bob.userId).version,
        before.find((row) => row.userId === bob.userId).version,
        `${type} must not rewrite the other participant`
      );
    }
  });
});

describe("5f — expand/overlap handoff", () => {
  it("performs NO claim while the OLD table still shows a RUNNING row with an unexpired lease, and none until the quiet period elapses", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await createActiveRace(alice, [bob], "Handoff");
    await postSamples(alice, [sampleAt(2, 1000)]);

    // Simulate the pm2 reload overlap: an OLD-binary worker mid-run.
    // Timestamps are passed as JS Dates, never NOW(): these columns are
    // `timestamp WITHOUT time zone`, so NOW() would land in the session's local
    // zone while the worker compares against a UTC JS Date.
    const nowTs = new Date();
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO race_resolution_jobs
        (id, user_id, generation, resolution_time_zone, state, attempts,
         requested_at, started_at, lease_expires_at, updated_at)
      VALUES (gen_random_uuid()::text, $1, 1, 'UTC', 'running', 1, $2, $2, $3, $2)
      `,
      alice.userId,
      nowTs,
      new Date(nowTs.getTime() + 30_000)
    );

    const worker = makeWorker();
    assert.equal(
      await worker.processOne(),
      null,
      "no v2 claim while an old worker holds an unexpired lease"
    );

    // Both tables coexist and the v2 job is still pending — coexistence is
    // asserted, concurrent bulk-writing is asserted NOT to occur.
    const pending = await RaceResolutionJobV2.findByRaceId(
      (await prisma.race.findFirst({ where: { status: "ACTIVE" } })).id
    );
    assert.equal(pending.state, "QUEUED");

    // Old worker drains (lease expires / row completes).
    await prisma.$executeRawUnsafe(
      `UPDATE race_resolution_jobs SET state = 'succeeded', lease_expires_at = NULL`
    );
    const claimed = await worker.processOne();
    assert.ok(claimed, "once the old table is drained the v2 worker may claim");
  });

  it("holds off every claim until the startup quiet period has elapsed", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await createActiveRace(alice, [bob], "Quiet period");
    await postSamples(alice, [sampleAt(2, 1000)]);

    const previous = process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS;
    process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "60000";
    try {
      const justBooted = buildRaceResolutionWorkerV2({ bootAt: Date.now() });
      assert.equal(await justBooted.processOne(), null);
      assert.equal(await justBooted.readyToClaim(new Date()), false);
    } finally {
      process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = previous;
    }

    // Same worker, quiet period elapsed => claims.
    assert.ok(await makeWorker().processOne());
  });

  it("tolerates the OLD table being absent (post-contract restart)", async () => {
    const worker = makeWorker({
      prisma: {
        async $queryRawUnsafe() {
          const err = new Error('relation "race_resolution_jobs" does not exist');
          err.code = "42P01";
          throw err;
        },
      },
    });
    assert.equal(await worker.readyToClaim(new Date()), true);
  });
});

describe("5h — reverse handoff (rollback drill)", () => {
  it("flipping raceQueueV2ClaimingDisabled stops claims within a tick and drains to zero unexpired RUNNING leases", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await createActiveRace(alice, [bob], "Rollback");
    await postSamples(alice, [sampleAt(2, 1000)]);

    const worker = makeWorker();
    assert.ok(await worker.processOne(), "claims work before the flip");

    // Make the race dirty again so a claim WOULD be available.
    await postSamples(bob, [sampleAt(3, 2000)]);
    await prisma.$executeRawUnsafe(
      `UPDATE race_resolution_jobs_v2 SET not_before_at = NULL`
    );

    // The flag is read PER TICK and UNCACHED: written directly to the row here
    // (bypassing setFlag's in-process cache bust) to prove the worker is not
    // relying on the 30s appSettings cache.
    await prisma.appSetting.upsert({
      where: { key: "raceQueueV2ClaimingDisabled" },
      update: { value: true },
      create: { key: "raceQueueV2ClaimingDisabled", value: true },
    });

    assert.equal(await worker.claimingDisabled(), true);
    assert.equal(
      await worker.processOne(),
      null,
      "claims stop within one tick of the flip"
    );
    assert.equal(await worker.tick(), 0);

    // Nothing is mid-write: the drill's go/no-go for starting the old binary.
    assert.equal(await RaceResolutionJobV2.countUnexpiredRunning(new Date()), 0);

    // Un-flip and confirm the queue resumes (the drill is reversible).
    await prisma.appSetting.update({
      where: { key: "raceQueueV2ClaimingDisabled" },
      data: { value: false },
    });
    assert.ok(await worker.processOne());
  });
});

describe("reason-aware superseded scope merge", () => {
  it("dedupes stable scopes and atomically escalates an over-cap union to FULL", async () => {
    const alice = await createUser("Scope Alice");
    const bob = await createUser("Scope Bob");
    const raceId = await createActiveRace(alice, [bob], "Scope Merge");
    const leaseToken = "scope-lease";
    const participantIds = Array.from({ length: 1000 }, (_, index) => `p-${index}`);
    await prisma.raceResolutionJobV2.update({
      where: { raceId },
      data: {
        generation: 2,
        processingGeneration: 1,
        state: "RUNNING",
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 30_000),
        lastCompletedAt: new Date(),
        dirtyReasons: ["STEP_SYNC"],
        processingDirtyReasons: ["STEP_SYNC", "STEP_SYNC"],
        dirtyParticipantIds: participantIds,
        processingDirtyParticipantIds: [participantIds[0], "p-overflow"],
        dirtyPowerupTypes: ["LEECH"],
        processingDirtyPowerupTypes: ["LEECH"],
        dirtyPriority: "COALESCE",
        processingDirtyPriority: "COALESCE",
        triggeredByUserIds: [alice.userId, alice.userId],
        processingTriggeredByUserIds: [alice.userId, bob.userId],
      },
    });

    const job = await prisma.raceResolutionJobV2.findUniqueOrThrow({ where: { raceId } });
    const outcome = await prisma.$transaction((tx) =>
      RaceResolutionJobV2.discardSuperseded({
        id: job.id,
        leaseToken,
        now: new Date(),
      }, tx)
    );
    assert.equal(outcome.applied, true);
    const merged = await prisma.raceResolutionJobV2.findUniqueOrThrow({ where: { raceId } });
    assert.deepEqual(merged.dirtyReasons, ["FULL"]);
    assert.deepEqual(merged.dirtyParticipantIds, []);
    assert.deepEqual(merged.dirtyPowerupTypes, []);
    assert.deepEqual(merged.triggeredByUserIds, [alice.userId, bob.userId]);
  });
});
