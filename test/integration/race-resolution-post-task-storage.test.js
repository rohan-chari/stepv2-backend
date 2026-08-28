const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { beforeEach, describe, it } = require("node:test");

const { cleanDatabase, createTestUser, prisma } = require("./setup");
const {
  RaceResolutionPostTask,
} = require("../../src/modules/races/models/raceResolutionPostTask");
const {
  buildRaceResolutionDeliveryIntents,
} = require("../../src/modules/races/services/raceResolutionDeliveryIntents");
const {
  buildRaceResolutionPostTaskRunner,
} = require("../../src/modules/races/jobs/raceResolutionPostTaskRunner");

describe("race resolution post-task durable storage", () => {
  beforeEach(cleanDatabase);

  it("drains two bounded cleanup pages while retaining fresh terminal work", async () => {
    const current = new Date("2026-08-28T12:00:00.000Z");
    const oldCompletedAt = new Date(current.getTime() - 8 * 24 * 60 * 60_000);
    const creator = await createTestUser({ displayName: "Cleanup Creator" });
    const race = await prisma.race.create({
      data: {
        creatorId: creator.user.id,
        name: "Cleanup Race",
        targetSteps: 10_000,
        status: "ACTIVE",
        startedAt: new Date("2026-08-01T12:00:00.000Z"),
        endsAt: new Date("2026-09-01T12:00:00.000Z"),
      },
    });
    await prisma.raceResolutionPostTask.createMany({
      data: Array.from({ length: 1101 }, (_, index) => ({
        raceId: race.id,
        sourceGeneration: index + 1,
        dedupeKey: `cleanup-old:${index}`,
        state: "succeeded",
        requestedAt: oldCompletedAt,
        notBeforeAt: oldCompletedAt,
        snapshotState: "succeeded",
        snapshotCommand: {},
        payloadBytes: 2,
        intentCount: 0,
        completedAt: oldCompletedAt,
      })),
    });
    await prisma.raceResolutionPostTask.create({
      data: {
        raceId: race.id,
        sourceGeneration: 5000,
        dedupeKey: "cleanup-fresh",
        state: "succeeded",
        requestedAt: current,
        notBeforeAt: current,
        snapshotState: "succeeded",
        snapshotCommand: {},
        payloadBytes: 2,
        intentCount: 0,
        completedAt: current,
      },
    });

    const runner = buildRaceResolutionPostTaskRunner({
      env: {},
      now: () => current,
      RaceResolutionPostTask,
    });
    assert.equal(await runner.cleanup(), 1000);
    assert.equal(await prisma.raceResolutionPostTask.count({
      where: { dedupeKey: { startsWith: "cleanup-old:" } },
    }), 101);
    assert.equal(await prisma.raceResolutionPostTask.count({
      where: { dedupeKey: "cleanup-fresh" },
    }), 1);
  });

  it("dedupes a generation and enforces immutable decided payloads in Postgres", async () => {
    const creator = await createTestUser({ displayName: "Post Task Creator" });
    const recipient = await createTestUser({ displayName: "Post Task Recipient" });
    const race = await prisma.race.create({
      data: {
        creatorId: creator.user.id,
        name: "Post Task Race",
        targetSteps: 10000,
        status: "ACTIVE",
        startedAt: new Date("2026-08-13T11:00:00.000Z"),
        endsAt: new Date("2026-08-14T11:00:00.000Z"),
      },
    });
    const input = {
      raceId: race.id,
      sourceGeneration: 7,
      snapshotCommand: { raceId: race.id, timeZone: "UTC" },
      intents: [{
        kind: "NUDGE",
        recipientUserId: recipient.user.id,
        payload: { title: "Keep moving" },
        deliveryKeyHash: crypto.createHash("sha256").update("one-attempt").digest("hex"),
      }],
      now: new Date("2026-08-13T12:00:00.000Z"),
    };

    const first = await RaceResolutionPostTask.create(input);
    const duplicate = await RaceResolutionPostTask.create(input);
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.id, first.id);
    assert.equal(
      await prisma.raceResolutionPostTask.count({
        where: { raceId: race.id, sourceGeneration: 7 },
      }),
      1
    );

    const intent = await prisma.raceResolutionDeliveryIntent.findFirstOrThrow({
      where: { taskId: first.id },
    });
    const claimed = await RaceResolutionPostTask.claimById({
      id: first.id,
      now: new Date("2026-08-13T12:00:01.000Z"),
    });
    assert.equal(claimed.id, first.id);
    assert.equal(
      await RaceResolutionPostTask.claimById({
        id: first.id,
        now: new Date("2026-08-13T12:00:02.000Z"),
      }),
      null
    );
    await assert.rejects(
      prisma.$executeRawUnsafe(
        `UPDATE race_resolution_delivery_intents
         SET payload='{"title":"changed"}'::jsonb
         WHERE id=$1`,
        intent.id
      ),
      /immutable/
    );

    // The declared recipient ON DELETE SET NULL exception remains compatible
    // with account deletion and lets the runner reject/continue in ordinal order.
    await prisma.user.delete({ where: { id: recipient.user.id } });
    const afterDelete = await prisma.raceResolutionDeliveryIntent.findUnique({
      where: { id: intent.id },
    });
    assert.equal(afterDelete.recipientUserId, null);
  });

  it("atomically claims one high-multiplier daily cap across concurrent workers", async () => {
    const actor = await createTestUser({ displayName: "Concurrent Actor" });
    const recipient = await createTestUser({ displayName: "Concurrent Recipient" });
    await prisma.deviceToken.create({
      data: { userId: recipient.user.id, token: "concurrent-cap-token", platform: "ios" },
    });

    // Keep every candidate INSERT statement open on the same MVCC snapshot so
    // this exercises the cross-worker race rather than relying on scheduler
    // timing. Production still receives the unmodified statement.
    const delayedPrisma = {
      $transaction: prisma.$transaction.bind(prisma),
      $queryRawUnsafe(sql, ...params) {
        return prisma.$queryRawUnsafe(
          sql.replace(
            "INSERT INTO notifications",
            ", delayed AS MATERIALIZED (SELECT pg_sleep(0.15))\n       INSERT INTO notifications"
          ).replace("FROM input\n       WHERE", "FROM input, delayed\n       WHERE"),
          ...params
        );
      },
    };
    const service = buildRaceResolutionDeliveryIntents({
      prisma: delayedPrisma,
      secret: "concurrent-cap-secret",
      now: () => new Date("2026-08-14T12:00:00.000Z"),
    });

    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, index) => service.claimHighMultiplier({
        raceId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        actorUserId: actor.user.id,
        actorName: actor.user.displayName,
        multiplier: 6,
        recipientUserIds: [recipient.user.id],
      }, { sourceGeneration: index + 1 }))
    );

    assert.equal(claims.flat().length, 1);
    assert.equal(
      await prisma.notification.count({
        where: { userId: recipient.user.id, type: "HIGH_MULTIPLIER_ALERT" },
      }),
      1
    );
  });

  it("rolls back claimed delivery state when durable task assembly fails", async () => {
    const creator = await createTestUser({ displayName: "Atomic Task Creator" });
    const recipient = await createTestUser({ displayName: "Atomic Task Recipient" });
    const race = await prisma.race.create({
      data: {
        creatorId: creator.user.id,
        name: "Atomic Task Race",
        targetSteps: 10000,
        status: "ACTIVE",
        startedAt: new Date("2026-08-13T11:00:00.000Z"),
        endsAt: new Date("2026-08-15T11:00:00.000Z"),
      },
    });
    await assert.rejects(
      RaceResolutionPostTask.create({
        raceId: race.id,
        sourceGeneration: 11,
        snapshotCommand: { raceId: race.id, timeZone: "UTC" },
        intents: [],
        resolveIntents: async (tx) => {
          await tx.user.update({
            where: { id: recipient.user.id },
            data: { lastSilentPushSentAt: new Date("2026-08-14T12:00:00.000Z") },
          });
          return [{
            kind: "NUDGE",
            recipientUserId: recipient.user.id,
            payload: { body: "x".repeat(20 * 1024) },
            deliveryKeyHash: crypto.createHash("sha256").update("rollback-claim").digest("hex"),
          }];
        },
      }),
      /intent payload cap exceeded/
    );
    const after = await prisma.user.findUniqueOrThrow({ where: { id: recipient.user.id } });
    assert.equal(after.lastSilentPushSentAt, null);
    assert.equal(await prisma.raceResolutionPostTask.count({ where: { raceId: race.id } }), 0);
  });

  it("does not run deferred notification claims when this generation already owns a task", async () => {
    const creator = await createTestUser({ displayName: "Duplicate Task Creator" });
    const race = await prisma.race.create({
      data: {
        creatorId: creator.user.id, name: "Duplicate Task Race", targetSteps: 10000,
        status: "ACTIVE", startedAt: new Date("2026-08-13T11:00:00.000Z"),
        endsAt: new Date("2026-08-15T11:00:00.000Z"),
      },
    });
    const command = { raceId: race.id, timeZone: "UTC" };
    await RaceResolutionPostTask.create({
      raceId: race.id, sourceGeneration: 12, snapshotCommand: command, intents: [],
    });
    let resolved = false;
    const duplicate = await RaceResolutionPostTask.create({
      raceId: race.id,
      sourceGeneration: 12,
      snapshotCommand: command,
      intents: [],
      resolveIntents: async () => { resolved = true; return []; },
    });
    assert.equal(duplicate.created, false);
    assert.equal(resolved, false);
  });
});
