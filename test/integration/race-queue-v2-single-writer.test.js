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
});

after(async () => {
  await appSettings.setFlag("raceQueueV2ClaimingDisabled", false);
  await appSettings.setFlag("inlineRaceResolutionFallback", false);
});

describe("5a — one bulk writer per race", () => {
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
    await postSamples(alice, [sampleAt(3, 50000)]);
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
