const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildRaceDirtyStreamWorker, scheduleRaceDirtyStreamWorker } = require("../../../src/modules/races/jobs/raceDirtyStreamWorker");

function fixture() {
  const job = {
    id: "failed-job", raceId: "race", state: "FAILED", generation: 3,
    processingGeneration: 3, completedAt: new Date("2098-09-19T12:00:00Z"),
    lastErrorCode: "SCORING_FAILED", processingTriggeredByUserIds: ["user"],
  };
  const entry = { id: "1-0", fields: {
    schemaVersion: "1", raceId: "race", jobGeneration: "3",
    reason: "GLOBAL_EVENT_BOUNDARY", requestedAt: "2098-09-19T12:00:00Z",
  } };
  const pending = new Set([entry.id]);
  const reports = [];
  let failAck = false;
  const queue = {
    STREAMS: { RACE_DIRTY: "race-stream" }, GROUPS: { RACE_DIRTY: "race-workers" },
    async ack(_stream, _group, id) {
      if (failAck) throw new Error("Redis unavailable");
      return pending.delete(id);
    },
  };
  const worker = buildRaceDirtyStreamWorker({
    RaceResolutionJobV2: { async findByRaceId() { return job; } }, queue,
    resolver: { async processRace() { assert.fail("a terminal job must not run again"); } },
    logger: { error(message) { reports.push(JSON.parse(message)); } },
  });
  return { job, entry, pending, reports, queue, worker, failAck(value) { failAck = value; } };
}

test("the scheduler clears terminal transport work while preserving the failed job", async () => {
  const f = fixture();
  const before = structuredClone(f.job);
  const [result] = await f.worker.processEntries([f.entry]);
  assert.equal(result.outcome, "TERMINAL_FAILED");
  assert.notEqual(result.completed, true);
  assert.equal(f.pending.size, 1, "scoring itself must not acknowledge failure as success");

  let reads = 0;
  let releaseRead;
  let reachedIdle;
  const idle = new Promise((resolve) => { reachedIdle = resolve; });
  Object.assign(f.queue, {
    async ensureGroup() {}, async reclaimIdle() { return []; },
    async readGroup() {
      if (reads++ === 0) return [f.entry];
      return new Promise((resolve) => { releaseRead = resolve; reachedIdle(); });
    },
  });
  const handle = scheduleRaceDirtyStreamWorker({
    worker: f.worker, queue: f.queue, consumer: "test-terminal",
    logger: { error() {} },
  });
  await idle;
  const stopping = handle.stop();
  releaseRead([]);
  await stopping;
  assert.equal(f.pending.size, 0, "a confirmed failed job must no longer pin stream trimming");
  assert.deepEqual(f.job, before, "failure identity and pending scope remain available for recovery");
  assert.equal(f.reports.at(-1).event, "race_stream_terminal_failure_v1");
  assert.equal(f.reports.at(-1).jobId, f.job.id);
  assert.equal(f.reports.at(-1).outcome, "TERMINAL_FAILED");
});

test("retryable work or a failure older than the message is not acknowledged", async () => {
  const f = fixture();
  f.job.state = "QUEUED";
  assert.equal(await f.worker.acknowledgeTerminalFailure(f.entry), false);
  f.job.state = "FAILED";
  f.job.generation = 2;
  assert.equal(await f.worker.acknowledgeTerminalFailure(f.entry), false);
  assert.equal(f.pending.size, 1);
  assert.equal(f.reports.length, 0);
});

test("an acknowledgment failure remains retryable without deleting the failure record", async () => {
  const f = fixture();
  const before = structuredClone(f.job);
  f.failAck(true);
  await assert.rejects(() => f.worker.acknowledgeTerminalFailure(f.entry), /Redis unavailable/);
  assert.equal(f.pending.size, 1);
  assert.deepEqual(f.job, before);
  f.failAck(false);
  assert.equal(await f.worker.acknowledgeTerminalFailure(f.entry), true);
  assert.equal(f.pending.size, 0);
  assert.deepEqual(f.job, before);
});
