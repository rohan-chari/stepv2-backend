const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildRaceDirtyStreamWorker } = require("../../../src/modules/races/jobs/raceDirtyStreamWorker");

function fixture() {
  let current = new Date("2098-09-19T12:00:00Z");
  let job = { raceId: "race", generation: 3, processingGeneration: 0, state: "QUEUED", notBeforeAt: current };
  let attempts = 0;
  let result = "success";
  const acknowledged = [];
  const claimOptions = [];
  const model = {
    async findByRaceId() { return { ...job }; },
    async claimNext(options) {
      claimOptions.push(options);
      if (job.state !== "QUEUED" || job.notBeforeAt > current || job.retryAt > current) return null;
      job = { ...job, state: "RUNNING", processingGeneration: job.generation };
      return { ...job };
    },
  };
  const worker = buildRaceDirtyStreamWorker({
    RaceResolutionJobV2: model,
    now: () => current,
    queue: {
      STREAMS: { RACE_DIRTY: "race-stream" }, GROUPS: { RACE_DIRTY: "race-workers" },
      async ack(_stream, _group, id) { acknowledged.push(id); },
    },
    // Exercise the consumer's claim policy through the real model-injection
    // contract. The canonical scoring engine itself already has integration tests.
    buildRaceResolutionWorkerV2({ RaceResolutionJobV2 }) {
      return {
        async processRace({ raceId }) {
          const claimed = await RaceResolutionJobV2.claimNext({ raceId, force: true, now: current });
          attempts += 1;
          if (result === "failed") job = { ...job, state: "FAILED" };
          else if (result === "superseded") job = {
            ...job, generation: job.generation + 1, state: "QUEUED",
            notBeforeAt: new Date(current.getTime() + 5000),
          };
          else job = { ...job, state: "SUCCEEDED", lastCompletedAt: current };
          return claimed;
        },
      };
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  const entry = (id, generation) => ({
    id,
    fields: {
      schemaVersion: "1", raceId: "race", jobGeneration: String(generation),
      reason: "GLOBAL_EVENT_BOUNDARY", requestedAt: current.toISOString(),
    },
  });
  return {
    worker, entry, acknowledged, claimOptions,
    attempts: () => attempts,
    defer() { job = { ...job, retryAt: new Date(current.getTime() + 5000) }; },
    advance() { current = new Date(current.getTime() + 6000); },
    result(value) { result = value; },
  };
}

test("generation wakes for one race share one non-forced resolution", async () => {
  const f = fixture();
  const entries = [f.entry("1-0", 1), f.entry("1-1", 2), f.entry("1-2", 3)];
  await f.worker.processEntries(entries);
  assert.equal(f.attempts(), 1);
  assert.equal(f.claimOptions[0].force, false);
  assert.deepEqual(f.acknowledged, entries.map((entry) => entry.id));
  await f.worker.processEntries([f.entry("1-3", 2)]);
  assert.equal(f.attempts(), 1, "already covered generations need no computation");
});

test("retry time defers work without acknowledging it or occupying a resolution attempt", async () => {
  const f = fixture();
  const entries = [f.entry("2-0", 3)];
  f.defer();
  const pending = await f.worker.processEntries(entries);
  assert.equal(f.attempts(), 0);
  assert.equal(f.acknowledged.length, 0);
  assert.equal(pending[0].outcome, "DEFERRED");
  f.advance();
  await f.worker.processEntries(entries);
  assert.equal(f.attempts(), 1);
  assert.deepEqual(f.acknowledged, ["2-0"]);
});

test("newer work gets a follow-up and a truthy failed attempt is not acknowledged", async () => {
  const f = fixture();
  const first = f.entry("3-0", 3);
  f.result("superseded");
  await f.worker.processEntries([first]);
  assert.equal(f.acknowledged.length, 0);
  f.advance();
  f.result("success");
  await f.worker.processEntries([first, f.entry("3-1", 4)]);
  assert.equal(f.attempts(), 2);
  assert.deepEqual(f.acknowledged, ["3-0", "3-1"]);

  const failed = fixture();
  failed.result("failed");
  const result = await failed.worker.processEntries([failed.entry("4-0", 3)]);
  assert.equal(failed.acknowledged.length, 0);
  assert.equal(result[0].outcome, "TERMINAL_FAILED");
});
