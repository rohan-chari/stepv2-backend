// step_samples retention cron (spec §4.1 / §7 item 6b).
//
// Deletes rows past BOTH cutoff predicates: period_end < now()-45d AND
// period_end < oldest started_at among non-terminal races. JobRun insert-first
// dedup prevents double-runs; STEP_SAMPLE_RETENTION_DISABLED=true skips.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, getSharedServer } = require("./setup");
const {
  buildCleanupStepSamples,
  JOB_NAME,
} = require("../../src/modules/steps/jobs/stepSampleRetention");

const DAY = 24 * 60 * 60 * 1000;

async function seedUser() {
  return prisma.user.create({
    data: {
      appleId: `apple-retain-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      email: `retain-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    },
  });
}

async function seedSample(userId, daysOldEnd, steps = 100) {
  const end = new Date(Date.now() - daysOldEnd * DAY);
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  return prisma.stepSample.create({
    data: { userId, periodStart: start, periodEnd: end, steps },
  });
}

function passJobRun() {
  const marks = [];
  return {
    marks,
    async lastRanFor() { return null; },
    async claimRun(jobName, dayKey) { marks.push({ jobName, dayKey }); return true; },
  };
}

// now anchored at a fixed hour so dailyRunKey (targetHour 3 ET) fires.
const NOW = () => new Date("2026-07-22T12:00:00.000Z");

describe("step_samples retention cron", () => {
  before(async () => { await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); });

  it("deletes rows older than 45 days when no non-terminal race exists", async () => {
    const user = await seedUser();
    const old1 = await seedSample(user.id, 60);
    const old2 = await seedSample(user.id, 50);
    const recent = await seedSample(user.id, 10);

    const run = buildCleanupStepSamples({ now: NOW, JobRun: passJobRun(), logger: { log() {} } });
    const result = await run();
    assert.equal(result.count, 2, "both >45d rows deleted");

    const remaining = await prisma.stepSample.findMany({ where: { userId: user.id } });
    assert.deepEqual(remaining.map((r) => r.id).sort(), [recent.id].sort());
    // Sanity: the two old rows are gone.
    assert.equal(await prisma.stepSample.findUnique({ where: { id: old1.id } }), null);
    assert.equal(await prisma.stepSample.findUnique({ where: { id: old2.id } }), null);
  });

  it("keeps a 50-day-old row when a non-terminal race started 55 days ago", async () => {
    const user = await seedUser();
    const veryOld = await seedSample(user.id, 60); // before the race window too
    const fiftyDay = await seedSample(user.id, 50);

    // An ACTIVE race started 55 days ago — its window can still reference samples
    // back to 55d, so the 50-day-old row must survive.
    await prisma.race.create({
      data: {
        name: "Long ultra race",
        targetSteps: 1000000,
        status: "ACTIVE",
        startedAt: new Date(Date.now() - 55 * DAY),
      },
    });

    const run = buildCleanupStepSamples({ now: NOW, JobRun: passJobRun(), logger: { log() {} } });
    const result = await run();
    assert.equal(result.count, 1, "only the 60-day row (before the race window) is deleted");

    assert.ok(await prisma.stepSample.findUnique({ where: { id: fiftyDay.id } }), "50d row survives");
    assert.equal(await prisma.stepSample.findUnique({ where: { id: veryOld.id } }), null);
  });

  it("ignores terminal (completed/cancelled) races when computing the guard", async () => {
    const user = await seedUser();
    const old = await seedSample(user.id, 50);
    // A COMPLETED race started 55 days ago must NOT protect old samples.
    await prisma.race.create({
      data: {
        name: "Finished race",
        targetSteps: 1000,
        status: "COMPLETED",
        startedAt: new Date(Date.now() - 55 * DAY),
      },
    });

    const run = buildCleanupStepSamples({ now: NOW, JobRun: passJobRun(), logger: { log() {} } });
    const result = await run();
    assert.equal(result.count, 1);
    assert.equal(await prisma.stepSample.findUnique({ where: { id: old.id } }), null);
  });

  it("deletes in bounded batches until nothing is left to prune", async () => {
    const user = await seedUser();
    // 12 old rows, batchSize 5 -> exercises the multi-batch loop.
    for (let i = 0; i < 12; i++) await seedSample(user.id, 60 + i);

    const run = buildCleanupStepSamples({
      now: NOW,
      JobRun: passJobRun(),
      batchSize: 5,
      logger: { log() {} },
    });
    const result = await run();
    assert.equal(result.count, 12);
    assert.equal(await prisma.stepSample.count({ where: { userId: user.id } }), 0);
  });

  it("does not delete when another worker won the JobRun claim (dedup)", async () => {
    const user = await seedUser();
    await seedSample(user.id, 60);

    let deleted = 0;
    const run = buildCleanupStepSamples({
      now: NOW,
      JobRun: { async lastRanFor() { return null; }, async claimRun() { return false; } },
      logger: { log() {} },
    });
    const result = await run();
    assert.equal(result, null, "loser worker returns null");
    assert.equal(await prisma.stepSample.count({ where: { userId: user.id } }), 1, "no delete");
    void deleted;
  });

  it("skips entirely when STEP_SAMPLE_RETENTION_DISABLED is set", async () => {
    const user = await seedUser();
    await seedSample(user.id, 60);

    let claimed = false;
    const run = buildCleanupStepSamples({
      now: NOW,
      disabled: true,
      JobRun: { async lastRanFor() { return null; }, async claimRun() { claimed = true; return true; } },
      logger: { log() {} },
    });
    const result = await run();
    assert.equal(result, null);
    assert.equal(claimed, false, "must not even claim the tick when disabled");
    assert.equal(await prisma.stepSample.count({ where: { userId: user.id } }), 1);
  });

  it("exposes the job name", () => {
    assert.equal(JOB_NAME, "step_sample_retention");
  });
});
