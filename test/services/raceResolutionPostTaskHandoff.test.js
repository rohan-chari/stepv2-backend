const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRaceResolutionPostTaskHandoff,
} = require("../../src/modules/races/services/raceResolutionPostTaskHandoff");

test("healthy handoff creates one generation task and leaves it for the runner", async () => {
  const calls = [];
  const handoff = buildRaceResolutionPostTaskHandoff({
    RaceResolutionPostTask: {
      async create(value) { calls.push(["create", value]); return { created: true, id: "t1" }; },
    },
    runner: {
      async isReady() { calls.push(["ready"]); return true; },
      async processTaskId() { assert.fail("healthy runner owns the task"); },
    },
    async publishSnapshotInline() { assert.fail("durable task owns publication"); },
  });

  assert.deepEqual(await handoff({
    raceId: "r1",
    sourceGeneration: 7,
    snapshotCommand: { raceId: "r1", timeZone: "UTC" },
    intents: [],
  }), { mode: "queued", taskId: "t1" });
  assert.equal(calls[0][1].sourceGeneration, 7);
});

test("durable handoffs reuse the runner's bounded positive readiness proof", async () => {
  const readinessOptions = [];
  const handoff = buildRaceResolutionPostTaskHandoff({
    RaceResolutionPostTask: {
      async create() { return { created: true, id: "t-ready" }; },
    },
    runner: {
      async isReady(options) { readinessOptions.push(options); return true; },
      async processTaskId() { assert.fail("healthy runner owns the task"); },
    },
  });

  await handoff({
    raceId: "r1",
    sourceGeneration: 13,
    snapshotCommand: { raceId: "r1", timeZone: "UTC" },
  });
  await handoff.resumeDurable("t-ready");

  assert.deepEqual(readinessOptions, [
    { positiveCacheMs: 1000 },
    { positiveCacheMs: 1000 },
  ]);
});

test("unhealthy runner atomically claims and executes the just-created task inline", async () => {
  const calls = [];
  const handoff = buildRaceResolutionPostTaskHandoff({
    RaceResolutionPostTask: {
      async create() { return { created: true, id: "t2" }; },
    },
    runner: {
      async isReady() { return false; },
      async processTaskId(id) { calls.push(id); return { taskId: id, state: "succeeded" }; },
    },
  });
  assert.deepEqual(await handoff({
    raceId: "r1",
    sourceGeneration: 8,
    snapshotCommand: { raceId: "r1", timeZone: "UTC" },
    intents: [],
  }), { mode: "inline_claim", taskId: "t2" });
  assert.deepEqual(calls, ["t2"]);
});

test("worker kill switch uses the legacy inline path before creating a durable task", async () => {
  const calls = [];
  const handoff = buildRaceResolutionPostTaskHandoff({
    RaceResolutionPostTask: {
      async create() { assert.fail("disabled worker must not strand a queued task"); },
    },
    runner: {
      isDisabled() { return true; },
      async isReady() { assert.fail("disabled state is decisive"); },
    },
    async publishSnapshotInline(command) { calls.push(["snapshot", command]); },
    async deliverIntentInline(intent) { calls.push(["intent", intent.kind]); },
  });
  const result = await handoff({
    raceId: "r1",
    sourceGeneration: 9,
    snapshotCommand: { raceId: "r1", timeZone: "UTC" },
    intents: [{ kind: "NUDGE" }],
  });
  assert.deepEqual(result, { mode: "inline_disabled", taskId: null });
  assert.deepEqual(calls.map(([kind]) => kind), ["snapshot", "intent"]);
});

test("task encoding/write failure executes the exact snapshot command inline", async () => {
  const published = [];
  const delivered = [];
  const handoff = buildRaceResolutionPostTaskHandoff({
    RaceResolutionPostTask: {
      async create() { throw new RangeError("post-task payload cap exceeded"); },
    },
    runner: { async isReady() { return true; } },
    async publishSnapshotInline(command) { published.push(command); return true; },
    async deliverIntentInline(intent) { delivered.push(intent); return { accepted: true }; },
  });
  const command = { raceId: "r1", timeZone: "America/New_York" };
  assert.deepEqual(await handoff({
    raceId: "r1",
    sourceGeneration: 9,
    snapshotCommand: command,
    intents: [
      { kind: "STATE_NOTIFICATION", id: "before" },
      { kind: "NUDGE", id: "after" },
    ],
  }), { mode: "inline_fallback", taskId: null });
  assert.deepEqual(published, [command]);
  assert.deepEqual(delivered.map((intent) => intent.id), ["before", "after"]);
});

test("durable handoff passes deferred claim resolution to the task transaction", async () => {
  let received;
  const resolveIntents = async () => [];
  const handoff = buildRaceResolutionPostTaskHandoff({
    RaceResolutionPostTask: {
      async create(value) { received = value; return { created: true, id: "t3" }; },
    },
    runner: { async isReady() { return true; } },
  });
  await handoff({
    raceId: "r1",
    sourceGeneration: 10,
    snapshotCommand: { raceId: "r1", timeZone: "UTC" },
    resolveIntents,
  });
  assert.equal(received.resolveIntents, resolveIntents);
});

test("known non-creation resolves deferred claims before legacy inline fallback", async () => {
  const delivered = [];
  const handoff = buildRaceResolutionPostTaskHandoff({
    RaceResolutionPostTask: {
      async create() { throw new Error("assembly failed"); },
      async findByGeneration() { return null; },
    },
    runner: { async isReady() { return true; } },
    async deliverIntentInline(intent) { delivered.push(intent); },
    async publishSnapshotInline() {},
  });
  await handoff({
    raceId: "r1", sourceGeneration: 11,
    snapshotCommand: { raceId: "r1", timeZone: "UTC" },
    intents: [],
    async resolveIntents() { return [{ kind: "NUDGE", id: "resolved" }]; },
  });
  assert.deepEqual(delivered.map((intent) => intent.id), ["resolved"]);
});

test("ambiguous task creation never replays a durable generation's deferred claims", async () => {
  let resolved = 0;
  const handoff = buildRaceResolutionPostTaskHandoff({
    RaceResolutionPostTask: {
      async create() { throw new Error("connection dropped after commit"); },
      async findByGeneration() { return { id: "durable-task" }; },
    },
    runner: { async isReady() { return true; } },
    async publishSnapshotInline() { assert.fail("durable owner must publish"); },
    async deliverIntentInline() { assert.fail("durable owner must deliver"); },
  });
  assert.deepEqual(await handoff({
    raceId: "r1", sourceGeneration: 12,
    snapshotCommand: { raceId: "r1", timeZone: "UTC" },
    async resolveIntents() { resolved += 1; return []; },
  }), { mode: "durable_after_error", taskId: "durable-task" });
  assert.equal(resolved, 0);
});
