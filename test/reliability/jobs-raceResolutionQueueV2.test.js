const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildRaceResolutionWorkerV2,
  runBoundedRaceResolutionJobs,
  createRaceResolutionPhaseTimer,
  createRaceResolutionAttemptWatchdog,
  RACE_RESOLUTION_SLOW_PHASE_MS,
  RACE_RESOLUTION_SLOW_ATTEMPT_MS,
  RACE_RESOLUTION_WATCHDOG_MS,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");

test("watchdog fail-stop fixture drives the shipped worker transaction", () => {
  const fixture = fs.readFileSync(
    path.join(__dirname, "../fixtures/raceResolutionWatchdogChild.js"),
    "utf8"
  );
  assert.match(fixture, /buildRaceResolutionWorkerV2\s*\(/);
  assert.doesNotMatch(fixture, /RaceResolutionJobV2\.claimNext\s*\(/);
  assert.doesNotMatch(fixture, /createRaceResolutionAttemptWatchdog\s*\(/);
  assert.doesNotMatch(fixture, /createRaceResolutionPhaseTimer\s*\(/);
});

test("nested phase timer exposes live state, emits bounded checkpoints, and enforces LIFO", () => {
  let nanos = 0n;
  const scheduled = [];
  const events = [];
  const timer = createRaceResolutionPhaseTimer(() => nanos, {
    attemptContext: {
      attemptId: "00000000-0000-4000-8000-000000000000:11111111-1111-4111-8111-111111111111",
      queuePriority: "RECOVERY",
      resolutionPlan: () => "FULL",
    },
    emit: (event) => events.push(event),
    scheduleTimeout: (callback, ms) => {
      const handle = { callback, ms, cleared: false };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout: (handle) => { handle.cleared = true; },
  });

  const stopTransaction = timer.start("transaction");
  nanos = 2_000_000n;
  const stopFence = timer.start("fenceAcquire");
  assert.deepEqual(timer.liveState(), {
    activePhase: "fenceAcquire",
    parentPhase: "transaction",
    phaseStack: ["transaction", "fenceAcquire"],
    activePhaseElapsedMs: 0,
    attemptElapsedMs: 2,
    lastCompletedPhase: null,
  });
  assert.throws(stopTransaction, /non-LIFO/);

  nanos = 10_002_000_000n;
  scheduled[1].callback();
  scheduled[1].callback();
  stopFence();
  stopTransaction();

  assert.equal(events.filter((event) => event.checkpoint === "enter").length, 2);
  assert.equal(events.filter((event) => event.checkpoint === "slow").length, 2);
  assert.equal(events[2].activePhase, "fenceAcquire");
  assert.equal(events[2].parentPhase, "transaction");
  assert.equal(events[3].activePhase, "transaction");
  assert.equal(events[3].parentPhase, null);
  assert.equal(scheduled.every((handle) => handle.cleared), true);
});

test("a parent phase emits its overdue slow checkpoint after its child completes", () => {
  let nanos = 0n;
  const scheduled = [];
  const events = [];
  const timer = createRaceResolutionPhaseTimer(() => nanos, {
    attemptContext: { attemptId: "boot:attempt", queuePriority: "LIVE" },
    emit: (event) => events.push(event),
    scheduleTimeout(callback, ms) {
      const handle = { callback, ms, cleared: false };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout(handle) { handle.cleared = true; },
  });

  const stopParent = timer.start("transaction");
  nanos = 1_000_000n;
  const stopChild = timer.start("fenceAcquire");
  nanos = 10_001_000_000n;
  scheduled[0].callback();
  assert.equal(events.some((event) => event.checkpoint === "slow"), false);

  stopChild();
  const slow = events.find((event) => event.checkpoint === "slow");
  assert.equal(slow?.activePhase, "transaction");
  assert.equal(slow?.parentPhase, null);
  stopParent();
});

test("fresh boot alarms after one watchdog interval with claimable work and no terminal", async () => {
  let nanos = 0n;
  const messages = [];
  const logger = {
    log(value) { messages.push(value); },
    warn(value) { messages.push(value); },
    error(value) { messages.push(value); },
  };
  const worker = buildRaceResolutionWorkerV2({
    nodeEnv: "production",
    processRole: "resolution",
    monotonicNow: () => nanos,
    scheduleTimeout: () => ({ unref() {} }),
    appSettings: { async getFlag() { return false; } },
    logger,
    RaceResolutionJobV2: {
      async queueServiceSnapshot() {
        return {
          oldestRequestAgeMs: 0,
          claimableCount: 1,
          oldestClaimableAgeMs: 0,
          runningCount: 0,
          expiredRunningCount: 0,
          settlementCount: 0,
          recoveryCount: 0,
          liveCount: 1,
          maintenanceCount: 0,
        };
      },
    },
    raceResolutionWorkBudget: {
      snapshot: () => ({ active: 0, queuedCore: 0, queuedPost: 0 }),
    },
  });
  nanos = BigInt(RACE_RESOLUTION_WATCHDOG_MS + 1) * 1_000_000n;

  await worker.logQueueLag();

  const event = messages
    .map((value) => typeof value === "string" && value.startsWith("{") ? JSON.parse(value) : null)
    .find((value) => value?.event === "race_resolution_v2_queue_service");
  assert.equal(event.lastTerminalAgeMs, null);
  assert.equal(event.alarm, true);
});

test("attempt watchdog emits slow marker then fail-stops exactly once after a bounded flush", async () => {
  assert.equal(RACE_RESOLUTION_SLOW_PHASE_MS, 10_000);
  assert.equal(RACE_RESOLUTION_SLOW_ATTEMPT_MS, 30_000);
  assert.equal(RACE_RESOLUTION_WATCHDOG_MS, 60_000);
  const scheduled = [];
  const markers = [];
  const diagnostics = [];
  const failStops = [];
  const watchdog = createRaceResolutionAttemptWatchdog({
    attempt: {
      attemptId: "boot:attempt",
      jobId: "job",
      raceId: "race",
      leaseExpiresAt: new Date("2026-09-01T00:00:30.000Z"),
      queueLagMs: 12,
    },
    phaseTimer: { liveState: () => ({ activePhase: "transaction", phaseStack: ["transaction"], activePhaseElapsedMs: 60_000, attemptElapsedMs: 60_000, lastCompletedPhase: "compute" }) },
    workBudget: { snapshot: () => ({ active: 2, queuedCore: 1, queuedPost: 0 }) },
    scheduleTimeout: (callback, ms) => {
      const handle = { callback, ms, cleared: false };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout: (handle) => { handle.cleared = true; },
    emitDiagnostic: (event) => diagnostics.push(event),
    writeAlertMarker: (marker) => markers.push(marker),
    flushDiagnostics: async (deadlineMs) => assert.ok(deadlineMs <= 250),
    failStop: (code) => failStops.push(code),
    processRole: "resolution",
  });

  assert.deepEqual(scheduled.map((entry) => entry.ms), [30_000, 60_000]);
  await scheduled[0].callback();
  await scheduled[1].callback();
  await scheduled[1].callback();

  assert.deepEqual(markers.map((entry) => entry.alertType), ["slow", "watchdog"]);
  assert.equal(diagnostics.at(-1).event, "race_resolution_v2_watchdog");
  assert.equal(failStops.length, 1);
  assert.equal(failStops[0], 70);
  watchdog.cancel();
});

test("watchdog is inert outside the dedicated resolution role", () => {
  const scheduled = [];
  createRaceResolutionAttemptWatchdog({
    attempt: {},
    phaseTimer: { liveState: () => ({}) },
    scheduleTimeout: (...args) => scheduled.push(args),
    processRole: "http",
  });
  assert.equal(scheduled.length, 0);
});

test("watchdog fail-stops even when diagnostic snapshot getters throw", async () => {
  for (const throwingDependency of ["phase", "budget", "siblings", "leases"]) {
    const scheduled = [];
    const failStops = [];
    createRaceResolutionAttemptWatchdog({
      attempt: { attemptId: "boot:attempt", jobId: "job", raceId: "race" },
      phaseTimer: {
        liveState() {
          if (throwingDependency === "phase") throw new Error("phase exploded");
          return {};
        },
      },
      workBudget: {
        snapshot() {
          if (throwingDependency === "budget") throw new Error("budget exploded");
          return {};
        },
      },
      getSiblingAttempts() {
        if (throwingDependency === "siblings") throw new Error("siblings exploded");
        return [];
      },
      expiredLeaseCount() {
        if (throwingDependency === "leases") throw new Error("leases exploded");
        return 0;
      },
      scheduleTimeout(callback, ms) {
        const handle = { callback, ms };
        scheduled.push(handle);
        return handle;
      },
      clearTimeout() {},
      emitDiagnostic() {},
      writeAlertMarker() {},
      flushDiagnostics: async () => {},
      failStop(code) { failStops.push(code); },
      processRole: "resolution",
    });

    await scheduled.find(({ ms }) => ms === 60_000).callback();
    assert.deepEqual(failStops, [70], throwingDependency);
  }
});

test("one lane does not start a second race-resolution job before the first settles", async () => {
  let releaseFirst;
  const first = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;

  const ticking = runBoundedRaceResolutionJobs(1, async () => {
    calls += 1;
    await first;
    return { id: "first" };
  });

  await Promise.resolve();
  assert.equal(calls, 1);
  releaseFirst();
  assert.equal(await ticking, 1);
});

test("two lanes claim and process distinct race-resolution jobs concurrently", async () => {
  const releases = [];
  let calls = 0;
  const started = [];

  const ticking = runBoundedRaceResolutionJobs(2, async () => {
    const id = ++calls;
    started.push(id);
    await new Promise((resolve) => releases.push(resolve));
    return { id: `job-${id}` };
  });

  await Promise.resolve();
  assert.deepEqual(started, [1, 2]);
  releases.forEach((release) => release());
  assert.equal(await ticking, 2);
});

test("three lanes claim and process distinct race-resolution jobs concurrently", async () => {
  const releases = [];
  const started = [];

  const ticking = runBoundedRaceResolutionJobs(3, async () => {
    const id = started.length + 1;
    started.push(id);
    await new Promise((resolve) => releases.push(resolve));
    return { id: `job-${id}` };
  });

  await Promise.resolve();
  assert.deepEqual(started, [1, 2, 3]);
  releases.forEach((release) => release());
  assert.equal(await ticking, 3);
});

test("five lanes run concurrently without admitting a sixth", async () => {
  let calls = 0;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const ticking = runBoundedRaceResolutionJobs(5, async () => {
    calls++;
    await barrier;
    return { id: calls };
  });
  try { assert.equal(calls, 5); }
  finally { release(); await ticking; }
  assert.equal(await ticking, 5);
});

test("an empty lane does not prevent a claimed sibling job from completing", async () => {
  let calls = 0;
  const completed = await runBoundedRaceResolutionJobs(2, async () => {
    calls += 1;
    return calls === 1 ? { id: "only-job" } : null;
  });

  assert.equal(completed, 1);
  assert.equal(calls, 2);
});

test("a failed lane waits for its running sibling before surfacing the failure", async () => {
  let releaseSibling;
  const sibling = new Promise((resolve) => {
    releaseSibling = resolve;
  });
  let calls = 0;
  let settled = false;

  const ticking = runBoundedRaceResolutionJobs(2, async () => {
    calls += 1;
    if (calls === 1) throw new Error("claim database unavailable");
    await sibling;
    return { id: "sibling" };
  });
  ticking.catch(() => {
    settled = true;
  });

  await new Promise(setImmediate);
  assert.equal(calls, 2);
  assert.equal(settled, false, "the helper must retain the sibling lane");

  releaseSibling();
  await assert.rejects(ticking, /claim database unavailable/);
  assert.equal(settled, true);
});

// ── Phase 2b shadow summary (pure) ────────────────────────────────────────────
// These are the serialization properties an integration test cannot express:
// the exact JSON shape of the emitted fields, including the tri-state that must
// survive as the STRING "UNKNOWN" and the closed-enum clamp on the reason.
const {
  summarizeClosureShadow,
  NULL_CLOSURE_SHADOW_FIELDS,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const {
  TRAIL_MINE_ESCALATION_UNKNOWN,
} = require("../../src/modules/races/services/raceScoringDependencyClosure");

test("the shadow summary emits only aggregate fields for a closure plan", () => {
  const summary = summarizeClosureShadow(
    {
      plan: "DEPENDENCY_CLOSURE",
      participantIds: ["p1", "p2"],
      sourceParticipantIds: ["p1"],
      fallbackReason: null,
      minesActive: false,
      mines: [],
      participantTotals: { p9: { participantId: "p9", totalSteps: 12345 } },
      retainedUnresolvedSources: [],
    },
    7
  );
  assert.deepEqual(Object.keys(summary).sort(), Object.keys(NULL_CLOSURE_SHADOW_FIELDS).sort());
  assert.deepEqual(summary, {
    shadowClosurePlan: "DEPENDENCY_CLOSURE",
    shadowClosureFallbackReason: null,
    shadowClosureCount: 2,
    shadowSourceCount: 1,
    shadowMinesActive: false,
    shadowWouldEscalateOnMine: null,
    shadowPlannerMs: 7,
    shadowRetainedSourceCount: 0,
  });
  // The in-memory handoffs (ids, totals) never reach the serialized line.
  assert.equal(JSON.stringify(summary).includes("12345"), false);
  assert.equal(JSON.stringify(summary).includes("p9"), false);
});

test("the shadow summary serializes the Trail Mine tri-state as the string UNKNOWN", () => {
  const summary = summarizeClosureShadow(
    {
      plan: "DEPENDENCY_CLOSURE",
      participantIds: ["p1"],
      sourceParticipantIds: ["p1"],
      fallbackReason: null,
      minesActive: true,
      mines: [{ id: "m1" }],
      participantTotals: {},
      retainedUnresolvedSources: [],
    },
    3,
    () => TRAIL_MINE_ESCALATION_UNKNOWN
  );
  assert.equal(summary.shadowWouldEscalateOnMine, "UNKNOWN");
  assert.equal(
    JSON.stringify(summary).includes('"shadowWouldEscalateOnMine":"UNKNOWN"'),
    true
  );
  // A definite verdict stays a boolean, never the string "true".
  const definite = summarizeClosureShadow(
    {
      plan: "DEPENDENCY_CLOSURE",
      participantIds: ["p1"],
      sourceParticipantIds: ["p1"],
      fallbackReason: null,
      minesActive: true,
      mines: [{ id: "m1" }],
      participantTotals: {},
    },
    3,
    () => true
  );
  assert.equal(definite.shadowWouldEscalateOnMine, true);
  assert.equal(definite.shadowRetainedSourceCount, null);
});

test("the shadow summary clamps a FULL plan's reason to the closed enum and sizes no closure", () => {
  const known = summarizeClosureShadow(
    {
      plan: "FULL",
      participantIds: [],
      sourceParticipantIds: ["p1", "p2"],
      fallbackReason: "RACE_WIDE_EFFECT_ACTIVE",
      minesActive: false,
    },
    1
  );
  assert.equal(known.shadowClosurePlan, "FULL");
  assert.equal(known.shadowClosureFallbackReason, "RACE_WIDE_EFFECT_ACTIVE");
  assert.equal(known.shadowClosureCount, null, "a FULL plan sizes no closure");
  assert.equal(known.shadowSourceCount, 2);
  assert.equal(known.shadowWouldEscalateOnMine, null);

  const unknownReason = summarizeClosureShadow(
    { plan: "FULL", participantIds: [], sourceParticipantIds: [], fallbackReason: "free text" },
    1
  );
  assert.equal(
    unknownReason.shadowClosureFallbackReason,
    null,
    "an off-enum reason must not widen the rollout dimension"
  );
});

test("the shadow summary of a missing planner result keeps only the measured duration", () => {
  assert.deepEqual(summarizeClosureShadow(null, 12), {
    ...NULL_CLOSURE_SHADOW_FIELDS,
    shadowPlannerMs: 12,
  });
});
