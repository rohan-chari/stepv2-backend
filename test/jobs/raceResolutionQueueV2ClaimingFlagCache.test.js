const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");

// `claimingDisabled()` runs on every 250ms tick forever, even against an empty
// queue — ~345k appSetting reads/day on a 1-vCPU box. It is now memoized for a
// deliberately tiny window. These tests pin BOTH halves of that contract:
// the ENABLED answer may go briefly stale; the DISABLED answer never does.

function countingSettings(sequence) {
  const state = { reads: 0, values: [...sequence] };
  return {
    state,
    async getUncachedFlag(key) {
      assert.equal(key, "raceQueueV2ClaimingDisabled");
      state.reads += 1;
      // Hold the last value once the script runs out.
      return state.values.length > 1 ? state.values.shift() : state.values[0];
    },
  };
}

function makeWorker(settings, overrides = {}) {
  return buildRaceResolutionWorkerV2({ appSettings: settings, ...overrides });
}

test("the ENABLED (false) answer is cached inside the TTL window", async () => {
  const settings = countingSettings([false]);
  const worker = makeWorker(settings, { claimingFlagTtlMs: 60_000 });

  assert.equal(await worker.claimingDisabled(), false);
  assert.equal(settings.state.reads, 1);

  // Eight more ticks' worth: zero additional queries.
  for (let i = 0; i < 8; i += 1) {
    assert.equal(await worker.claimingDisabled(), false);
  }
  assert.equal(settings.state.reads, 1, "idle ticks must not re-query the flag");
});

test("the flag is re-read once the TTL window expires", async () => {
  const settings = countingSettings([false]);
  const worker = makeWorker(settings, { claimingFlagTtlMs: 10 });

  assert.equal(await worker.claimingDisabled(), false);
  assert.equal(await worker.claimingDisabled(), false);
  assert.equal(settings.state.reads, 1);

  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(await worker.claimingDisabled(), false);
  assert.equal(settings.state.reads, 2, "a stale window must re-query");
});

test("a flip to DISABLED is observed once the window expires", async () => {
  const settings = countingSettings([false, true]);
  const worker = makeWorker(settings, { claimingFlagTtlMs: 10 });

  assert.equal(await worker.claimingDisabled(), false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await worker.claimingDisabled(), true);
});

test("the DISABLED (true) answer is NEVER cached — un-flipping resumes next tick", async () => {
  // The emergency-response half of the contract. While the switch is thrown the
  // worker re-reads every single tick, so clearing it costs zero delay.
  const settings = countingSettings([true]);
  const worker = makeWorker(settings, { claimingFlagTtlMs: 60_000 });

  for (let i = 0; i < 5; i += 1) {
    assert.equal(await worker.claimingDisabled(), true);
  }
  assert.equal(settings.state.reads, 5, "a thrown switch must be read every tick");
});

test("clearing the switch takes effect on the very next tick, with no TTL delay", async () => {
  const settings = countingSettings([true, false]);
  const worker = makeWorker(settings, { claimingFlagTtlMs: 60_000 });

  assert.equal(await worker.claimingDisabled(), true);
  // No sleep: the `true` answer was never cached.
  assert.equal(await worker.claimingDisabled(), false);
  assert.equal(settings.state.reads, 2);
});

test("TTL defaults to 2s when not injected", async () => {
  const settings = countingSettings([false]);
  const worker = makeWorker(settings);

  assert.equal(await worker.claimingDisabled(), false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await worker.claimingDisabled(), false);
  assert.equal(
    settings.state.reads,
    1,
    "50ms in, the default 2s window is still live"
  );
});

test("claiming a job drops the cached ENABLED answer", async () => {
  // Only an IDLE worker is allowed to coast. As soon as a real job is claimed
  // the switch is re-read, so a worker doing work never runs on a stale answer.
  const settings = countingSettings([false]);
  let claims = 0;
  const worker = makeWorker(settings, {
    claimingFlagTtlMs: 60_000,
    bootAt: 0,
    prisma: {
      // 42P01 undefined_table => the old queue is gone; readyToClaim passes.
      async $queryRawUnsafe() {
        const error = new Error('relation "race_resolution_jobs" does not exist');
        error.code = "42P01";
        throw error;
      },
    },
    RaceResolutionJobV2: {
      async claimNext() {
        claims += 1;
        // First tick: empty queue. Second tick: a real job.
        return claims === 1
          ? null
          : { id: "job-1", raceId: "r1", leaseToken: "t", startedAt: new Date() };
      },
    },
    raceResolutionWorkBudget: { async run(_lane, fn) { return fn(); } },
  });

  assert.equal(await worker.claimingDisabled(), false);
  assert.equal(settings.state.reads, 1);

  // Tick 1: EMPTY claim. The idle path we are optimizing — the cached answer
  // must survive, so this tick costs zero extra flag reads.
  await worker.processOne().catch(() => {});
  assert.equal(claims, 1, "processOne reached claimNext");
  assert.equal(await worker.claimingDisabled(), false);
  assert.equal(settings.state.reads, 1, "an empty claim must not invalidate");

  // Tick 2: a REAL claim. Everything after the claim is irrelevant here (this
  // worker has no models to process with, so it throws) — the invalidation
  // happens immediately after the claim, before any processing.
  await worker.processOne().catch(() => {});
  assert.equal(claims, 2, "processOne claimed a job");
  assert.equal(await worker.claimingDisabled(), false);
  assert.equal(
    settings.state.reads,
    2,
    "a real claim must drop the cached answer, forcing a fresh read"
  );
});

test("an idle tick promotes append-only FULL triggers before it claims a race", async () => {
  const settings = countingSettings([false]);
  const calls = [];
  const worker = makeWorker(settings, {
    bootAt: 0,
    prisma: {
      async $queryRawUnsafe() {
        const error = new Error('relation "race_resolution_jobs" does not exist');
        error.code = "42P01";
        throw error;
      },
    },
    RaceResolutionJobV2: {
      async promoteFullScopeTriggers() {
        calls.push("promote");
        return { promoted: 0, races: 0 };
      },
      async claimNext() {
        calls.push("claim");
        return null;
      },
    },
    raceResolutionWorkBudget: { async run(_lane, fn) { return fn(); } },
  });

  assert.equal(await worker.processOne(), null);
  assert.deepEqual(calls, ["promote", "claim"]);
});
