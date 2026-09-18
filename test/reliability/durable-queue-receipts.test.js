const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { beforeEach, describe, it } = require("node:test");

const { cleanDatabase, createTestUser, prisma } = require("./setup");
const { appendDomainEvent } = require("../../src/modules/domainEvents");
const { bulkAppendDomainEvents } = require("../../src/modules/domainEvents");
const domainEventOutbox = require("../../src/modules/domainEvents/models/domainEventOutbox");
const { DomainEventReceipt } = require("../../src/modules/domainEvents/models/domainEventReceipt");
const {
  buildNotificationIntentService,
} = require("../../src/modules/notifications/services/notificationDelivery");
const {
  NotificationScheduleReceipt,
} = require("../../src/modules/notifications/models/notificationScheduleReceipt");
const {
  RaceResolutionPostTask,
} = require("../../src/modules/races/models/raceResolutionPostTask");
const {
  RaceResolutionJobV2,
} = require("../../src/modules/races/models/raceResolutionJobV2");
const {
  buildNotificationCompletenessReconciler,
} = require("../../src/modules/notifications/jobs/notificationCompletenessReconciler");
const {
  releaseEventNotificationPage,
} = require("../../src/modules/notifications/services/notificationAdmission");

describe("durable queue receipt lifecycle", () => {
  beforeEach(cleanDatabase);

  it("event receipt owns full-envelope replay after payload cleanup", async () => {
    const occurredAt = new Date("2026-09-02T12:00:00.000Z");
    const input = {
      eventKey: "TEST_V1:source-1",
      eventType: "TEST_V1",
      aggregateType: "TEST_SOURCE",
      aggregateId: "source-1",
      occurredAt,
      payload: { nested: { b: 2, a: 1 } },
      audience: [],
    };
    const first = await prisma.$transaction((tx) => appendDomainEvent(tx, input));
    const receipt = await prisma.domainEventReceipt.findUniqueOrThrow({
      where: { eventKey: input.eventKey },
    });
    assert.equal(receipt.receiptState, "FINAL");
    assert.match(receipt.envelopeDigest, /^[a-f0-9]{64}$/);

    await prisma.domainEventOutbox.update({
      where: { id: first.id },
      data: { status: "COMPLETED", completedAt: occurredAt },
    });
    assert.equal((await prisma.domainEventReceipt.findUniqueOrThrow({
      where: { eventKey: input.eventKey },
    })).terminalStatus, "COMPLETED");
    await prisma.domainEventOutbox.delete({ where: { id: first.id } });

    const replay = await prisma.$transaction((tx) => appendDomainEvent(tx, input));
    assert.equal(replay.receiptOnly, true);
    assert.equal(replay.id, first.id);
    assert.equal(replay.terminalStatus, "COMPLETED");
    assert.equal(await prisma.domainEventOutbox.count(), 0);
    await assert.rejects(
      prisma.$transaction((tx) => appendDomainEvent(tx, {
        ...input,
        payload: { nested: { a: 1, b: 3 } },
      })),
      (error) => error?.code === "DOMAIN_EVENT_RECEIPT_COLLISION",
    );
  });

  it("domain receipts reject conflicting replay-source and event identities", async () => {
    const occurredAt = new Date("2026-09-02T12:00:00.000Z");
    const input = {
      eventKey: "IDENTITY_V1:source-1", eventType: "IDENTITY_V1",
      aggregateType: "TEST_SOURCE", aggregateId: "source-1", occurredAt,
      replaySourceType: "RACE", replaySourceId: "race-source-1",
      payload: { stable: true }, audience: [],
    };
    const first = await prisma.$transaction((tx) => appendDomainEvent(tx, input));
    await assert.rejects(
      prisma.$transaction((tx) => appendDomainEvent(tx, {
        ...input, replaySourceType: "USER", replaySourceId: "user-source-1",
      })),
      (error) => error?.code === "DOMAIN_EVENT_RECEIPT_COLLISION",
    );
    const other = await prisma.$transaction((tx) => appendDomainEvent(tx, {
      ...input,
      eventKey: "IDENTITY_V1:source-2",
      aggregateId: "source-2",
      replaySourceId: "race-source-2",
    }));
    await prisma.domainEventReceipt.delete({ where: { eventKey: "IDENTITY_V1:source-2" } });
    await prisma.domainEventReceipt.update({
      where: { eventKey: input.eventKey }, data: { domainEventId: other.id },
    });
    await assert.rejects(
      prisma.$transaction((tx) => appendDomainEvent(tx, input)),
      (error) => error?.code === "DOMAIN_EVENT_RECEIPT_COLLISION",
    );
    assert.notEqual(first.id, other.id);
  });

  it("current event writers initialize valid zero counters while old-binary rows stay backfillable", async () => {
    const occurredAt = new Date("2026-09-02T12:00:00.000Z");
    const current = await appendDomainEvent(prisma, {
      eventKey: "COUNTERS_CURRENT_V1:1", eventType: "COUNTERS_CURRENT_V1",
      aggregateType: "TEST_SOURCE", aggregateId: "1", occurredAt,
      payload: { value: 1 }, audience: [],
    });
    const currentRow = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { id: current.id } });
    assert.equal(currentRow.projectionCount, 0);
    assert.equal(currentRow.terminalProjectionCount, 0);
    assert.equal(currentRow.failedProjectionCount, 0);
    assert.ok(currentRow.projectionCountsValidAt);

    const [legacy] = await prisma.$queryRawUnsafe(
      `INSERT INTO domain_event_outbox (
         id,event_key,event_type,schema_version,aggregate_type,aggregate_id,payload,
         occurred_at,available_at,status,created_at,updated_at
       ) VALUES (gen_random_uuid(),'COUNTERS_OLD_V1:1','COUNTERS_OLD_V1',1,
         'TEST_SOURCE','old','{}'::jsonb,$1,$1,'PENDING',$1,$1)
       RETURNING id`, occurredAt,
    );
    assert.equal((await prisma.domainEventOutbox.findUniqueOrThrow({ where: { id: legacy.id } }))
      .projectionCountsValidAt, null);
    assert.equal(await domainEventOutbox.backfillProjectionCounters({ prisma, now: occurredAt, batchSize: 10 }), 1);
    assert.equal((await prisma.domainEventOutbox.findUniqueOrThrow({ where: { id: legacy.id } }))
      .projectionCount, 0);
  });

  it("receipt backfill copies terminal proof when a terminal old-binary event has no receipt", async () => {
    const completedAt = new Date("2026-09-02T12:30:00.000Z");
    const event = await appendDomainEvent(prisma, {
      eventKey: "BACKFILL_TERMINAL_V1:1",
      eventType: "BACKFILL_TERMINAL_V1",
      aggregateType: "USER",
      aggregateId: "backfill-source",
      occurredAt: new Date("2026-09-02T12:00:00.000Z"),
      payload: {},
      audience: [],
    });
    await prisma.domainEventReceipt.delete({ where: { eventKey: event.eventKey } });
    await prisma.domainEventOutbox.update({
      where: { id: event.id },
      data: { status: "COMPLETED", completedAt },
    });

    assert.equal(await DomainEventReceipt.backfillPage({ limit: 10 }), 1);
    const receipt = await prisma.domainEventReceipt.findUniqueOrThrow({
      where: { eventKey: event.eventKey },
    });
    assert.equal(receipt.terminalStatus, "COMPLETED");
    assert.equal(receipt.completedAt.toISOString(), completedAt.toISOString());
  });

  it("projection claim applies aggregate FIFO before its global limit without starving another aggregate", async () => {
    const now = new Date("2026-09-02T12:00:00.000Z");
    await appendDomainEvent(prisma, {
      eventKey: "FIFO_BLOCKER_V1:1", eventType: "FIFO_BLOCKER_V1",
      aggregateType: "RACE", aggregateId: "hot-race", occurredAt: new Date(now.getTime() - 1000),
      payload: {}, audience: [],
    });
    const blockedEvents = [];
    for (let index = 0; index < 60; index += 1) {
      blockedEvents.push(await appendDomainEvent(prisma, {
        eventKey: `FIFO_BLOCKED_V1:${index}`, eventType: "FIFO_BLOCKED_V1",
        aggregateType: "RACE", aggregateId: "hot-race", occurredAt: new Date(now.getTime() + index),
        payload: {}, audience: [],
      }));
    }
    const unrelated = await appendDomainEvent(prisma, {
      eventKey: "FIFO_UNRELATED_V1:1", eventType: "FIFO_UNRELATED_V1",
      aggregateType: "USER", aggregateId: "unrelated-user", occurredAt: now,
      payload: {}, audience: [],
    });
    await prisma.domainEventNotificationProjection.createMany({
      data: [
        ...blockedEvents.map((event, index) => ({
          domainEventId: event.id, recipientUserId: `blocked-${index}`,
          deliveryKey: `blocked-${index}`, projectionKind: "VISIBLE", availableAt: now,
        })),
        {
          domainEventId: unrelated.id, recipientUserId: "unrelated",
          deliveryKey: "unrelated", projectionKind: "VISIBLE", availableAt: now,
        },
      ],
    });
    const [claim] = await domainEventOutbox.claimProjections({ prisma, now, batchSize: 1 });
    assert.equal((await prisma.domainEventNotificationProjection.findUniqueOrThrow({
      where: { id: claim.id },
    })).domainEventId, unrelated.id);
  });

  it("bulk append finalizes all receipts set-wise and initializes counters", async () => {
    const occurredAt = new Date("2026-09-02T12:00:00.000Z");
    const result = await prisma.$transaction((tx) => bulkAppendDomainEvents(tx,
      Array.from({ length: 20 }, (_, index) => ({
        eventKey: `BULK_RECEIPT_V1:${index}`, eventType: "BULK_RECEIPT_V1",
        aggregateType: "TEST_SOURCE", aggregateId: String(index), occurredAt,
        payload: { index }, audience: [],
      }))));
    assert.equal(result.inserted, 20);
    assert.equal(result.dispositions.length, 20);
    assert.ok(result.dispositions.every((row, ordinal) =>
      row.ordinal === ordinal && row.disposition === "INSERTED"));
    assert.equal(await prisma.domainEventReceipt.count({ where: { receiptState: "FINAL" } }), 20);
    assert.equal(await prisma.domainEventOutbox.count({ where: {
      projectionCount: 0, terminalProjectionCount: 0, failedProjectionCount: 0,
      projectionCountsValidAt: { not: null },
    } }), 20);
  });

  it("bulk replay returns ordered dispositions for live, inserted, and receipt-only inputs", async () => {
    const occurredAt = new Date("2026-09-02T12:00:00.000Z");
    const event = (key) => ({
      eventKey: key, eventType: "BULK_MIXED_V1", aggregateType: "TEST_SOURCE",
      aggregateId: key, occurredAt, payload: {}, audience: [],
    });
    const receiptOnly = await appendDomainEvent(prisma, event("BULK_MIXED_V1:receipt"));
    await prisma.domainEventOutbox.update({
      where: { id: receiptOnly.id }, data: { status: "COMPLETED", completedAt: occurredAt },
    });
    await prisma.domainEventOutbox.delete({ where: { id: receiptOnly.id } });
    const live = await appendDomainEvent(prisma, event("BULK_MIXED_V1:live"));
    const result = await prisma.$transaction((tx) => bulkAppendDomainEvents(tx, [
      event("BULK_MIXED_V1:receipt"),
      event("BULK_MIXED_V1:live"),
      event("BULK_MIXED_V1:new"),
    ]));
    assert.deepEqual(result.dispositions.map((row) => row.disposition), [
      "RECEIPT_ONLY", "REPLAYED", "INSERTED",
    ]);
    assert.equal(result.dispositions[0].terminalStatus, "COMPLETED");
    assert.equal(result.dispositions[1].domainEventId, live.id);
    assert.equal(result.inserted, 1);
    assert.equal(result.receiptOnly, 1);
  });

  it("schedule receipt prevents direct delivery recreation after schedule cleanup", async () => {
    const recipient = await createTestUser({ displayName: "Receipt Recipient" });
    const current = new Date("2026-09-02T12:00:00.000Z");
    const service = buildNotificationIntentService({
      now: () => current,
      publishWakeup: async () => true,
    });
    const input = {
      recipientUserId: recipient.user.id,
      type: "DIRECT_TEST",
      title: "Title",
      body: "Body",
      payload: { route: "home" },
      deliveryKey: "direct-receipt-key",
      availableAt: new Date("2026-09-03T12:00:00.000Z"),
      expiresAt: new Date("2026-10-03T12:00:00.000Z"),
    };
    const first = await service.submit(input);
    assert.equal(first.kind, "SCHEDULED");
    await prisma.notificationSchedule.delete({ where: { id: first.scheduleId } });
    const replay = await service.submit(input);
    assert.equal(replay.receiptOnly, true);
    assert.equal(await prisma.notificationSchedule.count(), 0);
  });

  it("schedule receipts preserve source identity while allowing only monotonic revisions", async () => {
    const recipient = await createTestUser({ displayName: "Revision Receipt Recipient" });
    const current = new Date("2026-09-02T12:00:00.000Z");
    const service = buildNotificationIntentService({
      now: () => current,
      publishWakeup: async () => true,
    });
    const base = {
      recipientUserId: recipient.user.id,
      type: "GLOBAL_EVENT_STARTED",
      title: "Title",
      body: "Body",
      payload: { route: "home" },
      deliveryKey: "source-revision-receipt-key",
      availableAt: new Date("2026-09-03T12:00:00.000Z"),
      expiresAt: new Date("2026-10-03T12:00:00.000Z"),
      sourceRef: "entitlement-source-1",
      sourceRevision: 1,
    };
    const first = await service.submit(base);
    assert.equal(first.kind, "SCHEDULED");
    await prisma.notificationSchedule.delete({ where: { id: first.scheduleId } });

    const advanced = await service.submit({
      ...base,
      title: "Revision 2",
      sourceRevision: 2,
    });
    assert.equal(advanced.kind, "SCHEDULED");
    assert.equal((await prisma.notificationScheduleReceipt.findUniqueOrThrow({
      where: { recipientUserId_deliveryKey: {
        recipientUserId: recipient.user.id,
        deliveryKey: base.deliveryKey,
      } },
    })).sourceRevision, 2);

    await prisma.notificationSchedule.delete({ where: { id: advanced.scheduleId } });
    const stale = await service.submit(base);
    assert.equal(stale.receiptOnly, true);
    assert.equal(await prisma.notificationSchedule.count(), 0);

    await assert.rejects(
      service.submit({ ...base, sourceRef: "different-source", sourceRevision: 3 }),
      (error) => error?.code === "NOTIFICATION_SCHEDULE_RECEIPT_COLLISION",
    );
  });

  it("bounded terminal schedule cleanup requires a terminal receipt and no Inbox descendant", async () => {
    const recipient = await createTestUser({ displayName: "Schedule Cleanup Recipient" });
    const current = new Date("2026-09-02T12:00:00.000Z");
    const service = buildNotificationIntentService({ now: () => current, publishWakeup: async () => true });
    const input = {
      recipientUserId: recipient.user.id,
      type: "DIRECT_CLEANUP_TEST",
      title: "Title",
      body: "Body",
      payload: { route: "home" },
      deliveryKey: "direct-cleanup-receipt-key",
      availableAt: new Date("2026-09-03T12:00:00.000Z"),
      expiresAt: new Date("2026-10-03T12:00:00.000Z"),
    };
    const scheduled = await service.submit(input);
    await prisma.notificationSchedule.update({
      where: { id: scheduled.scheduleId },
      data: { status: "EXPIRED" },
    });
    assert.equal(await NotificationScheduleReceipt.cleanupTerminalPayloads({ limit: 500 }), 0);
    await NotificationScheduleReceipt.markTerminal({
      recipientUserId: input.recipientUserId,
      deliveryKey: input.deliveryKey,
      terminalStatus: "EXPIRED",
      completedAt: current,
    });
    const alert = await prisma.inboxAlert.create({
      data: {
        userId: input.recipientUserId,
        type: input.type,
        destination: { route: "home" },
        title: input.title,
        body: input.body,
        sourceKey: input.deliveryKey,
        expiresAt: new Date("2026-10-03T12:00:00.000Z"),
      },
    });
    assert.equal(await NotificationScheduleReceipt.cleanupTerminalPayloads({ limit: 500 }), 0);
    await prisma.inboxAlert.delete({ where: { id: alert.id } });
    assert.equal(await NotificationScheduleReceipt.cleanupTerminalPayloads({ limit: 500 }), 1);
    assert.equal(await prisma.notificationSchedule.count(), 0);
    assert.equal(await prisma.notificationScheduleReceipt.count(), 1);
  });

  it("completeness reconciliation materializes a linked dormant schedule and receipt atomically", async () => {
    const recipient = await createTestUser({ displayName: "Dormant Receipt Recipient" });
    const current = new Date("2026-09-02T12:00:00.000Z");
    const service = buildNotificationIntentService({ now: () => current, publishWakeup: async () => true });
    const input = {
      recipientUserId: recipient.user.id, type: "GLOBAL_EVENT_STARTED",
      title: "Title", body: "Body", payload: { route: "home" },
      deliveryKey: "linked-dormant-receipt-key",
      availableAt: new Date("2026-09-03T12:00:00.000Z"),
      expiresAt: new Date("2026-10-03T12:00:00.000Z"),
    };
    const submitted = await service.submit(input);
    await prisma.notificationSchedule.update({
      where: { id: submitted.scheduleId }, data: { status: "CANCELLED_NO_ACTIVE_RACE" },
    });
    const alert = await prisma.inboxAlert.create({
      data: {
        userId: recipient.user.id, type: input.type, title: input.title, body: input.body,
        destination: { route: "home" }, sourceKey: input.deliveryKey,
        expiresAt: input.expiresAt,
      },
    });
    await prisma.inboxDeliveryOutbox.create({ data: {
      alertId: alert.id,
      payload: { route: "home" },
      status: "PENDING",
      availableAt: current,
      expiresAt: input.expiresAt,
    } });
    const result = await buildNotificationCompletenessReconciler({
      prisma, now: () => current,
      publishDomainWake: async () => {}, publishNotificationWake: async () => {},
    })();
    assert.equal(result.linkedDormant, 1);
    assert.equal((await prisma.notificationSchedule.findUniqueOrThrow({
      where: { id: submitted.scheduleId },
    })).status, "MATERIALIZED");
    assert.equal((await prisma.notificationScheduleReceipt.findUniqueOrThrow({
      where: { recipientUserId_deliveryKey: {
        recipientUserId: recipient.user.id, deliveryKey: input.deliveryKey,
      } },
    })).terminalStatus, "MATERIALIZED");
  });

  it("receipt cleanup honors real source lifetimes, direct horizons, unmapped retention, and descendants", async () => {
    const sourceUser = await createTestUser({ displayName: "Receipt Source" });
    const recipient = await createTestUser({ displayName: "Receipt Cleanup User" });
    const at = new Date("2026-09-02T12:00:00.000Z");
    const sourceEvent = await appendDomainEvent(prisma, {
      eventKey: "SOURCE_LIFETIME_V1:present", eventType: "SOURCE_LIFETIME_V1",
      aggregateType: "USER", aggregateId: sourceUser.user.id,
      replaySourceType: "USER", replaySourceId: sourceUser.user.id,
      occurredAt: at, payload: {}, audience: [],
    });
    await prisma.domainEventOutbox.delete({ where: { id: sourceEvent.id } });
    assert.equal(await DomainEventReceipt.cleanupDeletedSources({ limit: 500 }), 0);
    await prisma.user.delete({ where: { id: sourceUser.user.id } });
    assert.equal(await DomainEventReceipt.cleanupDeletedSources({ limit: 500 }), 1);

    await prisma.domainEventReceipt.create({
      data: {
        eventKey: "UNMAPPED_V1:keep", domainEventId: crypto.randomUUID(),
        eventType: "UNMAPPED_V1", schemaVersion: 1, aggregateType: "UNKNOWN",
        aggregateId: "unknown", occurredAt: at, availableAt: at,
        envelopeDigest: "a".repeat(64), receiptState: "FINAL", digestVersion: 1,
        replaySourceType: "LEGACY_UNMAPPED", replaySourceId: "unknown",
        finalizedAt: at,
      },
    });
    assert.equal(await DomainEventReceipt.cleanupDeletedSources({ limit: 500 }), 0);

    const oldDirect = "direct-old-cleanup";
    const futureDirect = "direct-future-cleanup";
    await prisma.notificationScheduleReceipt.createMany({ data: [
      {
        recipientUserId: recipient.user.id, deliveryKey: oldDirect, sourceKind: "DIRECT",
        directRetainUntil: new Date(at.getTime() - 1),
      },
      {
        recipientUserId: recipient.user.id, deliveryKey: futureDirect, sourceKind: "DIRECT",
        directRetainUntil: new Date(at.getTime() + 1),
      },
    ] });
    assert.equal(await NotificationScheduleReceipt.cleanupEligible({ now: at, limit: 500 }), 1);
    assert.ok(await prisma.notificationScheduleReceipt.findUnique({
      where: { recipientUserId_deliveryKey: {
        recipientUserId: recipient.user.id, deliveryKey: futureDirect,
      } },
    }));

    const sourceBackedEvent = await prisma.globalStepEvent.create({ data: {
      startsAt: at,
      endsAt: new Date(at.getTime() + 3_600_000),
      label: "Receipt cleanup source",
    } });
    const sourceBackedEntitlement = await prisma.globalStepEventEntitlement.create({ data: {
      eventId: sourceBackedEvent.id,
      userId: recipient.user.id,
      timezone: "UTC",
      localDate: "2026-09-02",
      startsAt: at,
      endsAt: new Date(at.getTime() + 3_600_000),
    } });
    const sourceBackedKey = "source-backed-cleanup";
    await prisma.notificationScheduleReceipt.create({ data: {
      recipientUserId: recipient.user.id,
      deliveryKey: sourceBackedKey,
      sourceKind: "SOURCE_BACKED",
      sourceType: "GLOBAL_STEP_EVENT_ENTITLEMENT",
      sourceId: sourceBackedEntitlement.id,
      sourceRevision: 0,
    } });
    assert.equal(await NotificationScheduleReceipt.cleanupEligible({ now: at, limit: 500 }), 0,
      "a source-backed receipt lives while its replay source exists");
    await prisma.globalStepEventEntitlement.delete({ where: { id: sourceBackedEntitlement.id } });
    assert.equal(await NotificationScheduleReceipt.cleanupEligible({ now: at, limit: 500 }), 1,
      "a source-backed receipt may be deleted only after its replay source is gone");

    const liveScheduleKey = "direct-live-schedule-block";
    await prisma.notificationScheduleReceipt.create({ data: {
      recipientUserId: recipient.user.id,
      deliveryKey: liveScheduleKey,
      sourceKind: "DIRECT",
      directRetainUntil: new Date(at.getTime() - 1),
    } });
    const liveSchedule = await prisma.notificationSchedule.create({ data: {
      recipientUserId: recipient.user.id,
      type: "TEST",
      title: "T",
      body: "B",
      payload: { route: "home" },
      deliveryKey: liveScheduleKey,
      availableAt: at,
      status: "PENDING",
    } });
    assert.equal(await NotificationScheduleReceipt.cleanupEligible({ now: at, limit: 500 }), 0,
      "a live schedule is a cleanup blocker even after the direct retention horizon");
    await prisma.notificationSchedule.delete({ where: { id: liveSchedule.id } });
    assert.equal(await NotificationScheduleReceipt.cleanupEligible({ now: at, limit: 500 }), 1);

    const blockedKey = "direct-descendant-block";
    await prisma.notificationScheduleReceipt.create({ data: {
      recipientUserId: recipient.user.id, deliveryKey: blockedKey, sourceKind: "DIRECT",
      directRetainUntil: new Date(at.getTime() - 1),
    } });
    const alert = await prisma.inboxAlert.create({ data: {
      userId: recipient.user.id, type: "TEST", title: "T", body: "B",
      destination: { route: "home" }, sourceKey: blockedKey,
      expiresAt: new Date(at.getTime() + 86_400_000),
    } });
    assert.equal(await NotificationScheduleReceipt.cleanupEligible({ now: at, limit: 500 }), 0);
    await prisma.inboxAlert.delete({ where: { id: alert.id } });
    assert.equal(await NotificationScheduleReceipt.cleanupEligible({ now: at, limit: 500 }), 1);
  });

  it("task and intent receipts survive payload cleanup until race deletion", async () => {
    const creator = await createTestUser({ displayName: "Task Receipt Creator" });
    const race = await prisma.race.create({ data: {
      creatorId: creator.user.id,
      name: "Task Receipt Race",
      targetSteps: 1000,
      status: "ACTIVE",
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      endsAt: new Date("2026-08-02T00:00:00.000Z"),
    } });
    const completedAt = new Date("2026-08-03T00:00:00.000Z");
    const created = await RaceResolutionPostTask.create({
      raceId: race.id,
      sourceGeneration: 3,
      snapshotCommand: { raceId: race.id, timeZone: "UTC" },
      intents: [{
        kind: "STATE_NOTIFICATION",
        recipientUserId: creator.user.id,
        payload: { raceId: race.id, type: "TEST" },
        deliveryKeyHash: crypto.createHash("sha256").update("intent-key").digest("hex"),
      }],
      now: completedAt,
    });
    const task = await RaceResolutionPostTask.claimById({ id: created.id, now: completedAt });
    const [intent] = await RaceResolutionPostTask.listIntents(task.id);
    assert.ok(await RaceResolutionPostTask.beginIntent({ id: intent.id, now: completedAt }));
    await RaceResolutionPostTask.completeIntent({
      id: intent.id,
      state: "accepted",
      providerDisposition: "ACCEPTED",
      now: completedAt,
    });
    await RaceResolutionPostTask.beginSnapshot({
      taskId: task.id, leaseToken: task.leaseToken, now: completedAt,
    });
    await RaceResolutionPostTask.completeSnapshot({
      taskId: task.id, state: "succeeded", now: completedAt,
    });
    assert.equal(await RaceResolutionPostTask.finish({
      taskId: task.id, leaseToken: task.leaseToken, now: completedAt,
    }), "succeeded");
    assert.equal(await RaceResolutionPostTask.cleanupTerminal({
      before: new Date("2026-09-02T00:00:00.000Z"), limit: 10,
    }), 1);
    const replay = await RaceResolutionPostTask.create({
      raceId: race.id,
      sourceGeneration: 3,
      snapshotCommand: { raceId: race.id, timeZone: "UTC" },
      intents: [],
      now: new Date("2026-09-02T00:00:00.000Z"),
    });
    assert.equal(replay.receiptOnly, true);
    assert.equal(await prisma.raceResolutionPostTaskReceipt.count(), 1);
    assert.equal(await prisma.raceResolutionDeliveryIntentReceipt.count(), 1);
    await prisma.race.delete({ where: { id: race.id } });
    assert.equal(await prisma.raceResolutionPostTaskReceipt.count(), 0);
    assert.equal(await prisma.raceResolutionDeliveryIntentReceipt.count(), 0);
  });

  it("post-task finish rejects every immutable receipt-field collision atomically", async () => {
    const creator = await createTestUser({ displayName: "Receipt Collision Creator" });
    const fields = [
      ["dedupeKey", "wrong-dedupe"], ["terminalState", "succeeded_with_failures"],
      ["snapshotState", "failed_no_retry"], ["intentCount", 9], ["failureCount", 8],
      ["completedAt", new Date("2026-09-01T00:00:00.000Z")],
    ];
    for (let index = 0; index < fields.length; index += 1) {
      const race = await prisma.race.create({ data: {
        creatorId: creator.user.id, name: `Collision ${index}`, targetSteps: 1000,
        status: "ACTIVE", startedAt: new Date("2026-08-01T00:00:00.000Z"),
        endsAt: new Date("2026-08-02T00:00:00.000Z"),
      } });
      const completedAt = new Date(`2026-09-02T00:00:0${index}.000Z`);
      const created = await RaceResolutionPostTask.create({
        raceId: race.id, sourceGeneration: 1,
        snapshotCommand: { raceId: race.id, timeZone: "UTC" }, intents: [], now: completedAt,
      });
      const task = await RaceResolutionPostTask.claimById({ id: created.id, now: completedAt });
      await RaceResolutionPostTask.beginSnapshot({ taskId: task.id, leaseToken: task.leaseToken, now: completedAt });
      await RaceResolutionPostTask.completeSnapshot({ taskId: task.id, state: "succeeded", now: completedAt });
      const receipt = {
        raceId: race.id, sourceGeneration: 1, dedupeKey: `v1:post-delivery:${race.id}:1`,
        terminalState: "succeeded", snapshotState: "succeeded", intentCount: 0,
        failureCount: 0, completedAt,
      };
      receipt[fields[index][0]] = fields[index][1];
      await prisma.raceResolutionPostTaskReceipt.create({ data: receipt });
      await assert.rejects(
        RaceResolutionPostTask.finish({ taskId: task.id, leaseToken: task.leaseToken, now: completedAt }),
        (error) => error?.code === "POST_TASK_RECEIPT_COLLISION",
        fields[index][0],
      );
      assert.equal((await prisma.raceResolutionPostTask.findUniqueOrThrow({ where: { id: task.id } })).state,
        "running", `${fields[index][0]} collision must roll back task terminalization`);
    }
  });

  it("health includes admission work and failed children whose parent counters are not valid", async () => {
    const recipient = await createTestUser({ displayName: "Health Receipt Recipient" });
    const now = new Date("2026-09-02T12:00:00.000Z");
    const failedEvent = await appendDomainEvent(prisma, {
      eventKey: "HEALTH_FAILED_V1:1",
      eventType: "HEALTH_FAILED_V1",
      aggregateType: "USER",
      aggregateId: recipient.user.id,
      occurredAt: now,
      payload: {},
      audience: [],
    });
    await prisma.domainEventOutbox.update({
      where: { id: failedEvent.id },
      data: {
        status: "FAILED_TERMINAL",
        completedAt: now,
        projectionCount: null,
        terminalProjectionCount: null,
        failedProjectionCount: null,
        projectionCountsValidAt: null,
      },
    });
    await prisma.domainEventNotificationProjection.create({ data: {
      domainEventId: failedEvent.id,
      recipientUserId: recipient.user.id,
      deliveryKey: "health-failed-projection",
      projectionKind: "VISIBLE",
      status: "FAILED_TERMINAL",
      availableAt: now,
      completedAt: now,
    } });
    await prisma.notificationSchedule.create({ data: {
      recipientUserId: recipient.user.id,
      type: "TEST",
      title: "T",
      body: "B",
      payload: {},
      deliveryKey: "health-admission-schedule",
      availableAt: now,
      status: "ADMISSION_PENDING",
    } });
    const alert = await prisma.inboxAlert.create({ data: {
      userId: recipient.user.id,
      type: "TEST",
      title: "T",
      body: "B",
      destination: {},
      sourceKey: "health-admission-outbox",
      expiresAt: new Date(now.getTime() + 86_400_000),
    } });
    await prisma.inboxDeliveryOutbox.create({ data: {
      alertId: alert.id,
      payload: {},
      status: "ADMISSION_FIRST",
      availableAt: now,
    } });

    const health = await domainEventOutbox.readHealthSnapshot(prisma);
    assert.deepEqual(health.downstream, [1, 1]);
    assert.deepEqual(health.terminalFailures, [1, 1]);
  });

  it("an unready admission schedule durably defers instead of rearming a zero-delay loop", async () => {
    const recipient = await createTestUser({ displayName: "Admission Deferral Recipient" });
    const current = new Date("2026-09-02T12:00:00.000Z");
    const race = await prisma.race.create({ data: {
      creatorId: recipient.user.id,
      name: "Admission deferral race",
      targetSteps: 1000,
      status: "ACTIVE",
      startedAt: new Date(current.getTime() - 3_600_000),
      endsAt: new Date(current.getTime() + 3_600_000),
    } });
    const event = await prisma.globalStepEvent.create({ data: {
      startsAt: new Date(current.getTime() - 60_000),
      endsAt: new Date(current.getTime() + 3_600_000),
    } });
    const entitlement = await prisma.globalStepEventEntitlement.create({ data: {
      eventId: event.id,
      userId: recipient.user.id,
      timezone: "UTC",
      localDate: "2026-09-02",
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      startOutcome: "PENDING",
    } });
    const service = buildNotificationIntentService({
      now: () => current,
      publishWakeup: async () => true,
    });
    const submitted = await service.submit({
      recipientUserId: recipient.user.id,
      type: "GLOBAL_EVENT_STARTED",
      title: "Event",
      body: "Started",
      payload: { route: "home" },
      deliveryKey: "admission-unready-defer",
      availableAt: current,
      expiresAt: event.endsAt,
      sourceRef: entitlement.id,
    });
    const first = await releaseEventNotificationPage({ prisma, now: current, maximumRows: 10 });
    assert.equal(first.materialized, 0);
    assert.equal(first.deferred, 1);
    const deferred = await prisma.notificationSchedule.findUniqueOrThrow({
      where: { id: submitted.scheduleId },
    });
    assert.ok(deferred.availableAt.getTime() >= current.getTime() + 60_000);
    assert.ok((await service.nextDueAt()).getTime() > current.getTime());

    await prisma.globalStepEventEntitlement.update({
      where: { id: entitlement.id },
      data: { startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: deferred.availableAt },
    });
    await prisma.globalEventRaceImpact.create({ data: {
      eventId: event.id,
      raceId: race.id,
      userId: recipient.user.id,
    } });
    const second = await releaseEventNotificationPage({
      prisma,
      now: deferred.availableAt,
      maximumRows: 10,
    });
    assert.equal(second.materialized, 1, "the deferred row remains recoverable");
  });

  it("orphan full-trigger cleanup deletes an old terminal-race trigger with no job row", async () => {
    const creator = await createTestUser({ displayName: "Orphan Trigger Creator" });
    const old = new Date("2026-08-01T00:00:00.000Z");
    const race = await prisma.race.create({ data: {
      creatorId: creator.user.id,
      name: "Terminal trigger race",
      targetSteps: 1000,
      status: "COMPLETED",
      startedAt: old,
      completedAt: old,
    } });
    await prisma.raceResolutionFullTrigger.create({ data: {
      raceId: race.id,
      requestedAt: old,
      createdAt: old,
    } });
    assert.equal(await RaceResolutionJobV2.cleanupOrphanFullScopeTriggers({
      before: new Date("2026-09-01T00:00:00.000Z"),
      limit: 10,
    }), 1);
    assert.equal(await prisma.raceResolutionFullTrigger.count(), 0);
  });
});
