const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { cleanDatabase, createTestUser, prisma } = require("./setup");
const {
  RaceResolutionPostTask,
} = require("../../src/modules/races/models/raceResolutionPostTask");
const {
  buildRaceResolutionPostTaskRunner,
} = require("../../src/modules/races/jobs/raceResolutionPostTaskRunner");
async function task() {
  const u = await createTestUser();
  const r = await prisma.race.create({
    data: {
      creatorId: u.user.id,
      name: "Publication",
      status: "ACTIVE",
      targetSteps: 10000,
    },
  });
  return RaceResolutionPostTask.create({
    raceId: r.id,
    sourceGeneration: 1,
    snapshotCommand: { raceId: r.id, timeZone: "UTC" },
    intents: [
      {
        kind: "STATE_NOTIFICATION",
        recipientUserId: u.user.id,
        payload: {},
        deliveryKeyHash: require("node:crypto").randomBytes(32).toString("hex"),
      },
    ],
  });
}
describe("deadline result publication before provider I/O", () => {
  beforeEach(cleanDatabase);
  it("cleanup preserves mismatched receipts and retains repair after successful compaction", async () => {
    const t = await task();
    const { raceId } = await prisma.raceResolutionPostTask.findUniqueOrThrow({
      where: { id: t.id },
    });
    const old = new Date(Date.now() - 10 * 86400000);
    await prisma.raceResolutionDeliveryIntent.updateMany({
      where: { taskId: t.id },
      data: { state: "rejected_no_retry", completedAt: old },
    });
    await prisma.raceResolutionPostTask.update({
      where: { id: t.id },
      data: {
        state: "succeeded_with_failures",
        snapshotState: "failed_no_retry",
        completedAt: old,
      },
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO race_resolution_post_task_receipts(race_id,source_generation,dedupe_key,terminal_state,snapshot_state,intent_count,failure_count,completed_at)
      SELECT race_id,source_generation,dedupe_key,state,'succeeded',intent_count,1,completed_at FROM race_resolution_post_tasks WHERE id=$1`,
      t.id,
    );
    assert.equal(
      await RaceResolutionPostTask.cleanupTerminal({
        before: new Date(),
        limit: 100,
      }),
      0,
      "existing mismatched snapshot receipt cannot authorize deletion",
    );
    assert.ok(
      await prisma.raceResolutionPostTask.findUnique({ where: { id: t.id } }),
    );
    await prisma.$executeRawUnsafe(
      "DELETE FROM race_resolution_post_task_receipts WHERE race_id=$1",
      raceId,
    );
    assert.equal(
      await RaceResolutionPostTask.cleanupTerminal({
        before: new Date(),
        limit: 100,
      }),
      1,
    );
    assert.equal(
      await prisma.raceResolutionPostTask.findUnique({ where: { id: t.id } }),
      null,
    );
    const [repair] = await prisma.$queryRawUnsafe(
      "SELECT * FROM race_snapshot_repair_intents WHERE task_id=$1",
      t.id,
    );
    assert.equal(repair.terminal_at, null);
    const [receipt] = await prisma.$queryRawUnsafe(
      "SELECT * FROM race_resolution_post_task_receipts WHERE race_id=$1",
      raceId,
    );
    assert.equal(receipt.snapshot_state, "failed_no_retry");
  });
  it("publishes before slow notification on this task", async () => {
    const t = await task();
    let published = false;
    const runner = buildRaceResolutionPostTaskRunner({
      isSuperseded: async () => false,
      publishSnapshot: async () => {
        published = true;
        return true;
      },
      deliverIntent: async () => {
        assert.ok(published, "provider must not precede result publication");
        return { accepted: true };
      },
    });
    await runner.processTaskId(t.id);
    const [intent] = await RaceResolutionPostTask.listIntents(t.id);
    assert.equal(intent.state, "accepted");
  });
  it("failed publication records a durable repair without retrying notification", async () => {
    const t = await task();
    let deliveries = 0;
    const runner = buildRaceResolutionPostTaskRunner({
      isSuperseded: async () => false,
      publishSnapshot: async () => false,
      deliverIntent: async () => {
        deliveries++;
        return { accepted: true };
      },
    });
    await runner.processTaskId(t.id);
    assert.equal(deliveries, 1);
    const rows = await prisma.$queryRawUnsafe(
      "SELECT * FROM race_snapshot_repair_intents WHERE task_id=$1",
      t.id,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].terminal_at, null);
    await runner.processTaskId(t.id);
    assert.equal(deliveries, 1);
  });
  it("independent snapshot lane bypasses a preceding task blocked in provider I/O", async () => {
    const first = await task();
    const second = await task();
    let release;
    let providerStarted;
    const started = new Promise((r) => (providerStarted = r));
    const blocked = new Promise((r) => (release = r));
    const published = [];
    const runner = buildRaceResolutionPostTaskRunner({
      isSuperseded: async () => false,
      publishSnapshot: async (_, t) => {
        published.push(t.id);
        return true;
      },
      deliverIntent: async () => {
        providerStarted();
        await blocked;
        return { accepted: true };
      },
    });
    const processing = runner.processTaskId(first.id);
    await started;
    try {
      assert.equal(await runner.snapshotTick(), second.id);
      assert.ok(published.includes(second.id));
    } finally {
      release();
      await processing;
    }
    await runner.processTaskId(second.id);
    assert.equal(published.filter((id) => id === second.id).length, 1);
  });
  it("crashed snapshot lease recovery records repair atomically", async () => {
    const t = await task();
    const claimed = await RaceResolutionPostTask.claimById({ id: t.id });
    await RaceResolutionPostTask.beginSnapshot({
      taskId: t.id,
      leaseToken: claimed.leaseToken,
    });
    await prisma.raceResolutionPostTask.update({
      where: { id: t.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    const reclaimed = await RaceResolutionPostTask.claimById({ id: t.id });
    assert.equal(reclaimed.snapshotState, "ambiguous_at_most_once");
    assert.equal(
      (
        await prisma.$queryRawUnsafe(
          "SELECT * FROM race_snapshot_repair_intents WHERE task_id=$1",
          t.id,
        )
      ).length,
      1,
    );
  });
  it("lost acknowledgement redelivers one coalesced repair without notification replay", async () => {
    const t = await task();
    let deliveries = 0;
    const runner = buildRaceResolutionPostTaskRunner({
      isSuperseded: async () => false,
      publishSnapshot: async () => false,
      deliverIntent: async () => {
        deliveries++;
        return { accepted: true };
      },
    });
    await runner.processTaskId(t.id);
    const original = await prisma.raceResolutionPostTask.findUniqueOrThrow({
      where: { id: t.id },
    });
    await prisma.$executeRawUnsafe(
      "CREATE FUNCTION test_repair_ack_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.terminal_at IS NOT NULL THEN RAISE EXCEPTION 'lost repair acknowledgement'; END IF; RETURN NEW; END $$",
    );
    await prisma.$executeRawUnsafe(
      "CREATE TRIGGER test_repair_ack_abort BEFORE UPDATE ON race_snapshot_repair_intents FOR EACH ROW EXECUTE FUNCTION test_repair_ack_abort()",
    );
    const {
      buildRaceEffectDeadlineScheduler,
    } = require("../../src/modules/races/jobs/raceEffectDeadlineScheduler");
    const scheduler = buildRaceEffectDeadlineScheduler();
    try {
      await scheduler.tick();
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER test_repair_ack_abort ON race_snapshot_repair_intents",
      );
      await prisma.$executeRawUnsafe("DROP FUNCTION test_repair_ack_abort()");
    }
    const first = await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId: original.raceId },
    });
    const intent = await prisma.raceSnapshotRepairIntent.findUniqueOrThrow({
      where: { taskId: t.id },
    });
    assert.equal(intent.terminalAt, null);
    await prisma.raceSnapshotRepairIntent.update({
      where: { taskId: t.id },
      data: { availableAt: new Date(Date.now() - 1) },
    });
    await scheduler.tick();
    assert.equal(
      (
        await prisma.raceResolutionJobV2.findUniqueOrThrow({
          where: { raceId: original.raceId },
        })
      ).generation,
      first.generation,
    );
    assert.ok(
      (
        await prisma.raceSnapshotRepairIntent.findUniqueOrThrow({
          where: { taskId: t.id },
        })
      ).terminalAt,
    );
    assert.equal(deliveries, 1);
  });
  it("startup census recovers retained old-process failure receipts after task cleanup", async () => {
    const t = await task();
    const runner = buildRaceResolutionPostTaskRunner({
      isSuperseded: async () => false,
      publishSnapshot: async () => false,
      deliverIntent: async () => ({ accepted: true }),
    });
    await runner.processTaskId(t.id);
    const original = await prisma.raceResolutionPostTask.findUniqueOrThrow({
      where: { id: t.id },
    });
    await prisma.raceSnapshotRepairIntent.deleteMany({
      where: { raceId: original.raceId },
    });
    await prisma.raceResolutionPostTask.delete({ where: { id: t.id } });
    const {
      buildRaceEffectDeadlineScheduler,
    } = require("../../src/modules/races/jobs/raceEffectDeadlineScheduler");
    await buildRaceEffectDeadlineScheduler().recover();
    const repairs = await prisma.raceSnapshotRepairIntent.findMany({
      where: { raceId: original.raceId },
    });
    assert.equal(repairs.length, 1);
    assert.equal(repairs[0].sourceGeneration, original.sourceGeneration);
  });
  it("missing durable job before publication creates repair above the lost generation", async () => {
    const t = await task();
    const original = await prisma.raceResolutionPostTask.findUniqueOrThrow({
      where: { id: t.id },
    });
    const runner = buildRaceResolutionPostTaskRunner({
      deliverIntent: async () => ({ accepted: true }),
    });
    await runner.processTaskId(t.id);
    assert.equal(
      await prisma.raceSnapshotRepairIntent.count({ where: { taskId: t.id } }),
      1,
    );
    const {
      buildRaceEffectDeadlineScheduler,
    } = require("../../src/modules/races/jobs/raceEffectDeadlineScheduler");
    await buildRaceEffectDeadlineScheduler().tick();
    const job = await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId: original.raceId },
    });
    assert.ok(job.generation > original.sourceGeneration);
  });
  it("a newer queued generation alone cannot erase a failed publication obligation", async () => {
    const t = await task();
    const original = await prisma.raceResolutionPostTask.findUniqueOrThrow({
      where: { id: t.id },
    });
    await prisma.raceResolutionJobV2.create({
      data: {
        raceId: original.raceId,
        generation: 2,
        state: "QUEUED",
        requestedAt: new Date(),
      },
    });
    await buildRaceResolutionPostTaskRunner({
      deliverIntent: async () => ({ accepted: true }),
    }).processTaskId(t.id);
    assert.equal(
      await prisma.raceSnapshotRepairIntent.count({ where: { taskId: t.id } }),
      1,
    );
    await prisma.raceResolutionJobV2.update({
      where: { raceId: original.raceId },
      data: { state: "FAILED", attempts: 3 },
    });
    const {
      buildRaceEffectDeadlineScheduler,
    } = require("../../src/modules/races/jobs/raceEffectDeadlineScheduler");
    await buildRaceEffectDeadlineScheduler().tick();
    assert.equal(
      (
        await prisma.raceResolutionJobV2.findUniqueOrThrow({
          where: { raceId: original.raceId },
        })
      ).state,
      "QUEUED",
    );
  });
});
