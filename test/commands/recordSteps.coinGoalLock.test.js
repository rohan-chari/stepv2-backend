const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRecordSteps } = require("../../src/commands/recordSteps");

// Helper: build a recordSteps with tracked coin awards and configurable state
function setup({ existingRecord = null, userStepGoal, stepCount, date = "2026-03-19" }) {
  const coinAwards = [];

  const recordSteps = buildRecordSteps({
    Steps: {
      async findByUserIdAndDate() {
        return existingRecord;
      },
      async create(payload) {
        return { id: "step-1", ...payload };
      },
      async update(id, fields) {
        return { id, ...existingRecord, ...fields };
      },
    },
    User: {
      async update() {},
      async findById() {
        return { id: "user-1", stepGoal: userStepGoal };
      },
    },
    eventBus: { emit() {} },
    awardCoins: async (params) => {
      coinAwards.push(params);
      return { awarded: true, coins: 0 };
    },
    now: () => new Date("2026-03-19T15:00:00.000Z"),
  });

  return {
    coinAwards,
    run: () => recordSteps({ userId: "user-1", steps: stepCount, date }),
  };
}

test("coin goal lock: lowering step goal should not unlock 2x bonus retroactively", async () => {
  // Day starts with goal=5000, user syncs 6000 steps → gets 1x coins
  const firstSync = setup({
    existingRecord: null,
    userStepGoal: 5000,
    stepCount: 6000,
  });
  await firstSync.run();
  const firstAwards = firstSync.coinAwards.map((a) => a.reason);
  assert.ok(firstAwards.includes("daily_goal_1x"), "should award 1x on first sync");
  assert.ok(!firstAwards.includes("daily_goal_2x"), "should not award 2x (6000 < 10000)");

  // User lowers goal to 3000, steps sync again with 6000 steps.
  // 6000 >= 3000*2 = 6000, so with the NEW goal, 2x would trigger.
  // But the locked-in goal is 5000, so 2x should NOT trigger (6000 < 10000).
  const secondSync = setup({
    existingRecord: { id: "step-1", userId: "user-1", steps: 5000, stepGoal: 5000 },
    userStepGoal: 3000, // user changed their goal
    stepCount: 6000,
  });
  await secondSync.run();
  const secondAwards = secondSync.coinAwards.map((a) => a.reason);
  assert.ok(!secondAwards.includes("daily_goal_2x"),
    "should NOT award 2x when goal was lowered after record creation");
});

test("coin goal lock: raising step goal should not unlock 1x bonus retroactively", async () => {
  // Day starts with goal=10000, user syncs 6000 steps → no coins
  const firstSync = setup({
    existingRecord: null,
    userStepGoal: 10000,
    stepCount: 6000,
  });
  await firstSync.run();
  assert.equal(firstSync.coinAwards.length, 0, "no coins at 6000/10000 goal");

  // User lowers goal to 5000, steps sync again.
  // 6000 >= 5000, so with the NEW goal, 1x would trigger.
  // But the locked-in goal is 10000, so 1x should NOT trigger.
  const secondSync = setup({
    existingRecord: { id: "step-1", userId: "user-1", steps: 6000, stepGoal: 10000 },
    userStepGoal: 5000,
    stepCount: 6000,
  });
  await secondSync.run();
  assert.equal(secondSync.coinAwards.length, 0,
    "should NOT award coins when original goal was 10000");
});

test("coin goal lock: new step record stores the current step goal", async () => {
  let createdPayload = null;

  const recordSteps = buildRecordSteps({
    Steps: {
      async findByUserIdAndDate() { return null; },
      async create(payload) {
        createdPayload = payload;
        return { id: "step-1", ...payload };
      },
    },
    User: {
      async update() {},
      async findById() {
        return { id: "user-1", stepGoal: 7500 };
      },
    },
    eventBus: { emit() {} },
    awardCoins: async () => ({ awarded: false, coins: 0 }),
    now: () => new Date("2026-03-19T15:00:00.000Z"),
  });

  await recordSteps({ userId: "user-1", steps: 3000, date: "2026-03-19" });
  assert.equal(createdPayload.stepGoal, 7500,
    "step record should store the user's step goal at creation time");
});

test("coin goal lock: updating steps re-uses the locked-in goal, not current user goal", async () => {
  const coinAwards = [];

  const recordSteps = buildRecordSteps({
    Steps: {
      async findByUserIdAndDate() {
        // Existing record was created when goal was 5000
        return { id: "step-1", userId: "user-1", steps: 4000, stepGoal: 5000 };
      },
      async update(id, fields) {
        return { id, userId: "user-1", stepGoal: 5000, ...fields };
      },
    },
    User: {
      async update() {},
      async findById() {
        // User has since changed goal to 2000
        return { id: "user-1", stepGoal: 2000 };
      },
    },
    eventBus: { emit() {} },
    awardCoins: async (params) => {
      coinAwards.push(params);
      return { awarded: true, coins: 0 };
    },
    now: () => new Date("2026-03-19T15:00:00.000Z"),
  });

  // 5000 steps: meets the locked-in 5000 goal (1x), but NOT 2x (10000)
  // With the user's current goal of 2000, it would also meet 2x (4000) — but shouldn't
  await recordSteps({ userId: "user-1", steps: 5000, date: "2026-03-19" });

  const reasons = coinAwards.map((a) => a.reason);
  assert.ok(reasons.includes("daily_goal_1x"), "should award 1x against locked-in goal of 5000");
  assert.ok(!reasons.includes("daily_goal_2x"),
    "should NOT award 2x — 5000 < 10000 (locked-in goal * 2)");
});
