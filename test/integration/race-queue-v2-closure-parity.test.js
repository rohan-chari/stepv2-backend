// Dependency closure — PHASE 3: the byte-parity phase.
//
// Everything here is a real HTTP request, a real Postgres row, and the real
// worker handler chain. Nothing imports a scoring internal to shortcut the
// public path: a closure result is judged only by what it persisted.
//
// The shape of every parity assertion is the same three-step comparison:
//
//   1. seed the race and resolve it once through the independent FULL test
//      baseline), so no row is at its default value and a comparison against
//      "nothing happened" cannot pass by accident;
//   2. sync, and resolve THAT generation with permanent dependency closure;
//   3. resolve an identical fixture through the FULL test seam — a real FULL
//      run over unchanged inputs — and require the closure's persisted
//      score-bearing columns to equal the FULL control's, byte for byte, for
//      every closure participant.
//
// Step 3 is what makes this a parity test rather than a snapshot test: the
// control is the shipped resolver's own output on the same inputs, not a
// number typed into this file. Non-closure rows are checked separately, and
// with `xmin` rather than column values — see participantVersions().

const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");

// Must be set BEFORE the worker module is required.
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
process.env.RACE_RESOLVE_DEBOUNCE_MS = "0";

const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const {
  buildRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const {
  buildRacePlacementTransitionWorker,
} = require("../../src/modules/races/jobs/racePlacementTransitionWorker");
const {
  RaceResolutionJobV2,
} = require("../../src/modules/races/models/raceResolutionJobV2");
const { appSettings } = require("../../src/shared/config/appSettings");
const {
  buildRaceScoringDependencyClosure,
} = require("../../src/modules/races/services/raceScoringDependencyClosure");


let server;
let nextAppleId = 0;
const HOUR_MS = 60 * 60 * 1000;

before(async () => {
  server = await getSharedServer();
});

beforeEach(async () => {
  await cleanDatabase();
  await prisma.globalStepEvent.deleteMany({});
  await appSettings.setFlag("raceQueueV2ClaimingDisabled", false);
  await appSettings.setFlag("inlineRaceResolutionFallback", false);
  await appSettings.setFlag("raceResolutionBulkWriteV1Enabled", false);
  await appSettings.setFlag("raceResolutionBurstCoalescingV1Enabled", false);
  await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", false);
  await appSettings.setFlag("raceResolutionPostTasksV1Enabled", false);
});

after(async () => {});

// ── fixtures ───────────────────────────────────────────────────────────────

async function createUser(displayName) {
  const appleId = `apple-closure-${++nextAppleId}-${Date.now()}`;
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

// One CLOSED hourly bucket `hoursAgo` back. Open buckets score zero, so every
// fixture sample must be closed or the scenario asserts nothing.
function sampleAt(hoursAgo, steps) {
  const end = new Date(Date.now() - hoursAgo * HOUR_MS);
  const start = new Date(end.getTime() - HOUR_MS);
  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    steps,
  };
}

function alignedHoursAgo(hoursAgo) {
  return new Date(
    Math.floor((Date.now() - hoursAgo * HOUR_MS) / HOUR_MS) * HOUR_MS
  );
}

async function postSamples(user, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", {
    body: { samples },
    token: user.token,
  });
}

// Effects are planted directly, never through /powerups/use: the route stamps a
// POWERUP_MUTATION reason on the resolution job, which demotes the envelope out
// of closure candidacy and would make every scenario below silently test FULL.
async function plantEffect({
  raceId,
  type,
  targetUser,
  sourceUser,
  startsAt = alignedHoursAgo(6),
  expiresAt = new Date(Date.now() + HOUR_MS),
  metadata = undefined,
  status = "ACTIVE",
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
      status,
      startsAt,
      expiresAt,
      ...(metadata ? { metadata } : {}),
    },
  });
}

// ── worker driving ─────────────────────────────────────────────────────────

function makeWorker(overrides = {}) {
  // bootAt 0 => the startup quiet period has provably elapsed.
  return buildRaceResolutionWorkerV2({ bootAt: 0, ...overrides });
}

function makeCapturingWorker(overrides = {}) {
  const lines = [];
  const push = (line) => {
    try {
      lines.push(JSON.parse(line));
    } catch {
      lines.push({ raw: String(line) });
    }
  };
  const worker = makeWorker({
    logger: { log: push, error: push },
    ...overrides,
  });
  return { worker, lines };
}

function committedLine(lines) {
  return lines.find(
    (line) => line.event === "race_resolution_v2" && line.outcome === "commit"
  );
}

async function drain(worker = makeWorker(), maxJobs = 50) {
  const claimed = [];
  for (let i = 0; i < maxJobs; i++) {
    const job = await worker.processOne();
    if (!job) break;
    claimed.push(job);
  }
  return claimed;
}

async function requeue(raceId) {
  await prisma.$executeRawUnsafe(
    `UPDATE race_resolution_jobs_v2
     SET state = 'queued', not_before_at = NULL, generation = generation + 1
     WHERE race_id = $1`,
    raceId
  );
}

// ── persisted-state readers ────────────────────────────────────────────────

// The score-bearing surface a closure participant must match FULL on, byte for
// byte. `totalsUpdatedAt` is deliberately excluded: it is a wall-clock stamp
// that differs between any two runs and carries no score.
async function participantState(raceId) {
  return prisma.$queryRawUnsafe(
    `SELECT participant.id,
            participant.user_id       AS "userId",
            participant.total_steps   AS "totalSteps",
            participant.raw_steps     AS "rawSteps",
            participant.bonus_steps   AS "bonusSteps",
            participant.max_bonus_steps AS "maxBonusSteps",
            participant.next_box_at_steps AS "nextBoxAtSteps",
            participant.finish_total_steps AS "finishTotalSteps"
     FROM race_participants participant
     WHERE participant.race_id = $1
     ORDER BY participant.id ASC`,
    raceId
  );
}

// Physical proof that a row was not written AT ALL. `xmin` is the tuple's
// inserting/updating transaction id: any UPDATE produces a new tuple version
// with a new xmin, even one that writes the identical value. Comparing xmin is
// therefore strictly stronger than comparing columns, and it is the only way to
// prove "the closure did not touch this participant" rather than "the closure
// happened to write the same number back".
async function participantVersions(raceId) {
  return prisma.$queryRawUnsafe(
    `SELECT id, user_id AS "userId", xmin::text AS version
     FROM race_participants WHERE race_id = $1 ORDER BY id ASC`,
    raceId
  );
}

