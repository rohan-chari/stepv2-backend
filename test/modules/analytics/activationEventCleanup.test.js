const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildCleanupActivationEvents,
  JOB_NAME,
} = require("../../../src/modules/analytics/activationEventCleanup");

test("activation cleanup deletes server-received events older than 90 days", async () => {
  let deletedWhere;
  const marks = [];
  const run = buildCleanupActivationEvents({
    now: () => new Date("2026-07-20T07:00:00.000Z"),
    targetHour: 2,
    logger: { log() {} },
    prisma: {
      activationEvent: {
        async deleteMany({ where }) {
          deletedWhere = where;
          return { count: 3 };
        },
      },
    },
    JobRun: {
      async lastRanFor() { return null; },
      // Was markRan; the job now claims the tick atomically before doing work so
      // cluster workers can't each issue their own deleteMany. claimRun persists
      // the run key itself, so it replaces markRan rather than joining it.
      async claimRun(jobName, dayKey) { marks.push({ jobName, dayKey }); return true; },
    },
  });

  assert.deepEqual(await run(), { count: 3 });
  assert.equal(deletedWhere.createdAt.lt.toISOString(), "2026-04-21T07:00:00.000Z");
  assert.equal(marks[0].jobName, JOB_NAME);
});

test("activation cleanup does not delete when another cluster worker won the claim", async () => {
  let deleteCalled = false;
  const run = buildCleanupActivationEvents({
    now: () => new Date("2026-07-20T07:00:00.000Z"),
    targetHour: 2,
    logger: { log() {}, error() {} },
    prisma: {
      activationEvent: {
        async deleteMany() {
          deleteCalled = true;
          return { count: 3 };
        },
      },
    },
    JobRun: {
      async lastRanFor() { return null; },
      async claimRun() { return false; }, // another worker already claimed this tick
    },
  });

  assert.equal(await run(), null);
  assert.equal(deleteCalled, false, "loser worker must not issue a deleteMany");
});

test("activation cleanup skips the tick if the claim itself errors", async () => {
  let deleteCalled = false;
  const run = buildCleanupActivationEvents({
    now: () => new Date("2026-07-20T07:00:00.000Z"),
    targetHour: 2,
    logger: { log() {}, error() {} },
    prisma: {
      activationEvent: {
        async deleteMany() {
          deleteCalled = true;
          return { count: 3 };
        },
      },
    },
    JobRun: {
      async lastRanFor() { return null; },
      async claimRun() { throw new Error("db down"); },
    },
  });

  assert.equal(await run(), null);
  assert.equal(deleteCalled, false, "a failed claim must not fall through to deleting");
});
