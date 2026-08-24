const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRecordSteps } = require("../../src/modules/steps/commands/recordSteps");

function harness({ existing = null } = {}) {
  const updates = [];
  const events = [];
  const intakes = [];
  const now = new Date("2026-08-24T15:00:00.000Z");
  let reconcileCalled = false;
  let resolveCalled = false;
  const recordSteps = buildRecordSteps({
    prisma: {
      step: { async findUnique() { throw new Error("pre-lock lookup is forbidden"); } },
    },
    stepInputIntake: async (input) => {
      intakes.push(input);
      return {
        dailyExisted: Boolean(existing),
        record: {
          id: "step-1",
          userId: input.userId,
          date: new Date(input.daily.date),
          steps: input.daily.steps,
          stepGoal: null,
          createdAt: now,
        },
      };
    },
    User: { async update(id, fields) { updates.push({ id, fields }); } },
    eventBus: { emit(event, payload) { events.push({ event, payload }); } },
    appSettings: { async getFlag() { return false; } },
    reconcileUploaderRaces: async () => { reconcileCalled = true; },
    resolveRaceState: async () => { resolveCalled = true; },
    now: () => now,
  });
  return {
    recordSteps,
    updates,
    events,
    intakes,
    now,
    inlineCalled: () => reconcileCalled || resolveCalled,
  };
}

test("recordSteps delegates one queue-only atomic intake and preserves create side effects", async () => {
  const ctx = harness();
  const result = await ctx.recordSteps({
    userId: "user-1",
    steps: 8765,
    date: "2026-08-24",
    timeZone: "America/New_York",
  });
  assert.equal(result.id, "step-1");
  assert.equal(result.stepGoal, 5000);
  assert.equal(ctx.intakes.length, 1);
  assert.deepEqual(ctx.intakes[0].daily, { date: "2026-08-24", steps: 8765 });
  assert.equal(ctx.intakes[0].endpoint, "steps");
  assert.deepEqual(ctx.updates, [{
    id: "user-1",
    fields: { lastStepSyncAt: ctx.now },
  }]);
  assert.deepEqual(ctx.events, [{
    event: "STEPS_RECORDED",
    payload: { userId: "user-1", steps: 8765, date: "2026-08-24" },
  }]);
  assert.equal(ctx.inlineCalled(), false);
});

test("recordSteps preserves update event and makes skipRaceResolution a scheduling no-op", async () => {
  const ctx = harness({ existing: { id: "step-1" } });
  await ctx.recordSteps({
    userId: "user-1",
    steps: 9000,
    date: "2026-08-24",
    skipRaceResolution: true,
  });
  assert.equal(ctx.intakes.length, 1);
  assert.equal(ctx.events[0].event, "STEPS_UPDATED");
  assert.equal(ctx.inlineCalled(), false);
});

test("recordSteps does not turn a best-effort timestamp failure into intake failure", async () => {
  const ctx = harness();
  ctx.recordSteps = buildRecordSteps({
    prisma: { step: { async findUnique() { throw new Error("pre-lock lookup is forbidden"); } } },
    stepInputIntake: async (input) => ({
      dailyExisted: false,
      record: { id: "step-1", userId: input.userId, date: new Date(input.daily.date), steps: input.daily.steps },
    }),
    User: { async update() { throw new Error("stamp unavailable"); } },
    eventBus: { emit() {} },
    appSettings: { async getFlag() { return false; } },
  });
  const result = await ctx.recordSteps({
    userId: "user-1", steps: 1, date: "2026-08-24",
  });
  assert.equal(result.id, "step-1");
});