function byUser(rows) {
  return new Map(rows.map((row) => [row.userId, row]));
}

function scoreColumns(row) {
  return {
    totalSteps: row.totalSteps,
    rawSteps: row.rawSteps,
    bonusSteps: row.bonusSteps,
    maxBonusSteps: row.maxBonusSteps,
    nextBoxAtSteps: row.nextBoxAtSteps,
    finishTotalSteps: row.finishTotalSteps,
  };
}

// ── the parity driver ──────────────────────────────────────────────────────

// Seeds a race, resolves it once as FULL with every flag off, and returns the
// handles a scenario needs. Resolving first matters: it leaves every row
// carrying a real computed total, so a later "unchanged" assertion is about a
// meaningful value and not about a column still sitting at its default.
async function seedRace(name, userCount) {
  const users = [];
  for (let i = 0; i < userCount; i++) {
    users.push(await createUser(`${name} ${i}`));
  }
  const raceId = await createActiveRace(users[0], users.slice(1), name);
  return { users, raceId };
}

// Source intake stamps STEP_INPUT_CHANGED on the job envelope. The reason is
// deliberately distinct from already-committed STEP_SYNC so the worker always
// derives the uploader from canonical source before admitting closure.
async function armClosureFixture({ write = true } = {}) {
  await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);
  return write;
}

// Models participant state already committed by the pre-queue uploader path
// while preserving canonical samples for the next FULL computation. This is a
// mixed-version fixture, not an assertion about the new public intake path:
// current intake is queue-only, but STEP_SYNC still supports committed state
// produced before/during a rolling deployment.
async function modelPreviouslyCommittedUploader({ raceId, userId, totalSteps }) {
  await prisma.raceParticipant.updateMany({
    where: { raceId, userId },
    data: { rawSteps: totalSteps, totalSteps },
  });
  await prisma.$executeRawUnsafe(
    `DELETE FROM race_resolution_jobs_v2 WHERE race_id = $1`,
    raceId
  );
}

/**
 * Seeds a fresh race, applies the scenario's fixture, runs exactly ONE
 * generation, and returns everything needed to judge it.
 *
 * The control is a SECOND, INDEPENDENTLY SEEDED race — never a re-run of the
 * same one. Re-running would compare against a race the closure had already
 * mutated, and two columns make that unsound:
 *
 *   * `raw_steps` is a HIGH-WATER value (`nextRawSteps`). If a closure wrote a
 *     too-HIGH raw figure, a re-run over the same row could only high-water it
 *     back to the same wrong number — so the bug would survive and the
 *     comparison would still pass. A separate race has never seen the bad
 *     write, so its raw figure is derived only from the posted samples.
 *   * `bonus_steps` decrements (a Trail Mine penalty) fold into `total_steps`
 *     only on the NEXT generation, so a re-run is not idempotent across a
 *     detonation either.
 *
 * Totals depend only on step samples and effect rows, never on user identity,
 * so two identically-seeded races must agree role for role.
 */
async function runScenarioOnce({
  name, userCount, build, uploaderIndex = 0, samples, closureWrites, overrides,
}) {
  const { users, raceId } = await seedRace(name, userCount);
  await build({ raceId, users });

  await armClosureFixture({ write: closureWrites });
  const uploader = users[uploaderIndex];
  assert.equal((await postSamples(uploader, samples)).status, 200);

  const job = await RaceResolutionJobV2.findByRaceId(raceId);
  assert.deepEqual(
    job.dirtyReasons,
    ["STEP_INPUT_CHANGED"],
    "the fixture must produce a closure-CANDIDATE envelope, else the scenario asserts nothing"
  );

  const versionsBefore = await participantVersions(raceId);
  const capture = makeCapturingWorker({
    dependencyClosureEnabled: closureWrites,
    ...(overrides || {}),
  });
  assert.ok(await capture.worker.processOne(), "the worker must claim the job");

  return {
    raceId,
    users,
    line: committedLine(capture.lines),
    state: await participantState(raceId),
    versionsBefore,
    versionsAfter: await participantVersions(raceId),
    lines: capture.lines,
  };
}

/** Runs a scenario twice: once as a closure, once as an independent FULL control. */
async function runParityScenario(options) {
  const closureRun = await runScenarioOnce({
    ...options, name: `${options.name}C`, closureWrites: true,
  });
  const controlRun = await runScenarioOnce({
    ...options, name: `${options.name}F`, closureWrites: false,
  });
  return { closureRun, controlRun };
}

/**
 * The assertion every parity scenario shares.
 *
 * `closureRoles` are indices into the scenario's `users` array — the
 * participants the planner was expected to put in the closure. Their persisted
 * score columns must equal the independent FULL control's exactly, role for
 * role. Everyone else must have been left physically untouched by the closure
 * generation.
 */
function assertParity({ closureRun, controlRun }, closureRoles) {
  assert.ok(closureRun.line, "the closure generation must have committed");
  assert.equal(
    closureRun.line.resolutionPlan,
    "DEPENDENCY_CLOSURE",
    "expected the DEPENDENCY_CLOSURE plan; a scenario that silently ran FULL proves nothing"
  );
  assert.equal(
    controlRun.line.resolutionPlan,
    "FULL",
    "the control must be a real full resolution"
  );

  const closureRows = byUser(closureRun.state);
  const controlRows = byUser(controlRun.state);
  const closureUserIds = new Set(closureRoles.map((i) => closureRun.users[i].userId));

  let compared = 0;
  let sawRawSteps = false;
  for (const role of closureRoles) {
    const got = closureRows.get(closureRun.users[role].userId);
    const want = controlRows.get(controlRun.users[role].userId);
    assert.ok(got && want, "both races must have persisted the closure member");
    assert.deepEqual(
      scoreColumns(got),
      scoreColumns(want),
      `closure role ${role} must match the independent FULL control byte for byte`
    );
    if (got.rawSteps > 0) sawRawSteps = true;
    compared += 1;
  }
  assert.ok(compared > 0, "the scenario must compare at least one closure member");
  // `raw_steps` is the high-water column the same-race control could not police.
  // Requiring it to be non-zero somewhere makes its comparison non-vacuous.
  assert.ok(
    sawRawSteps,
    "at least one closure member must carry a non-zero raw_steps, else the high-water column is untested"
  );

  // Non-members: physically untouched by the closure generation.
  const before = byUser(closureRun.versionsBefore);
  const after = byUser(closureRun.versionsAfter);
  let untouched = 0;
  for (const [userId, row] of after) {
    if (closureUserIds.has(userId)) continue;
    assert.equal(
      row.version,
      before.get(userId)?.version,
      `non-closure participant ${userId} must not have been written at all`
    );
    untouched += 1;
  }
  return { compared, untouched };
}

