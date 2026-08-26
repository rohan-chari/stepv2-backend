const assert = require("node:assert/strict");
const test = require("node:test");

const { buildDailyRewardReminder } = require("../../src/modules/notifications/dailyRewardReminder");
const { buildStepMilestoneReminder } = require("../../src/modules/notifications/stepMilestoneReminder");
const { getTimeZoneParts } = require("../../src/shared/time/week");

const DAILY_NOW = new Date("2026-07-19T21:15:00.000Z");
const MILESTONE_NOW = new Date("2026-07-19T23:15:00.000Z");

function durableHarness({ kind, failUserId }) {
  const appended = new Set();
  const attempts = [];
  let completedDay = null;
  let failOnce = true;
  const users = [{ id: "u1", lastDailyClaimDate: null }, { id: "u2", lastDailyClaimDate: null }];
  const JobRun = {
    async lastRanFor() { return completedDay; },
    async markRan(_name, day) { completedDay = day; },
  };
  const User = {
    async distinctTimezones() { return ["America/New_York"]; },
    async findRemindableInZones() { return users; },
    async findStepMilestoneRemindable() { return users; },
  };
  const prisma = { async $transaction(work) { return work({}); } };
  const appendDomainEvent = async (_tx, event) => {
    const userId = event.audience[0].recipientId;
    attempts.push(userId);
    if (userId === failUserId && failOnce) {
      failOnce = false;
      throw Object.assign(new Error("simulated crash window"), { code: "DB_TRANSIENT" });
    }
    appended.add(event.eventKey);
  };
  const common = {
    User,
    JobRun,
    prisma,
    appendDomainEvent,
    getTimeZoneParts,
    isDisabled: () => false,
    logger: { log() {}, error() {}, warn() {} },
  };
  const run = kind === "daily"
    ? buildDailyRewardReminder({ ...common, now: () => DAILY_NOW })
    : buildStepMilestoneReminder({ ...common, now: () => MILESTONE_NOW });
  return { run, appended, attempts, completedDay: () => completedDay };
}

for (const kind of ["daily", "milestone"]) {
  test(`${kind} reminder leaves its completion marker open after a midway append failure and resumes`, async () => {
    const harness = durableHarness({ kind, failUserId: "u2" });
    await harness.run();
    assert.equal(harness.completedDay(), null, "partial fan-out is not marked complete");
    await harness.run();
    assert.equal(harness.completedDay(), "2026-07-19");
    assert.equal(harness.appended.size, 2);
    assert.deepEqual(harness.attempts, ["u1", "u2", "u1", "u2"]);
  });

  test(`${kind} reminder leaves its completion marker open after an immediate append failure`, async () => {
    const harness = durableHarness({ kind, failUserId: "u1" });
    await harness.run();
    assert.equal(harness.completedDay(), null);
    await harness.run();
    assert.equal(harness.completedDay(), "2026-07-19");
    assert.equal(harness.appended.size, 2);
  });
}
