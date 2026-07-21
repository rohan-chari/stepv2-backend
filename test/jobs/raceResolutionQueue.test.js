const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildRaceResolutionWorker,
} = require("../../src/modules/races/jobs/raceResolutionQueue");

const silentLogger = { log() {}, error() {} };

function makeDeps(over = {}) {
  const calls = {
    resolve: [],
    sync: [],
    recordSuccess: [],
    recordFailure: [],
  };
  const deps = {
    logger: silentLogger,
    now: () => new Date("2026-07-17T18:00:00.000Z"),
    Race: {
      findActiveForUser: async () => [{ id: "race-b" }, { id: "race-a" }],
    },
    RaceParticipant: {},
    // resolveRaceState now acquires the per-race advisory lock internally
    // (Phase C4); the worker no longer wraps it, so there is no explicit lock
    // dependency to inject here.
    resolveRaceState: async (args) => {
      calls.resolve.push(args);
      return [{ raceId: args.raceId, race: { id: args.raceId }, boxEffectiveSteps: 100 }];
    },
    syncRacePowerupState: async (args) => {
      calls.sync.push(args);
    },
    nudgeOvertakenRivals: async () => {},
    requestStepSyncForUsers: async () => {},
    RaceResolutionJob: {
      claimNext: async () =>
        over.claimReturns !== undefined
          ? over.claimReturns
          : {
              id: "job-1",
              userId: "user-1",
              processingGeneration: 7,
              processingTimeZone: "America/New_York",
              attempts: 1,
            },
      recordSuccess: async (args) => {
        calls.recordSuccess.push(args);
        return { superseded: false };
      },
      recordFailure: async (args) => {
        calls.recordFailure.push(args);
        return { state: "QUEUED" };
      },
    },
    ...over.deps,
  };
  return { deps, calls };
}

test("processOne resolves each active race under its lock, in sorted order, with the snapshotted tz", async () => {
  const { deps, calls } = makeDeps();
  const worker = buildRaceResolutionWorker(deps);
  const job = await worker.processOne();

  assert.equal(job.id, "job-1");
  // Full-field resolver called per race in stable sorted id order with the job's
  // PROCESSING timezone — never UTC/server locale (the tz-divergence guardrail).
  assert.equal(calls.resolve.length, 2);
  assert.deepEqual(calls.resolve.map((r) => r.raceId), ["race-a", "race-b"]);
  for (const r of calls.resolve) {
    assert.equal(r.timeZone, "America/New_York");
    assert.equal(r.userId, "user-1");
  }
  // Uploader powerup sync ran per resolved race.
  assert.equal(calls.sync.length, 2);
  // Success recorded with the processed generation (supersession guard).
  assert.equal(calls.recordSuccess.length, 1);
  assert.equal(calls.recordSuccess[0].processingGeneration, 7);
  assert.equal(calls.recordFailure.length, 0);
});

test("processOne returns null when the queue is empty", async () => {
  const { deps } = makeDeps({ claimReturns: null });
  const worker = buildRaceResolutionWorker(deps);
  assert.equal(await worker.processOne(), null);
});

test("a resolver failure records a transient failure (retry), not success", async () => {
  const { deps, calls } = makeDeps();
  deps.resolveRaceState = async () => {
    throw new Error("scoring blew up");
  };
  const worker = buildRaceResolutionWorker(deps);
  await worker.processOne();

  assert.equal(calls.recordSuccess.length, 0);
  assert.equal(calls.recordFailure.length, 1);
  assert.equal(calls.recordFailure[0].attempts, 1);
});