// Every parity scenario must move real numbers. A race where everyone scored
// zero would satisfy deepEqual trivially.
function assertNonTrivial(state) {
  assert.ok(
    state.some((row) => row.totalSteps > 0),
    "the comparison must cover non-trivial state, else it asserts nothing"
  );
}

// ── 1. parity matrix ───────────────────────────────────────────────────────

describe("dependency closure — byte parity with the full resolver", () => {
  it("records the identical actor-target participant set at selection and at the fenced recheck", async () => {
    const { users, raceId } = await seedRace("DependencyIdentity", 3);
    const [alice, bob, unrelated] = users;
    await postSamples(bob, [sampleAt(5, 3100)]);
    await postSamples(unrelated, [sampleAt(5, 2400)]);
    await drain();
    await plantEffect({
      raceId,
      type: "LEECH",
      targetUser: alice,
      sourceUser: bob,
    });
    await armClosureFixture();
    assert.equal((await postSamples(alice, [sampleAt(3, 4300)])).status, 200);

    const participantRows = await prisma.raceParticipant.findMany({
      where: { raceId },
      select: { id: true, userId: true },
    });
    const idByUser = new Map(participantRows.map((row) => [row.userId, row.id]));
    const expectedIds = [idByUser.get(alice.userId), idByUser.get(bob.userId)].sort();
    const traces = [];
    const { worker } = makeCapturingWorker({
      recordDependencySelectionTrace(trace) {
        traces.push(trace);
      },
    });

    assert.ok(await worker.processOne());
    assert.deepEqual(
      traces.map(({ stage, participantIds, participantCount, plan, fallbackReason }) => ({
        stage,
        participantIds,
        participantCount,
        plan,
        fallbackReason,
      })),
      [
        {
          stage: "initial_selection",
          participantIds: expectedIds,
          participantCount: 2,
          plan: "DEPENDENCY_CLOSURE",
          fallbackReason: null,
        },
        {
          stage: "fenced_recheck",
          participantIds: expectedIds,
          participantCount: 2,
          plan: "DEPENDENCY_CLOSURE",
          fallbackReason: null,
        },
      ],
    );
  });

  it("unrelated SELF effect: only the uploader is scored and written", async () => {
    const runs = await runParityScenario({
      name: "SelfEffect",
      userCount: 3,
      samples: [sampleAt(3, 4300)],
      build: async ({ raceId, users: [, bob, carol] }) => {
        await postSamples(bob, [sampleAt(5, 3100)]);
        await postSamples(carol, [sampleAt(5, 2400)]);
        await drain();
        // A Runner's High on carol. It is SELF-classified: no dependency edge,
        // so it must not pull carol into alice's closure — and, crucially, must
        // not veto the closure either, which is the whole point of the feature.
        await plantEffect({
          raceId, type: "RUNNERS_HIGH", targetUser: carol, sourceUser: carol,
          metadata: { multiplier: 2 },
        });
      },
    });
    assertNonTrivial(runs.closureRun.state);
    const { compared, untouched } = assertParity(runs, [0]);
    assert.equal(compared, 1);
    assert.equal(untouched, 2, "bob and carol must both be untouched");
    assert.equal(runs.closureRun.line.shadowClosureCount, null,
      "the shadow fields stay null while only the WRITE flag is on");
  });

  it("Leech target with multiple leechers: every leecher is in the closure", async () => {
    const runs = await runParityScenario({
      name: "MultiLeech",
      userCount: 4,
      samples: [sampleAt(3, 9000)],
      build: async ({ raceId, users }) => {
        const [alice, bob, carol, dave] = users;
        for (const u of [bob, carol, dave]) {
          await postSamples(u, [sampleAt(5, 3000), sampleAt(4, 2600)]);
        }
        await drain();
        // Two leeches draining alice, sourced by bob and carol. dave is unrelated.
        await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: bob });
        await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: carol });
      },
    });
    assertNonTrivial(runs.closureRun.state);
    const { compared, untouched } = assertParity(runs, [0, 1, 2]);
    assert.equal(compared, 3);
    assert.equal(untouched, 1, "dave is outside the component and must be untouched");
  });

  it("transitive Leech chain: the closure expands to fixed point", async () => {
    const runs = await runParityScenario({
      name: "LeechChain",
      userCount: 4,
      samples: [sampleAt(3, 9000)],
      build: async ({ raceId, users }) => {
        const [alice, bob, carol, dave] = users;
        for (const u of [bob, carol, dave]) {
          await postSamples(u, [sampleAt(5, 3000), sampleAt(4, 2600)]);
        }
        await drain();
        // alice <- bob <- carol. Syncing alice must pull in BOTH, not just bob.
        await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: bob });
        await plantEffect({ raceId, type: "LEECH", targetUser: bob, sourceUser: carol });
      },
    });
    assertNonTrivial(runs.closureRun.state);
    const { compared, untouched } = assertParity(runs, [0, 1, 2]);
    assert.equal(compared, 3);
    assert.equal(untouched, 1);
  });

  it("both Hitchhike scoring versions match FULL", async () => {
    const runs = await runParityScenario({
      name: "Hitchhike",
      userCount: 4,
      samples: [sampleAt(3, 6000)],
      build: async ({ raceId, users }) => {
        const [alice, bob, carol, dave] = users;
        for (const u of [bob, carol, dave]) await postSamples(u, [sampleAt(5, 3000)]);
        await drain();
        // v1 (legacy top-of-hour copy) links bob to alice; v2 (shared scorer,
        // clipped) links dave to carol. Syncing alice must reproduce bob's copy
        // exactly and leave the carol/dave component alone.
        await plantEffect({
          raceId, type: "HITCHHIKE", targetUser: alice, sourceUser: bob,
          metadata: { scoringVersion: 1 },
        });
        await plantEffect({
          raceId, type: "HITCHHIKE", targetUser: carol, sourceUser: dave,
          metadata: { scoringVersion: 2 },
        });
      },
    });
    assertNonTrivial(runs.closureRun.state);
    const { compared, untouched } = assertParity(runs, [0, 1]);
    assert.equal(compared, 2);
    assert.equal(untouched, 2, "the carol/dave hitchhike component is untouched");
  });

  it("mixed Leech + Hitchhike graph matches FULL", async () => {
    const runs = await runParityScenario({
      name: "Mixed",
      userCount: 4,
      samples: [sampleAt(3, 9000)],
      build: async ({ raceId, users }) => {
        const [alice, bob, carol, dave] = users;
        for (const u of [bob, carol, dave]) {
          await postSamples(u, [sampleAt(5, 3000), sampleAt(4, 2200)]);
        }
        await drain();
        // bob leeches alice; carol hitchhikes bob. The chain crosses effect
        // types, which is the case a per-type closure would get wrong.
        await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: bob });
        await plantEffect({
          raceId, type: "HITCHHIKE", targetUser: bob, sourceUser: carol,
          metadata: { scoringVersion: 2 },
        });
      },
    });
    assertNonTrivial(runs.closureRun.state);
    const { compared, untouched } = assertParity(runs, [0, 1, 2]);
    assert.equal(compared, 3);
    assert.equal(untouched, 1);

    // Score computation may safely write only the dependency closure, but a
    // placement transition is global: the durable handoff must rank the full
    // canonical roster. Give every participant an intentionally stale
    // baseline, then prove all four (including the untouched score row) are
    // projected from this closure generation.
    await prisma.raceParticipant.updateMany({
      where: { raceId: runs.closureRun.raceId },
      data: { lastNotifiedPlacement: 99 },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE race_placement_transition_jobs
          SET not_before_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE race_id = $1`,
      runs.closureRun.raceId,
    );
    const placement = buildRacePlacementTransitionWorker();
    const result = await placement.processOne();
    assert.ok(result, "the closure generation must leave a placement handoff");
    assert.equal(result.job.raceId, runs.closureRun.raceId);
    assert.equal(result.metrics.placementProposed, 4);
    assert.equal(result.metrics.placementEventInserts, 4);
    const projected = await prisma.raceParticipant.findMany({
      where: { raceId: runs.closureRun.raceId },
      select: { lastNotifiedPlacement: true },
    });
    assert.deepEqual(
      projected.map((row) => row.lastNotifiedPlacement).sort((a, b) => a - b),
      [1, 2, 3, 4],
      "the placement worker must rank the full race rather than the score closure",
    );
  });

  it("frozen Leech source still drains its victim and receives no credit", async () => {
    const runs = await runParityScenario({
      name: "FrozenLeech",
      userCount: 3,
      samples: [sampleAt(3, 9000)],
      build: async ({ raceId, users }) => {
        const [alice, bob, carol] = users;
        await postSamples(bob, [sampleAt(5, 4000), sampleAt(4, 3000)]);
        await postSamples(carol, [sampleAt(5, 1000)]);
        await drain();
        await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: bob });
        // bob forfeits AFTER the drain, so his total is frozen. Spec rule 9: the
        // victim is still drained; bob's credit is dropped. The closure must
        // retain bob as an input and reproduce both halves of that.
        await prisma.raceParticipant.updateMany({
          where: { raceId, userId: bob.userId },
          data: { forfeitedAt: new Date() },
        });
      },
    });
    assertNonTrivial(runs.closureRun.state);
    // bob is in the closure but frozen, so he is scored-in but never written —
    // parity for him means "the same frozen number FULL leaves".
    assertParity(runs, [0, 1]);
  });

  it("finished and forfeited participants keep identical frozen totals", async () => {
    const runs = await runParityScenario({
      name: "Frozen",
      userCount: 4,
      samples: [sampleAt(3, 9000)],
      build: async ({ raceId, users }) => {
        const [alice, bob, carol, dave] = users;
        for (const u of [bob, carol, dave]) await postSamples(u, [sampleAt(5, 3300)]);
        await drain();
        await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: bob });
        await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: carol });
        await prisma.raceParticipant.updateMany({
          where: { raceId, userId: bob.userId },
          data: { finishedAt: new Date(), finishTotalSteps: 4242 },
        });
        await prisma.raceParticipant.updateMany({
          where: { raceId, userId: carol.userId },
          data: { forfeitedAt: new Date() },
        });
      },
    });
    assertNonTrivial(runs.closureRun.state);
    assertParity(runs, [0, 1, 2]);
    const rows = byUser(runs.closureRun.state);
    assert.equal(rows.get(runs.closureRun.users[1].userId).finishTotalSteps, 4242,
      "a finished participant's frozen total must survive the closure untouched");
  });

  it("joinedAt raw-score tie resolves identically", async () => {
    const runs = await runParityScenario({
      name: "Tie",
      userCount: 3,
      samples: [sampleAt(3, 5000)],
      build: async ({ raceId, users }) => {
        const [alice, bob, carol] = users;
        // Identical samples => identical raw scores; the tie is broken by joinedAt.
        await postSamples(bob, [sampleAt(5, 5000)]);
        await postSamples(carol, [sampleAt(5, 5000)]);
        const joined = new Date(Date.now() - 8 * HOUR_MS);
        await prisma.raceParticipant.updateMany({
          where: { raceId, userId: bob.userId }, data: { joinedAt: joined },
        });
        await prisma.raceParticipant.updateMany({
          where: { raceId, userId: carol.userId },
          data: { joinedAt: new Date(joined.getTime() + 1000) },
        });
        await drain();
        await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: bob });
        await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: carol });
      },
    });
    assertNonTrivial(runs.closureRun.state);
    assertParity(runs, [0, 1, 2]);
  });
});

// ── 2. Trail Mine escalation trio ──────────────────────────────────────────

async function plantMine({ raceId, owner, positionSteps, aheadParticipantIds }) {
  return plantEffect({
    raceId,
    type: "TRAIL_MINE",
    targetUser: owner,
    sourceUser: owner,
    expiresAt: null,
    metadata: {
      positionSteps,
      penaltyPercent: 0.1,
      ...(aheadParticipantIds ? { aheadParticipantIds } : {}),
    },
  });
}

describe("dependency closure — Trail Mine escalation", () => {
  // A detonation is the ONE scenario the requeue-and-rerun control cannot judge,
  // and the reason is worth stating because it looks like a parity bug.
  //
  // `triggerTrailMines` writes the penalty as a `bonus_steps` DECREMENT and
  // mutates only its in-memory copy of the victim's total; the victim's
  // persisted `total_steps` still holds the pre-detonation figure until the NEXT
  // generation re-scores them with the new bonus folded in. So re-running the
  // same race is not idempotent here — the rerun legitimately reports a lower
  // total than the generation that detonated, on the closure and FULL paths
  // alike. Comparing across that boundary would be comparing two different
  // generations, not two plans.
  //
  // The control is therefore a SECOND, structurally identical race resolved
  // under the FULL path. Totals depend only on step samples and effect rows, so
  // two identically-seeded races must produce identical numbers role for role.
  async function runMineScenario({ name, closureWrites }) {
    const { users, raceId } = await seedRace(name, 3);
    const [alice, bob, carol] = users;
    await postSamples(bob, [sampleAt(5, 3000), sampleAt(4, 2500)]);
    await postSamples(carol, [sampleAt(5, 200)]);
    await drain();

    // bob leeches alice, so both are in the closure. carol stays far behind the
    // mine, so she can never be a candidate and no escalation is warranted.
    await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: bob });
    const participants = await prisma.raceParticipant.findMany({ where: { raceId } });
    const aheadIds = participants
      .filter((p) => p.userId !== alice.userId)
      .map((p) => p.id);
    // The mine is planted by carol at a position alice is about to cross.
    // `aheadParticipantIds` records who was already past it at plant time, so
    // the answer for every non-closure row is a definite NO — the tri-state
    // must be `false`, not UNKNOWN.
    await plantMine({
      raceId, owner: carol, positionSteps: 1000, aheadParticipantIds: aheadIds,
    });

    await armClosureFixture({ write: closureWrites });
    const versionsBefore = await participantVersions(raceId);
    assert.equal((await postSamples(alice, [sampleAt(3, 9000)])).status, 200);
    const { worker, lines } = makeCapturingWorker({
      dependencyClosureEnabled: closureWrites,
    });
    assert.ok(await worker.processOne());

    return {
      raceId,
      roles: { alice, bob, carol },
      line: committedLine(lines),
      state: byUser(await participantState(raceId)),
      versionsBefore,
      versionsAfter: byUser(await participantVersions(raceId)),
    };
  }

  it("(i) a closure-member victim detonates byte-identically to FULL", async () => {
    const closureRun = await runMineScenario({ name: "MineIn", closureWrites: true });
    const controlRun = await runMineScenario({ name: "MineCtl", closureWrites: false });

    assert.equal(closureRun.line.resolutionPlan, "DEPENDENCY_CLOSURE");
    assert.equal(controlRun.line.resolutionPlan, "FULL",
      "the control must be a real full resolution");
    assert.equal(
      closureRun.line.closureEscalatedOnMine,
      false,
      "no non-closure candidate exists, so the mine must detonate inside the closure"
    );

    // Byte parity, role for role, for both closure members.
    for (const role of ["alice", "bob"]) {
      const got = closureRun.state.get(closureRun.roles[role].userId);
      const want = controlRun.state.get(controlRun.roles[role].userId);
      assert.deepEqual(
        scoreColumns(got),
        scoreColumns(want),
        `${role} must match the FULL control byte for byte through the detonation`
      );
    }
    assert.ok(
      closureRun.state.get(closureRun.roles.alice.userId).bonusSteps < 0,
      "the detonation must actually have penalised the victim, else parity is vacuous"
    );

    // The non-closure participant was never written by the closure generation.
    assert.equal(
      closureRun.versionsAfter.get(closureRun.roles.carol.userId).version,
      byUser(closureRun.versionsBefore).get(closureRun.roles.carol.userId).version,
      "carol is outside the closure and must not have been written"
    );

    // And the detonation really happened, once, on the closure path.
    const mine = await prisma.raceActiveEffect.findFirstOrThrow({
      where: { raceId: closureRun.raceId, type: "TRAIL_MINE" },
    });
    assert.equal(mine.status, "EXPIRED", "the mine must have fired");
    const feed = await prisma.racePowerupEvent.findMany({
      where: { raceId: closureRun.raceId, powerupType: "TRAIL_MINE" },
    });
    assert.equal(feed.length, 1, "exactly one detonation feed event");
    assert.equal(feed[0].targetUserId, closureRun.roles.alice.userId);
  });

  it("(ii) a non-closure crosser escalates to FULL with the mine still ACTIVE and zero partial writes", async () => {
    const { users, raceId } = await seedRace("MineOut", 3);
    const [alice, bob, carol] = users;
    await postSamples(bob, [sampleAt(5, 500)]);
    await postSamples(carol, [sampleAt(5, 400)]);
    await drain();

    await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: bob });
    // Nobody was past the mine when it was planted, so any crosser is a real
    // candidate and the tri-state answer is a definite `true` rather than the
    // legacy UNKNOWN.
    await plantMine({
      raceId, owner: alice, positionSteps: 5000, aheadParticipantIds: [],
    });

    // carol is NOT in alice's closure. Her canonical source advances past the
    // mine, and the persisted participant fixture models state committed by a
    // pre-queue/mixed-version uploader path. She is intentionally absent from
    // the next dirty set so the closure must detect the outside crosser.
    await armClosureFixture({ write: false });
    assert.equal((await postSamples(carol, [sampleAt(2, 12000)])).status, 200);
    await modelPreviouslyCommittedUploader({
      raceId,
      userId: carol.userId,
      totalSteps: 12000,
    });

    const carolRow = await prisma.raceParticipant.findFirstOrThrow({
      where: { raceId, userId: carol.userId },
    });
    assert.ok(carolRow.totalSteps >= 5000,
      "the mixed-version fixture must persist carol past the mine, else nothing escalates");
    const mineBefore = await prisma.raceActiveEffect.findFirstOrThrow({
      where: { raceId, type: "TRAIL_MINE" },
    });
    assert.equal(mineBefore.status, "ACTIVE",
      "the fixture must reach the closure generation with the mine unfired");

    const versionsBefore = await participantVersions(raceId);
    assert.equal((await postSamples(alice, [sampleAt(3, 400)])).status, 200);
    const { worker, lines } = makeCapturingWorker();
    assert.ok(await worker.processOne());
    const line = committedLine(lines);

    assert.equal(line.closureEscalatedOnMine, true,
      "a non-closure crosser must escalate the generation");
    assert.equal(line.resolutionPlan, "FULL",
      "the escalated generation must run the FULL resolver, never a scoped one");
    // "Zero partial writes" is structural here: the escalation happens before
    // the resolve, so no closure-scoped write ever reached the fence. What the
    // FULL rerun then writes is the correct full-field result — the thing that
    // must NOT exist is a subset write, and the mine proves it: it fired once,
    // against the whole field.
    const feed = await prisma.racePowerupEvent.findMany({
      where: { raceId, powerupType: "TRAIL_MINE" },
    });
    assert.equal(feed.length, 1, "the escalated FULL run detonates exactly once");
    assert.equal(feed[0].targetUserId, carol.userId,
      "the victim is the non-closure crosser the closure could not have seen");
    assert.notDeepEqual(await participantVersions(raceId), versionsBefore,
      "the escalated generation must still have committed the full state");
  });

  it("a FINISHED non-closure participant is judged at its frozen total, not its persisted one", async () => {
    const { users, raceId } = await seedRace("MineFinished", 4);
    const [alice, bob, carol, dave] = users;
    await postSamples(bob, [sampleAt(6, 300)]);
    await postSamples(carol, [sampleAt(6, 300)]);
    await postSamples(dave, [sampleAt(6, 300)]);
    await drain();

    await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: bob });
    await plantMine({
      raceId, owner: dave, positionSteps: 5000, aheadParticipantIds: [],
    });

    // carol is FINISHED, and her frozen `finish_total_steps` is well PAST the
    // mine while her persisted `total_steps` is well short of it.
    //
    // `triggerTrailMines` scores a finished row at `finishTotalSteps ??
    // totalSteps`, so carol IS a live candidate. A projection that read only
    // `total_steps` would judge her "not a candidate", report no escalation,
    // and let the closure detonate on the wrong player — after which the mine
    // EXPIREs, which is unrecoverable.
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: carol.userId },
      data: { finishedAt: new Date(), finishTotalSteps: 9000, totalSteps: 400 },
    });

    await armClosureFixture();
    assert.equal((await postSamples(alice, [sampleAt(3, 200)])).status, 200);
    const { worker, lines } = makeCapturingWorker();
    assert.ok(await worker.processOne());
    const line = committedLine(lines);

    assert.equal(line.closureEscalatedOnMine, true,
      "a finished non-closure participant past the mine at its FROZEN total must escalate");
    assert.equal(line.resolutionPlan, "FULL");
    const feed = await prisma.racePowerupEvent.findMany({
      where: { raceId, powerupType: "TRAIL_MINE" },
    });
    assert.equal(feed.length, 1);
    assert.equal(feed[0].targetUserId, carol.userId,
      "the FULL rerun must hit the finished participant the closure could not have seen");
  });

  it("(iii) an in+out crosser pair escalates and the FULL rerun picks the lower-total victim", async () => {
    const { users, raceId } = await seedRace("MinePair", 4);
    const [alice, bob, carol, dave] = users;
    await postSamples(bob, [sampleAt(6, 300)]);
    await postSamples(carol, [sampleAt(6, 300)]);
    await postSamples(dave, [sampleAt(6, 300)]);
    await drain();

    // bob is inside alice's closure (leech). carol is outside it.
    await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: bob });
    await plantMine({
      raceId, owner: dave, positionSteps: 1200, aheadParticipantIds: [],
    });

    // BOTH canonical sources cross the mine. Persisted participant fixtures
    // model pre-queue/mixed-version committed uploader state, with carol the
    // LOWER of the two. `candidates[0]` is the lowest-total crosser, so a
    // closure that scored only {alice, bob} would detonate on bob — the wrong
    // player — and then EXPIRE the mine, which is unrecoverable. Escalating
    // and re-running FULL must pick carol.
    await armClosureFixture({ write: false });
    assert.equal((await postSamples(carol, [sampleAt(5, 1400)])).status, 200);
    await modelPreviouslyCommittedUploader({
      raceId,
      userId: carol.userId,
      totalSteps: 1400,
    });
    assert.equal((await postSamples(bob, [sampleAt(5, 9000)])).status, 200);
    await modelPreviouslyCommittedUploader({
      raceId,
      userId: bob.userId,
      totalSteps: 9000,
    });

    const mineStillActive = await prisma.raceActiveEffect.findFirstOrThrow({
      where: { raceId, type: "TRAIL_MINE" },
    });
    assert.equal(mineStillActive.status, "ACTIVE",
      "the fixture must reach the closure generation with the mine unfired");

    // A deliberately tiny upload: alice must stay BELOW the mine so the victim
    // choice is genuinely between the in-closure and out-of-closure crossers.
    assert.equal((await postSamples(alice, [sampleAt(3, 200)])).status, 200);
    const { worker, lines } = makeCapturingWorker();
    assert.ok(await worker.processOne());
    const line = committedLine(lines);

    assert.equal(line.closureEscalatedOnMine, true);
    assert.equal(line.resolutionPlan, "FULL");

    const feed = await prisma.racePowerupEvent.findMany({
      where: { raceId, powerupType: "TRAIL_MINE" },
    });
    assert.equal(feed.length, 1, "the escalated FULL run must have detonated the mine once");
    const victimTotals = await prisma.raceParticipant.findMany({
      where: { raceId, userId: { in: [bob.userId, carol.userId] } },
    });
    const bobTotal = victimTotals.find((p) => p.userId === bob.userId).totalSteps;
    const carolTotal = victimTotals.find((p) => p.userId === carol.userId).totalSteps;
    assert.ok(carolTotal < bobTotal,
      "the fixture must keep carol the LOWER-total crosser, else the choice is untested");
    assert.equal(feed[0].targetUserId, carol.userId,
      "the FULL rerun must hit the lowest-total crosser, who is outside the closure");
  });
});

