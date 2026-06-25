const assert = require("node:assert/strict");
const test = require("node:test");

const { buildCleanupNotifications } = require("../../src/jobs/notificationCleanup");

// 4:05pm ET would be before 1am, so use early-morning ET for the "should run" case.
const ONE_AM_ET = new Date("2026-06-25T05:10:00Z"); // 1:10am EDT
const NOON_ET = new Date("2026-06-25T16:00:00Z"); // noon EDT (after 1am, same day)
const BEFORE_ONE_AM = new Date("2026-06-25T04:30:00Z"); // 12:30am EDT

function makeDeps({ now = ONE_AM_ET, lastRanFor = null, deleteResult = { count: 3 } } = {}) {
  const deletes = [];
  const marks = [];
  const deps = {
    now: () => now,
    logger: { log() {}, warn() {}, error() {} },
    Notification: {
      async deleteOlderThan(cutoff) {
        deletes.push(cutoff);
        return deleteResult;
      },
    },
    JobRun: {
      async lastRanFor() {
        return lastRanFor;
      },
      async markRan(jobName, dayKey) {
        marks.push({ jobName, dayKey });
      },
    },
  };
  return { deps, deletes, marks };
}

test("at 1am ET, deletes rows older than 7 days and marks the run", async () => {
  const { deps, deletes, marks } = makeDeps();
  const result = await buildCleanupNotifications(deps)();
  assert.equal(deletes.length, 1);
  const cutoff = deletes[0];
  const expected = ONE_AM_ET.getTime() - 7 * 24 * 60 * 60 * 1000;
  assert.equal(cutoff.getTime(), expected);
  assert.deepEqual(marks, [{ jobName: "notification_cleanup", dayKey: "2026-06-25" }]);
  assert.equal(result.count, 3);
});

test("before 1am ET, does nothing", async () => {
  const { deps, deletes, marks } = makeDeps({ now: BEFORE_ONE_AM });
  const result = await buildCleanupNotifications(deps)();
  assert.equal(result, null);
  assert.equal(deletes.length, 0);
  assert.equal(marks.length, 0);
});

test("already ran for this ET day -> no-op even later in the day", async () => {
  const { deps, deletes } = makeDeps({ now: NOON_ET, lastRanFor: "2026-06-25" });
  const result = await buildCleanupNotifications(deps)();
  assert.equal(result, null);
  assert.equal(deletes.length, 0);
});

test("a failed delete does NOT mark the run (so it retries next tick)", async () => {
  const { deps, marks } = makeDeps();
  deps.Notification.deleteOlderThan = async () => {
    throw new Error("db down");
  };
  await assert.rejects(buildCleanupNotifications(deps)());
  assert.equal(marks.length, 0);
});
