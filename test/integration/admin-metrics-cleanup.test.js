const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { cleanDatabase, createTestUser, prisma } = require("./setup");
const {
  buildAdminMetricsActivityCleanup,
  buildPushDeliveryCleanup,
  buildReferralLinkOpenCleanup,
} = require("../../src/modules/analytics/adminMetricsCleanup");

describe("admin metrics fenced retention cleanup", () => {
  beforeEach(async () => {
    await cleanDatabase();
    await prisma.analyticsCleanupRun.deleteMany();
  });

  it("activity cleanup deletes only rows strictly older than 180 days", async () => {
    const user = await createTestUser();
    const now = new Date("2026-08-18T12:00:00.000Z");
    await prisma.userActivityDay.createMany({
      data: [
        { userId: user.user.id, activityDate: new Date("2026-02-18T00:00:00Z"), firstSeenAt: new Date("2026-02-18T12:00:00Z"), lastSeenAt: new Date("2026-02-18T12:00:00Z"), metadataOccurredAt: new Date("2026-02-18T12:00:00Z"), appVersion: "2.4.0" },
        { userId: user.user.id, activityDate: new Date("2026-02-19T00:00:00Z"), firstSeenAt: new Date("2026-02-19T12:00:00Z"), lastSeenAt: new Date("2026-02-19T12:00:00Z"), metadataOccurredAt: new Date("2026-02-19T12:00:00Z"), appVersion: "2.4.0" },
      ],
    });
    const run = buildAdminMetricsActivityCleanup({ prisma, now: () => now, owner: "test-a", batchSize: 1 });
    const result = await run();
    assert.equal(result.deleted, 1);
    assert.equal(await prisma.userActivityDay.count(), 1);
    const lease = await prisma.analyticsCleanupRun.findFirst({ where: { jobKey: "admin_metrics_activity_cleanup" } });
    assert.equal(lease.state, "complete");
  });

  it("push and referral cleanup use 30d and 90d retained-account cutoffs", async () => {
    const user = await createTestUser();
    const now = new Date("2026-08-18T12:00:00.000Z");
    await prisma.pushDelivery.createMany({ data: [
      { publicId: "old-push", deliveryKey: "old-push", userId: user.user.id, notificationType: "test", openCapable: false, createdAt: new Date("2026-07-18T11:59:59Z") },
      { publicId: "boundary-push", deliveryKey: "boundary-push", userId: user.user.id, notificationType: "test", openCapable: false, createdAt: new Date("2026-07-19T12:00:00Z") },
    ] });
    await prisma.linkOpen.createMany({ data: [
      { kind: "referral", code: "BARA-OLD", createdAt: new Date("2026-05-19T11:59:59Z") },
      { kind: "referral", code: "BARA-BOUNDARY", createdAt: new Date("2026-05-20T12:00:00Z") },
    ] });
    assert.equal((await buildPushDeliveryCleanup({ prisma, now: () => now, owner: "test-p" })()).deleted, 1);
    assert.equal((await buildReferralLinkOpenCleanup({ prisma, now: () => now, owner: "test-r" })()).deleted, 1);
    assert.equal(await prisma.pushDelivery.count(), 1);
    assert.equal(await prisma.linkOpen.count(), 1);
  });

  it("account deletion cascades activity and delivery facts", async () => {
    const user = await createTestUser();
    await prisma.userActivityDay.create({
      data: {
        userId: user.user.id,
        activityDate: new Date("2026-08-01T00:00:00Z"),
        firstSeenAt: new Date("2026-08-01T12:00:00Z"),
        lastSeenAt: new Date("2026-08-01T12:00:00Z"),
        metadataOccurredAt: new Date("2026-08-01T12:00:00Z"),
        appVersion: "2.5.0",
      },
    });
    await prisma.pushDelivery.create({
      data: {
        publicId: "cascade-push",
        deliveryKey: "cascade-push",
        userId: user.user.id,
        notificationType: "test",
        openCapable: false,
      },
    });
    await prisma.user.delete({ where: { id: user.user.id } });
    assert.equal(await prisma.userActivityDay.count(), 0);
    assert.equal(await prisma.pushDelivery.count(), 0);
  });

  it("environment kill switch prevents every destructive job", async () => {
    const user = await createTestUser();
    await prisma.pushDelivery.create({ data: { publicId: "kill-push", deliveryKey: "kill-push", userId: user.user.id, notificationType: "test", openCapable: false, createdAt: new Date("2020-01-01T00:00:00Z") } });
    const result = await buildPushDeliveryCleanup({ prisma, env: { ADMIN_METRICS_V2_CLEANUP_DISABLED: "true" } })();
    assert.deepEqual(result, { skipped: "disabled", deleted: 0 });
    assert.equal(await prisma.pushDelivery.count(), 1);
  });

  it("fences an expired worker after takeover and lets the new owner complete", async () => {
    const user = await createTestUser();
    await prisma.pushDelivery.createMany({
      data: [
        { publicId: "fence-1", deliveryKey: "fence-1", userId: user.user.id, notificationType: "test", openCapable: false, createdAt: new Date("2026-01-01T00:00:00Z") },
        { publicId: "fence-2", deliveryKey: "fence-2", userId: user.user.id, notificationType: "test", openCapable: false, createdAt: new Date("2026-01-02T00:00:00Z") },
      ],
    });
    let current = new Date("2026-08-18T12:00:00Z");
    let releaseOld;
    let signalPaused;
    const paused = new Promise((resolve) => { signalPaused = resolve; });
    const release = new Promise((resolve) => { releaseOld = resolve; });
    let hookCalled = false;
    const oldRun = buildPushDeliveryCleanup({
      prisma, owner: "old-owner", leaseMs: 1000, batchSize: 1,
      now: () => current,
      afterLeaseRenew: async () => {
        if (hookCalled) return;
        hookCalled = true;
        signalPaused();
        await release;
      },
    });
    const oldPromise = oldRun();
    await Promise.race([
      paused,
      new Promise((resolve) => setTimeout(resolve, 100)),
    ]);
    assert.equal(hookCalled, true, "cleanup must expose the deterministic post-renew fence seam");
    current = new Date("2026-08-18T12:00:02Z");
    await prisma.analyticsCleanupRun.updateMany({
      where: { jobKey: "push_delivery_cleanup", leaseOwner: "old-owner" },
      data: { leaseExpiresAt: new Date("2000-01-01T00:00:00Z") },
    });
    const newResult = await buildPushDeliveryCleanup({
      prisma, owner: "new-owner", leaseMs: 1000, batchSize: 1, now: () => current,
    })();
    releaseOld();
    const oldResult = await oldPromise;

    assert.equal(newResult.deleted, 2);
    assert.equal(oldResult.skipped, "lease_lost");
    assert.equal(await prisma.pushDelivery.count(), 0);
    const run = await prisma.analyticsCleanupRun.findFirst({ where: { jobKey: "push_delivery_cleanup" } });
    assert.equal(run.state, "complete");
    assert.equal(Number(run.fence), 2);
  });

  it("rolls back a deleted batch when the fenced cursor CAS loses its lease", async () => {
    const user = await createTestUser();
    await prisma.pushDelivery.createMany({
      data: [
        { publicId: "cursor-1", deliveryKey: "cursor-1", userId: user.user.id, notificationType: "test", openCapable: false, createdAt: new Date("2026-01-01T00:00:00Z") },
        { publicId: "cursor-2", deliveryKey: "cursor-2", userId: user.user.id, notificationType: "test", openCapable: false, createdAt: new Date("2026-01-02T00:00:00Z") },
      ],
    });
    let hookCalls = 0;
    const run = buildPushDeliveryCleanup({
      prisma,
      owner: "cursor-owner",
      batchSize: 1,
      leaseMs: 60_000,
      afterDeleteBeforeCursor: async () => {
        hookCalls += 1;
        if (hookCalls !== 1) return;
        await prisma.analyticsCleanupRun.updateMany({
          where: { jobKey: "push_delivery_cleanup", leaseOwner: "cursor-owner" },
          data: { leaseExpiresAt: new Date("2000-01-01T00:00:00Z") },
        });
      },
    });
    const result = await run();
    assert.equal(result.skipped, "lease_lost");
    assert.equal(result.deleted, 0);
    assert.equal(await prisma.pushDelivery.count(), 2);
  });

  it("resumes after a crash, advances the cursor, and completes only after all batches", async () => {
    const user = await createTestUser();
    await prisma.pushDelivery.createMany({
      data: [1, 2, 3].map((value) => ({
        publicId: `resume-${value}`,
        deliveryKey: `resume-${value}`,
        userId: user.user.id,
        notificationType: "test",
        openCapable: false,
        createdAt: new Date(`2026-01-0${value}T00:00:00Z`),
      })),
    });
    let batches = 0;
    await assert.rejects(
      buildPushDeliveryCleanup({
        prisma,
        owner: "crash-owner",
        batchSize: 1,
        afterBatch: async () => {
          batches += 1;
          if (batches === 1) throw new Error("simulated crash");
        },
      })(),
      /simulated crash/
    );
    assert.equal(await prisma.pushDelivery.count(), 2);
    const crashed = await prisma.analyticsCleanupRun.findFirst({
      where: { jobKey: "push_delivery_cleanup" },
    });
    assert.equal(crashed.state, "running");
    assert.equal(crashed.cursor, "1");
    await prisma.analyticsCleanupRun.update({
      where: { id: crashed.id },
      data: { leaseExpiresAt: new Date("2000-01-01T00:00:00Z") },
    });

    const result = await buildPushDeliveryCleanup({
      prisma,
      owner: "resume-owner",
      batchSize: 1,
    })();
    assert.equal(result.deleted, 2);
    assert.equal(await prisma.pushDelivery.count(), 0);
    const completed = await prisma.analyticsCleanupRun.findUnique({
      where: { id: crashed.id },
    });
    assert.equal(completed.state, "complete");
    assert.equal(completed.cursor, "3");
    assert.equal(Number(completed.fence), 2);

    const sameDay = await buildPushDeliveryCleanup({
      prisma,
      owner: "late-owner",
    })();
    assert.deepEqual(sameDay, { skipped: "claimed", deleted: 0 });
  });
});