// ── 3. fence ───────────────────────────────────────────────────────────────

describe("dependency closure — fence", () => {
  // Injects a planner wrapper that runs the REAL planner and then mutates the
  // world, simulating a change landing between the graph read and the fence.
  function plannerThen(mutate) {
    return async (args) => {
      const plan = await buildRaceScoringDependencyClosure(args);
      await mutate(plan);
      return plan;
    };
  }

  it("an effect created between the graph read and the fence rejects the closure and commits full state", async () => {
    const { users, raceId } = await seedRace("FenceEffect", 3);
    const [alice, bob, carol] = users;
    await postSamples(bob, [sampleAt(5, 3000)]);
    await postSamples(carol, [sampleAt(5, 2000)]);
    await drain();
    await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: bob });

    await armClosureFixture();
    assert.equal((await postSamples(alice, [sampleAt(3, 8000)])).status, 200);

    const { worker, lines } = makeCapturingWorker({
      buildRaceScoringDependencyClosure: plannerThen(async () => {
        // A brand-new effect the planner never saw. The fingerprint moves, so
        // the in-fence re-verify must reject.
        await plantEffect({
          raceId, type: "RUNNERS_HIGH", targetUser: carol, sourceUser: carol,
          metadata: { multiplier: 2 },
        });
      }),
    });
    assert.ok(await worker.processOne());
    const line = committedLine(lines);

    assert.equal(line.resolutionPlan, "FULL",
      "a rejected closure must retry the same generation as FULL");
    assert.equal(line.closureFenceRejections, 1,
      "exactly one fence rejection must have been recorded");
    // The current FULL state was committed, not skipped.
    const state = await participantState(raceId);
    assertNonTrivial(state);
  });

  it("an effect on a non-closure participant that becomes due between plan selection and the fence rejects the closure, and its stepsAtExpiry is still stamped", async () => {
    const { users, raceId } = await seedRace("FenceExpiry", 3);
    const [alice, bob, carol] = users;
    await postSamples(bob, [sampleAt(5, 3000)]);
    await postSamples(carol, [sampleAt(5, 4000)]);
    await drain();
    await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: bob });

    // A RUNNERS_HIGH (a SNAPSHOT_AT_EXPIRY type) on carol, who is NOT in
    // alice's closure, expiring 20 SECONDS out.
    //
    // The timing is the whole test, and it isolates the fence check from every
    // other rejection reason:
    //   * at the planner's `asOf` the row is NOT yet due, so the planner's own
    //     DUE_EXPIRY_OUTSIDE_CLOSURE veto does not fire — that veto only sees
    //     rows already due at that instant;
    //   * it contributes NO `validUntil` boundary, because the deadline's
    //     effect term enumerates CLOSURE-RELEVANT effects only and carol is in
    //     neither end of the closure — this is precisely the hole;
    //   * nothing is mutated, so the fingerprint digest still MATCHES. An
    //     earlier version of this test moved `expiresAt` from a planner hook
    //     and passed with the fence check disabled, because the mutation
    //     tripped the digest comparison instead. Leaving the row alone is what
    //     makes the assertion actually about POST_COMMIT_SLACK_MS.
    const carolEffect = await plantEffect({
      raceId, type: "RUNNERS_HIGH", targetUser: carol, sourceUser: carol,
      startsAt: new Date(Date.now() - 4 * HOUR_MS),
      expiresAt: new Date(Date.now() + 20_000),
      metadata: { multiplier: 2 },
    });

    await armClosureFixture();
    assert.equal((await postSamples(alice, [sampleAt(3, 8000)])).status, 200);

    const handoffs = [];
    const { worker, lines } = makeCapturingWorker({
      onCommitted: async (args) => { handoffs.push(args); return {}; },
    });
    assert.ok(await worker.processOne());
    const line = committedLine(lines);

    assert.equal(line.resolutionPlan, "FULL",
      "a due expiry on a NON-closure participant must send the generation to FULL");
    assert.equal(line.closureFenceRejections, 1);

    // The point of the veto: the post-commit handoff must carry a base value
    // for carol, because `expireEffects` looks her up by participant id and
    // SILENTLY skips the stepsAtExpiry stamp on a missing key (expireEffects.js
    // :56-59) — after which the row is written EXPIRED permanently with no
    // window end. Asserting the map's contents is the direct test; asserting
    // the stamp itself would only re-test expireEffects, and could not run
    // deterministically since the row is not yet due in wall-clock time.
    const carolParticipant = await prisma.raceParticipant.findFirstOrThrow({
      where: { raceId, userId: carol.userId },
    });
    assert.equal(handoffs.length, 1);
    assert.ok(
      Object.hasOwn(
        handoffs[0].result.baseAdjustedByParticipantId,
        carolParticipant.id
      ),
      "the FULL retry must hand expireEffects a base value for the non-closure target"
    );
    assert.equal(
      await prisma.raceActiveEffect.count({
        where: { id: carolEffect.id, status: "ACTIVE" },
      }),
      1,
      "the effect must still be ACTIVE — it is not yet due in wall-clock time"
    );
  });

  it("an elapsed validity deadline retries as FULL", async () => {
    const { users, raceId } = await seedRace("FenceDeadline", 3);
    const [alice, bob] = users;
    await postSamples(bob, [sampleAt(5, 3000)]);
    await drain();
    await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: bob });

    await armClosureFixture();
    assert.equal((await postSamples(alice, [sampleAt(3, 8000)])).status, 200);

    const { worker, lines } = makeCapturingWorker({
      buildRaceScoringDependencyClosure: plannerThen(async (plan) => {
        // The graph is untouched, so the digest still matches. ONLY the
        // exclusive validity deadline has passed — it must reject on its own.
        if (plan.plan === "DEPENDENCY_CLOSURE") {
          plan.validUntil = new Date(Date.now() - 1000);
        }
      }),
    });
    assert.ok(await worker.processOne());
    const line = committedLine(lines);

    assert.equal(line.resolutionPlan, "FULL");
    assert.equal(line.closureFenceRejections, 1);
  });

  it("losing the lease mid-closure writes nothing", async () => {
    const { users, raceId } = await seedRace("FenceLease", 3);
    const [alice, bob] = users;
    await postSamples(bob, [sampleAt(5, 3000)]);
    await drain();
    await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: bob });

    await armClosureFixture();
    assert.equal((await postSamples(alice, [sampleAt(3, 8000)])).status, 200);

    const before = await participantVersions(raceId);
    const { worker, lines } = makeCapturingWorker({
      buildRaceScoringDependencyClosure: plannerThen(async () => {
        // Someone else owns the race now. The job row is already RUNNING under
        // OUR token, so a rival cannot reach it through claimNext — the state a
        // reclaim-after-lease-expiry actually leaves behind is a DIFFERENT lease
        // token on the row, which is what this writes. Our fence then finds zero
        // rows matching (id, leaseToken) and aborts before the first write.
        await prisma.$executeRawUnsafe(
          `UPDATE race_resolution_jobs_v2 SET lease_token = $2 WHERE race_id = $1`,
          raceId,
          `stolen-${Date.now()}`
        );
      }),
    });
    await worker.processOne();

    assert.ok(
      lines.some((line) => line.outcome === "fence_lost"),
      "the run must have detected the lost fence"
    );
    assert.deepEqual(
      await participantVersions(raceId),
      before,
      "a lost fence must leave every participant row physically untouched"
    );
  });
});

