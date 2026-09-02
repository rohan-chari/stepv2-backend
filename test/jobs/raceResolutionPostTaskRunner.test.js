const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRaceResolutionPostTaskRunner,
  postTaskCleanupDisabled,
  postTaskWorkerDisabled,
  scheduleRaceResolutionPostTaskRunner,
} = require("../../src/modules/races/jobs/raceResolutionPostTaskRunner");

test("runner attempts immutable intents in state/snapshot/nudge order and continues after ambiguity", async () => {
  const calls = [];
  const completed = [];
  const model = {
    async claimNext() { return { id: "t", raceId: "r", sourceGeneration: 2, leaseToken: "lease", snapshotCommand: {} }; },
    async listIntents() { return [
      { id: "i0", ordinal: 0, kind: "STATE_NOTIFICATION", recipientUserId: "u", payload: {} , state: "pending" },
      { id: "i1", ordinal: 1, kind: "NUDGE", recipientUserId: "u", payload: {}, state: "pending" },
    ]; },
    async beginIntent({ id }) { calls.push(`begin:${id}`); return `attempt:${id}`; },
    async completeIntent(value) { completed.push(value); },
    async beginSnapshot() { calls.push("begin:snapshot"); return "snapshot-attempt"; },
    async completeSnapshot(value) { completed.push(value); },
    async finish() { calls.push("finish"); return "succeeded_with_failures"; },
  };
  const runner = buildRaceResolutionPostTaskRunner({
    RaceResolutionPostTask: model,
    deliverIntent: async (intent) => {
      calls.push(`deliver:${intent.id}`);
      if (intent.id === "i0") throw new Error("timeout");
      return { accepted: true, disposition: "accepted" };
    },
    publishSnapshot: async () => calls.push("publish:snapshot"),
    isSuperseded: async () => false,
  });

  await runner.tick();
  assert.deepEqual(calls, [
    "begin:i0", "deliver:i0", "begin:snapshot", "publish:snapshot",
    "begin:i1", "deliver:i1", "finish",
  ]);
  assert.equal(completed.find((value) => value.id === "i0").state, "ambiguous_at_most_once");
  assert.equal(completed.find((value) => value.id === "i1").state, "accepted");
});

test("runner recovers durable effect expiry before beginning the at-most-once snapshot", async () => {
  const calls = [];
  const command = {
    raceId: "r",
    timeZone: "UTC",
    effectExpiryParticipantSteps: { participant: 4321 },
  };
  const runner = buildRaceResolutionPostTaskRunner({
    RaceResolutionPostTask: {
      async claimNext() {
        return {
          id: "t", raceId: "r", sourceGeneration: 2, leaseToken: "lease",
          snapshotState: "pending", snapshotCommand: command,
        };
      },
      async listIntents() { return []; },
      async beginSnapshot() { calls.push("begin:snapshot"); return "attempt"; },
      async completeSnapshot() { calls.push("complete:snapshot"); },
      async finish() { calls.push("finish"); return "succeeded"; },
    },
    async expireEffects(input) { calls.push(["expire", input]); },
    async publishSnapshot(snapshotCommand) {
      calls.push(["publish", snapshotCommand]);
      return true;
    },
    async isSuperseded() { return false; },
  });

  await runner.tick();
  assert.deepEqual(calls, [
    ["expire", {
      raceId: "r",
      participantSteps: { participant: 4321 },
      taskFence: { taskId: "t", leaseToken: "lease" },
    }],
    "begin:snapshot",
    ["publish", { raceId: "r", timeZone: "UTC" }],
    "complete:snapshot",
    "finish",
  ]);
});

test("whole-runner consolidated brake is exact literal true", () => {
  assert.equal(postTaskWorkerDisabled({ OPS_RACE_RESOLUTION_POST_TASK_WORKER_DISABLED: "true" }), true);
  assert.equal(postTaskWorkerDisabled({ OPS_RACE_RESOLUTION_POST_TASK_WORKER_DISABLED: "TRUE" }), false);
  assert.equal(postTaskWorkerDisabled({ RACE_RESOLUTION_POST_TASK_WORKER_DISABLED: "true" }), false);
  assert.equal(postTaskWorkerDisabled({}), false);
});

