// Phase 2b — dependency-closure planner in SHADOW MODE
// (docs/race-resolution-dependency-closure-requirements.md §Implementation
// phases item 2, §Observability).
//
// Everything here runs against the REAL test Postgres and drives real HTTP for
// the step-sync paths; the worker is the real worker, driven one claim at a
// time. The property under test is that the shadow planner OBSERVES and changes
// nothing: same plan, same persisted rows, same job outcome — plus that its log
// line carries only aggregate dimensions.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");

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

// The complete field set the shadow is allowed to emit. Asserted as a SET so a
// later phase cannot quietly add a ninth field (a participant id, a step total)
// to this log line without this suite failing.
const SHADOW_FIELDS = [
  "shadowClosurePlan",
  "shadowClosureFallbackReason",
  "shadowClosureCount",
  "shadowSourceCount",
  "shadowMinesActive",
  "shadowWouldEscalateOnMine",
  "shadowPlannerMs",
  "shadowRetainedSourceCount",
];

let server;
let nextAppleId = 0;
const HOUR_MS = 60 * 60 * 1000;

async function createUser(displayName) {
  const appleId = `apple-shadow-${++nextAppleId}-${Date.now()}`;
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
  return buildRaceResolutionWorkerV2({
    bootAt: 0,
    dependencyClosureEnabled: false,
    ...overrides,
  });
}

// Drives the real worker for one claim while capturing its structured log
// lines. `plannerCalls` counts every entry into the planner seam, which is how
// the flag-off case proves ZERO planner work rather than merely a null log.
function makeCapturingWorker(overrides = {}) {
  const lines = [];
  const plannerCalls = [];
  const realPlanner =
    require("../../src/modules/races/services/raceScoringDependencyClosure")
      .buildRaceScoringDependencyClosure;
  const worker = makeWorker({
    async buildRaceScoringDependencyClosure(args) {
      plannerCalls.push(args);
      return realPlanner(args);
    },
    logger: {
      log(line) {
        try {
          lines.push(JSON.parse(line));
        } catch {
          lines.push({ raw: String(line) });
        }
      },
      error(line) {
        try {
          lines.push(JSON.parse(line));
        } catch {
          lines.push({ raw: String(line) });
        }
      },
    },
    ...overrides,
  });
  return { worker, lines, plannerCalls };
}