// ── 4. permanent selection and correctness fallback ───────────────────────

describe("dependency closure — permanent selection", () => {
  async function resolveOnceWith(dependencyClosureEnabled, raceId, uploader) {
    await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);
    assert.equal((await postSamples(uploader, [sampleAt(3, 7000)])).status, 200);
    const { worker, lines } = makeCapturingWorker({ dependencyClosureEnabled });
    assert.ok(await worker.processOne());
    return { line: committedLine(lines), state: await participantState(raceId) };
  }

  it("the independent FULL control preserves full-resolution behavior", async () => {
    const { users, raceId } = await seedRace("FlagsOff", 3);
    const [alice, bob] = users;
    await postSamples(bob, [sampleAt(5, 3000)]);
    await drain();
    await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: bob });

    const run = await resolveOnceWith(
      false,
      raceId,
      alice
    );
    assert.equal(run.line.resolutionPlan, "FULL");
    assert.equal(run.line.closureEscalatedOnMine, null);
    assert.equal(run.line.shadowClosurePlan, null);
    assertNonTrivial(run.state);
  });

  it("the retired shadow path cannot observe or select a plan", async () => {
    const { users, raceId } = await seedRace("ShadowOnly", 3);
    const [alice, bob] = users;
    await postSamples(bob, [sampleAt(5, 3000)]);
    await drain();
    await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: bob });

    const run = await resolveOnceWith(
      false,
      raceId,
      alice
    );
    assert.equal(run.line.resolutionPlan, "FULL",
      "the shadow must never select a plan");
    assert.equal(run.line.shadowClosurePlan, null,
      "the deleted shadow planner must not run");
    assert.equal(run.line.closureEscalatedOnMine, null,
      "no closure was evaluated for a write, so the escalation field stays null");
  });

  // Spec item 8: DEPENDENCY_CLOSURE is ADMITTED to the post-commit path, not
  // exempted from it. It must never skip expireEffects, box consequences, the
  // high-multiplier re-arm, the snapshot, or one-attempt delivery just because
  // the scoring was scoped — and the roster it hands over must be the FULL
  // accepted field (R9), or the alert pass would silently shrink its recipients.
  it("a closure commit reaches onCommitted with the FULL roster", async () => {
    const { users, raceId } = await seedRace("PostCommit", 4);
    const [alice, bob, carol, dave] = users;
    for (const u of [bob, carol, dave]) await postSamples(u, [sampleAt(5, 3000)]);
    await drain();
    await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: bob });

    const handoffs = [];
    await armClosureFixture();
    assert.equal((await postSamples(alice, [sampleAt(3, 7000)])).status, 200);
    const { worker, lines } = makeCapturingWorker({
      onCommitted: async (args) => {
        handoffs.push(args);
        return {};
      },
    });
    assert.ok(await worker.processOne());

    assert.equal(committedLine(lines).resolutionPlan, "DEPENDENCY_CLOSURE");
    assert.equal(handoffs.length, 1,
      "the closure commit must be handed to the post-commit path exactly once");
    const handed = handoffs[0];
    assert.equal(handed.raceId, raceId);
    assert.equal(
      handed.result.race.participants.length,
      4,
      "the post-commit result must carry the FULL accepted roster, not the closure"
    );
    // The subset surface is exactly the three the spec names as subset.
    assert.deepEqual(
      Object.keys(handed.result.baseAdjustedByParticipantId).sort(),
      [
        (await prisma.raceParticipant.findFirstOrThrow({
          where: { raceId, userId: alice.userId },
        })).id,
        (await prisma.raceParticipant.findFirstOrThrow({
          where: { raceId, userId: bob.userId },
        })).id,
      ].sort(),
      "the base-adjusted map is scoped to the closure — the narrowed expiry veto is what makes that safe"
    );
  });

  it("rollback: flipping the write flag off mid-queue strands nothing", async () => {
    const { users, raceId } = await seedRace("Rollback", 3);
    const [alice, bob] = users;
    await postSamples(bob, [sampleAt(5, 3000)]);
    await drain();
    await plantEffect({ raceId, type: "LEECH", targetUser: alice, sourceUser: bob });

    await armClosureFixture();
    assert.equal((await postSamples(alice, [sampleAt(3, 7000)])).status, 200);
    const first = makeCapturingWorker();
    assert.ok(await first.worker.processOne());
    assert.equal(committedLine(first.lines).resolutionPlan, "DEPENDENCY_CLOSURE");

    // Exercise the structurally retained FULL fallback with more work queued.
    assert.equal((await postSamples(alice, [sampleAt(2, 5000)])).status, 200);
    const second = makeCapturingWorker({ dependencyClosureEnabled: false });
    assert.ok(await second.worker.processOne());
    assert.equal(committedLine(second.lines).resolutionPlan, "FULL",
      "the very next claim must return to the full resolver");

    // Nothing is left claimed, running, or stranded.
    const job = await RaceResolutionJobV2.findByRaceId(raceId);
    assert.notEqual(job.state, "running", "no generation may be left claimed");
    assert.equal(await RaceResolutionJobV2.countUnexpiredRunning(new Date()), 0);
    assertNonTrivial(await participantState(raceId));
  });
});