test("terminal cleanup is bounded, seven-day only, and uses the consolidated brake", async () => {
  assert.equal(postTaskCleanupDisabled({ OPS_DESTRUCTIVE_CLEANUPS_DISABLED: "true" }), true);
  assert.equal(postTaskCleanupDisabled({ OPS_DESTRUCTIVE_CLEANUPS_DISABLED: "TRUE" }), false);
  assert.equal(postTaskCleanupDisabled({ RACE_RESOLUTION_POST_TASK_CLEANUP_DISABLED: "true" }), false);
  const calls = [];
  const now = new Date("2026-08-13T12:00:00.000Z");
  const runner = buildRaceResolutionPostTaskRunner({
    env: {},
    now: () => now,
    RaceResolutionPostTask: {
      async cleanupTerminal(input) { calls.push(input); return 3; },
    },
  });
  assert.equal(await runner.cleanup(), 3);
  assert.deepEqual(calls, [{
    before: new Date("2026-08-06T12:00:00.000Z"),
    limit: 500,
  }]);

  const disabled = buildRaceResolutionPostTaskRunner({
    env: { OPS_DESTRUCTIVE_CLEANUPS_DISABLED: "true" },
    RaceResolutionPostTask: {
      async cleanupTerminal() { throw new Error("must not run"); },
    },
  });
  assert.equal(await disabled.cleanup(), 0);
});

test("terminal cleanup drains at most two 500-row pages and yields between full pages", async () => {
  const calls = [];
  let yields = 0;
  const runner = buildRaceResolutionPostTaskRunner({
    env: {},
    now: () => new Date("2026-08-28T12:00:00.000Z"),
    yieldToEventLoop: async () => { yields += 1; },
    RaceResolutionPostTask: {
      async cleanupTerminal(input) {
        calls.push(input);
        return 500;
      },
    },
  });

  assert.equal(await runner.cleanup(), 1000);
  assert.equal(calls.length, 2);
  assert.equal(yields, 1);
  assert.ok(calls.every((call) => call.limit === 500));
});

test("scheduled cleanup does not overlap an in-flight cleanup", async () => {
  let calls = 0;
  let finishCleanup;
  const pending = new Promise((resolve) => { finishCleanup = resolve; });
  const scheduled = scheduleRaceResolutionPostTaskRunner({
    env: {},
    pollIntervalMs: 60_000,
    cleanupIntervalMs: 60_000,
    RaceResolutionPostTask: {
      async cleanupTerminal() {
        calls += 1;
        await pending;
        return 0;
      },
    },
  });
  try {
    const first = scheduled.runCleanup();
    const second = scheduled.runCleanup();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    finishCleanup();
    await Promise.all([first, second]);
  } finally {
    finishCleanup();
    clearInterval(scheduled.interval);
    clearInterval(scheduled.cleanup);
  }
});

test("readiness requires a recent DB claim probe, bounded lag, and no ambiguous lease", async () => {
  let now = new Date("2026-08-13T12:00:00.000Z");
  let health = { oldestPendingLagMs: 10_000, expiredAttemptCount: 0 };
  const runner = buildRaceResolutionPostTaskRunner({
    env: {},
    now: () => now,
    RaceResolutionPostTask: {
      async claimNext() { return null; },
      async readinessSnapshot() { return health; },
    },
  });
  assert.equal(await runner.isReady(), false);
  await runner.tick();
  assert.equal(await runner.isReady(), true);
  health = { oldestPendingLagMs: 30_001, expiredAttemptCount: 0 };
  assert.equal(await runner.isReady(), false);
  health = { oldestPendingLagMs: 0, expiredAttemptCount: 1 };
  assert.equal(await runner.isReady(), false);
  health = { oldestPendingLagMs: 0, expiredAttemptCount: 0 };
  now = new Date("2026-08-13T12:01:01.000Z");
  assert.equal(await runner.isReady(), false);
});

test("inline fallback claims exactly the created task without taking another budget lane", async () => {
  const calls = [];
  const runner = buildRaceResolutionPostTaskRunner({
    env: {},
    raceResolutionWorkBudget: {
      async run() { assert.fail("inline processing already owns the core lane"); },
    },
    RaceResolutionPostTask: {
      async claimById({ id }) {
        calls.push(`claim:${id}`);
        return {
          id,
          raceId: "r",
          sourceGeneration: 1,
          leaseToken: "lease",
          snapshotState: "pending",
          snapshotCommand: { raceId: "r", timeZone: "UTC" },
        };
      },
      async listIntents() { return []; },
      async beginSnapshot() { return "attempt"; },
      async completeSnapshot() { calls.push("complete"); },
      async finish() { return "succeeded"; },
    },
    async publishSnapshot() { calls.push("publish"); return true; },
    async isSuperseded() { return false; },
  });

  assert.deepEqual(await runner.processTaskId("task-1"), {
    taskId: "task-1",
    state: "succeeded",
  });
  assert.deepEqual(calls, ["claim:task-1", "publish", "complete"]);
});