function committedLine(lines) {
  return lines.find(
    (line) => line.event === "race_resolution_v2" && line.outcome === "commit"
  );
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

// The persisted surface a shadow run must not move. Deliberately excludes
// `totalsUpdatedAt` (a wall-clock stamp that differs between any two runs) and
// compares the score-bearing columns for every accepted row.
async function participantState(raceId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT user_id AS "userId", total_steps AS "totalSteps",
            raw_steps AS "rawSteps", bonus_steps AS "bonusSteps",
            next_box_at_steps AS "nextBoxAtSteps"
     FROM race_participants WHERE race_id = $1 ORDER BY user_id ASC`,
    raceId
  );
  return rows;
}

async function requeue(raceId) {
  await prisma.$executeRawUnsafe(
    `UPDATE race_resolution_jobs_v2
     SET state = 'queued', not_before_at = NULL, generation = generation + 1
     WHERE race_id = $1`,
    raceId
  );
}

// Creates a raceActiveEffect row directly (no route), so the fixture cannot
// stamp a POWERUP_MUTATION reason onto the job and demote the envelope.
async function plantEffect({
  raceId,
  type,
  targetUser,
  sourceUser,
  startsAt = new Date(Date.now() - 6 * HOUR_MS),
  expiresAt = new Date(Date.now() + HOUR_MS),
  metadata = undefined,
}) {
  const targetParticipant = await prisma.raceParticipant.findFirstOrThrow({
    where: { raceId, userId: targetUser.userId },
  });
  const sourceParticipant = await prisma.raceParticipant.findFirstOrThrow({
    where: { raceId, userId: sourceUser.userId },
  });
  const powerup = await prisma.racePowerup.create({
    data: {
      raceId,
      participantId: sourceParticipant.id,
      userId: sourceUser.userId,
      type,
      status: "USED",
      usedAt: new Date(),
      targetUserId: targetUser.userId,
    },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId,
      targetParticipantId: targetParticipant.id,
      targetUserId: targetUser.userId,
      sourceUserId: sourceUser.userId,
      powerupId: powerup.id,
      type,
      status: "ACTIVE",
      startsAt,
      expiresAt,
      ...(metadata ? { metadata } : {}),
    },
  });
}

// The full fixture every case starts from: a started two-person race with the
// creation work already drained, reason-aware envelopes on (that is what stamps
// the STEP_SYNC reason and dirty participant ids the closure gates on), and the
// shadow flag in the requested position.
async function seedRace(name, { shadow: _retiredShadowValue }) {
  const alice = await createUser(`${name} Alice`);
  const bob = await createUser(`${name} Bob`);
  const raceId = await createActiveRace(alice, [bob], name);
  await drain(makeWorker());
  await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);
  return { alice, bob, raceId };
}

async function syncAndClaim(alice, raceId, overrides = {}) {
  assert.equal((await postSamples(alice, [sampleAt(3, 4300)])).status, 200);
  const job = await RaceResolutionJobV2.findByRaceId(raceId);
  assert.deepEqual(
    job.dirtyReasons,
    ["STEP_SYNC"],
    "the fixture must produce a closure-CANDIDATE envelope, else nothing is asserted"
  );
  const uploader = await prisma.raceParticipant.findFirstOrThrow({
    where: { raceId, userId: alice.userId },
  });
  assert.ok(
    uploader.totalsUpdatedAt,
    "the inline uploader reconcile must have committed a snapshot token"
  );
  const capture = makeCapturingWorker(overrides);
  assert.ok(await capture.worker.processOne(), "the worker must claim the job");
  return capture;
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
  await appSettings.setFlag("raceResolutionPostTasksV1Enabled", false);
});

after(async () => {
  await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", false);
});

describe("Phase 2b — dependency-closure planner in shadow mode", () => {
  it("flag off: a STEP_SYNC job logs every shadow field null and never enters the planner", async () => {
    const { alice, raceId } = await seedRace("Shadow off", { shadow: false });
    const { lines, plannerCalls } = await syncAndClaim(alice, raceId);

    const committed = committedLine(lines);
    assert.ok(committed, JSON.stringify(lines));
    for (const field of SHADOW_FIELDS) {
      assert.ok(field in committed, `${field} must be present on the log line`);
      assert.equal(committed[field], null, `${field} must be null with the flag off`);
    }
    // Stronger than "the fields are null": the planner never ran, so it issued
    // no fingerprint, race, or effect-history query.
    assert.deepEqual(plannerCalls, [], "no planner work may happen with the flag off");
    assert.equal((await RaceResolutionJobV2.findByRaceId(raceId)).state, "SUCCEEDED");
  });

  it("a stale flag cannot resurrect shadow planning for an unrelated SELF effect", async () => {
    const { alice, bob, raceId } = await seedRace("Shadow self", { shadow: true });
    // One unrelated SELF row on the OTHER participant. Under the shipped guard
    // this is exactly what forces the whole field through the full resolver.
    await plantEffect({ raceId, type: "RUNNERS_HIGH", targetUser: bob, sourceUser: bob });

    const { lines, plannerCalls } = await syncAndClaim(alice, raceId);
    const committed = committedLine(lines);
    assert.ok(committed, JSON.stringify(lines));
    assert.deepEqual(plannerCalls, []);
    for (const field of SHADOW_FIELDS) assert.equal(committed[field], null);

    // The shadow changed no decision: the active effect still sends the real
    // job down the FULL resolver, exactly as before this phase.
    assert.equal(committed.resolutionPlan, "FULL");
    assert.equal((await RaceResolutionJobV2.findByRaceId(raceId)).state, "SUCCEEDED");

    // Aggregate-only: no identifier or step total may appear anywhere on the
    // line, whatever the planner handed back in memory.
    const serialized = JSON.stringify(committed);
    for (const secret of [alice.userId, bob.userId]) {
      assert.equal(serialized.includes(secret), false, "no user id may be logged");
    }
  });

  it("stale flag values leave persisted rows identical across an identical fixture", async () => {
    // TWO structurally identical races between the same pair, so one real
    // STEP_SYNC envelope can be resolved with the shadow ON and the other with
    // it OFF from the same step data — a true control, rather than a re-run of
    // an already-resolved race (which would resolve a FULL envelope and prove
    // less).
    const alice = await createUser("Parity Alice");
    const bob = await createUser("Parity Bob");
    const shadowRaceId = await createActiveRace(alice, [bob], "Parity shadow");
    const controlRaceId = await createActiveRace(alice, [bob], "Parity control");
    await drain(makeWorker());
    await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);
    for (const raceId of [shadowRaceId, controlRaceId]) {
      await plantEffect({ raceId, type: "RUNNERS_HIGH", targetUser: bob, sourceUser: bob });
    }

    // One upload dirties BOTH races with the same steps and the same envelope.
    assert.equal((await postSamples(alice, [sampleAt(3, 4300)])).status, 200);
    for (const raceId of [shadowRaceId, controlRaceId]) {
      assert.deepEqual((await RaceResolutionJobV2.findByRaceId(raceId)).dirtyReasons, [
        "STEP_SYNC",
      ]);
    }

    const shadowed = makeCapturingWorker();
    const shadowedJob = await shadowed.worker.processOne();
    assert.ok(shadowedJob);
    assert.equal(committedLine(shadowed.lines)?.shadowClosurePlan, null);
    assert.deepEqual(shadowed.plannerCalls, []);

    const control = makeCapturingWorker();
    const controlJob = await control.worker.processOne();
    assert.ok(controlJob);
    assert.notEqual(controlJob.raceId, shadowedJob.raceId, "the control is the OTHER race");
    assert.deepEqual(control.plannerCalls, [], "the control run does no planner work");
    assert.equal(committedLine(control.lines)?.shadowClosurePlan, null);

    const shadowedState = await participantState(shadowedJob.raceId);
    const controlState = await participantState(controlJob.raceId);
    assert.ok(
      shadowedState.some((row) => row.totalSteps > 0),
      "the comparison must cover non-trivial state, else this asserts nothing"
    );
    assert.deepEqual(shadowedState, controlState);
  });

  it("a stale flag cannot shadow-plan a race-wide effect", async () => {
    const { alice, bob, raceId } = await seedRace("Shadow veto", { shadow: true });
    // RALLY_FLAG is an explicit RACE_WIDE row in the v1 classification table.
    await plantEffect({ raceId, type: "RALLY_FLAG", targetUser: bob, sourceUser: bob });

    const { lines } = await syncAndClaim(alice, raceId);
    const committed = committedLine(lines);
    assert.ok(committed, JSON.stringify(lines));
    for (const field of SHADOW_FIELDS) assert.equal(committed[field], null);
    assert.equal((await RaceResolutionJobV2.findByRaceId(raceId)).state, "SUCCEEDED");
  });

  it("a stale flag cannot shadow-plan an active legacy Trail Mine", async () => {
    const { alice, bob, raceId } = await seedRace("Shadow mine", { shadow: true });
    // A LEGACY mine: metadata carries no `aheadParticipantIds`, which is the
    // shape still ACTIVE in production. Alice owns it; Bob is outside the
    // closure and already past its threshold, and there is no pre-generation
    // total anywhere to answer "was he already ahead when it was planted?".
    await plantEffect({
      raceId,
      type: "TRAIL_MINE",
      targetUser: alice,
      sourceUser: alice,
      expiresAt: null,
      metadata: { positionSteps: 5000, penaltyPercent: 10 },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: bob.userId },
      data: { totalSteps: 50000 },
    });

    const { lines } = await syncAndClaim(alice, raceId);
    const committed = committedLine(lines);
    assert.ok(committed, JSON.stringify(lines));
    for (const field of SHADOW_FIELDS) assert.equal(committed[field], null);
  });

  it("a stale flag never invokes an injected shadow planner", async () => {
    const { alice, bob, raceId } = await seedRace("Shadow failure", { shadow: true });
    await plantEffect({ raceId, type: "RUNNERS_HIGH", targetUser: bob, sourceUser: bob });

    const failure = new Error("planner exploded");
    failure.code = "PLANNER_TEST_FAILURE";
    const { lines } = await syncAndClaim(alice, raceId, {
      async buildRaceScoringDependencyClosure() {
        throw failure;
      },
    });

    const committed = committedLine(lines);
    assert.ok(committed, JSON.stringify(lines));
    // The job is entirely unaffected...
    assert.equal(committed.resolutionPlan, "FULL");
    assert.equal((await RaceResolutionJobV2.findByRaceId(raceId)).state, "SUCCEEDED");
    for (const field of SHADOW_FIELDS) {
      assert.equal(committed[field], null, `${field} must remain retired`);
    }
    const shadowError = lines.find(
      (line) => line.event === "race_resolution_v2_shadow_error"
    );
    assert.equal(shadowError, undefined);

    // Same fixture with the flag off produces the same persisted rows.
    const afterFailure = await participantState(raceId);
    await requeue(raceId);
    await drain(makeWorker());
    assert.deepEqual(await participantState(raceId), afterFailure);
  });
});
