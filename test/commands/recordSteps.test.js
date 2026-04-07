const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRecordSteps } = require("../../src/commands/recordSteps");

test("recordSteps stamps lastStepSyncAt when creating a daily record", async () => {
  const updates = [];
  const events = [];
  const now = new Date("2026-03-19T15:30:00.000Z");

  const recordSteps = buildRecordSteps({
    Steps: {
      async findByUserIdAndDate(userId, date) {
        assert.equal(userId, "user-1");
        assert.equal(date, "2026-03-19");
        return null;
      },
      async create(payload) {
        return { id: "step-1", ...payload };
      },
    },
    User: {
      async update(id, fields) {
        updates.push({ id, fields });
      },
      async findById() {
        return { id: "user-1", stepGoal: 5000 };
      },
    },
    eventBus: {
      emit(event, payload) {
        events.push({ event, payload });
      },
    },
    awardCoins: async () => {},
    resolveRaceState: async () => {},
    now: () => now,
  });

  const result = await recordSteps({
    userId: "user-1",
    steps: 8765,
    date: "2026-03-19",
  });

  assert.equal(result.id, "step-1");
  assert.deepEqual(updates, [
    {
      id: "user-1",
      fields: { lastStepSyncAt: now },
    },
  ]);
  assert.deepEqual(events, [
    {
      event: "STEPS_RECORDED",
      payload: { userId: "user-1", steps: 8765, date: "2026-03-19" },
    },
  ]);
});

test("recordSteps stamps lastStepSyncAt when updating an existing daily record", async () => {
  const updates = [];
  const events = [];
  const now = new Date("2026-03-19T16:00:00.000Z");

  const recordSteps = buildRecordSteps({
    Steps: {
      async findByUserIdAndDate() {
        return { id: "step-1", userId: "user-1", steps: 5000 };
      },
      async update(id, fields) {
        assert.equal(id, "step-1");
        assert.deepEqual(fields, { steps: 9000 });
        return { id, ...fields };
      },
    },
    User: {
      async update(id, fields) {
        updates.push({ id, fields });
      },
    },
    eventBus: {
      emit(event, payload) {
        events.push({ event, payload });
      },
    },
    awardCoins: async () => {},
    resolveRaceState: async () => {},
    now: () => now,
  });

  const result = await recordSteps({
    userId: "user-1",
    steps: 9000,
    date: "2026-03-19",
  });

  assert.equal(result.id, "step-1");
  assert.deepEqual(updates, [
    {
      id: "user-1",
      fields: { lastStepSyncAt: now },
    },
  ]);
  assert.deepEqual(events, [
    {
      event: "STEPS_UPDATED",
      payload: { userId: "user-1", steps: 9000, date: "2026-03-19" },
    },
  ]);
});

test("recordSteps resolves active race state after writing steps", async () => {
  let resolved = null;

  const recordSteps = buildRecordSteps({
    Steps: {
      async findByUserIdAndDate() {
        return null;
      },
      async create(payload) {
        return { id: "step-1", ...payload };
      },
    },
    User: {
      async update() {},
      async findById() {
        return { id: "user-1", stepGoal: 5000 };
      },
    },
    eventBus: { emit() {} },
    awardCoins: async () => {},
    resolveRaceState: async (payload) => {
      resolved = payload;
    },
  });

  await recordSteps({
    userId: "user-1",
    steps: 8765,
    date: "2026-03-19",
  });

  assert.deepEqual(resolved, { userId: "user-1", timeZone: undefined });
});
