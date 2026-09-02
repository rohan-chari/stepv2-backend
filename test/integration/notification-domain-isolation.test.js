const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { before, beforeEach, describe, it } = require("node:test");
const {
  cleanDatabase,
  createLegacyFeedbackThread,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const {
  appendDomainEvent,
  buildDomainEventProjectionJob,
  buildDomainEventRetention,
} = require("../../src/modules/domainEvents");
const {
  buildNotificationProjector,
} = require("../../src/modules/domainEvents/services/notificationProjector");
const domainEventRepository = require("../../src/modules/domainEvents/models/domainEventOutbox");
const {
  buildReplayDomainEvent,
} = require("../../src/modules/domainEvents/commands/replayDomainEvent");
const { canonicalPushDeliveryKey } = require("../../src/modules/notifications/pushDeliveryAttribution");
const { buildDailyRewardReminder } = require("../../src/modules/notifications/dailyRewardReminder");
const { buildStepMilestoneReminder } = require("../../src/modules/notifications/stepMilestoneReminder");
const { buildDailyMover } = require("../../src/modules/notifications/dailyMover");
const { registerNotificationHandlers } = require("../../src/modules/notifications/notificationHandlers");
const { completeRace } = require("../../src/modules/races/commands/completeRace");
const { buildRecomputePlacements } = require("../../src/modules/races/jobs/placementRecompute");

const ADMIN_EMAIL = process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";
const INBOX_HEADERS = { "X-Client-Features": "inbox_v1" };
const quietLogger = { log() {}, warn() {}, error() {} };
let server;

describe("notification domain isolation", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => {
    await cleanDatabase();
    await prisma.jobRun.deleteMany({});
    await appSettings.setFlag("apiInboxV1Enabled", true);
  });

  it("recovers a friend-request notification from Postgres after the request process handoff", async () => {
    const requester = await createTestUser({ displayName: "Domain Event Requester" });
    const addressee = await createTestUser({ displayName: "Domain Event Addressee" });

    const response = await request(server.baseUrl, "POST", "/friends/request", {
      token: requester.token,
      body: { addresseeId: addressee.user.id },
    });
    assert.equal(response.status, 201);
    const friendship = (await response.json()).friendship;

    const persisted = await prisma.domainEventOutbox.findUnique({
      where: { eventKey: `FRIEND_REQUEST_SENT_V1:${friendship.id}` },
      include: { audience: true },
    });
    assert.ok(persisted, "the durable handoff commits with the friendship");
    assert.deepEqual(persisted.audience.map((row) => row.recipientId), [addressee.user.id]);
    assert.equal(await prisma.inboxAlert.count({ where: { userId: addressee.user.id } }), 0);

    const project = buildDomainEventProjectionJob({ logger: quietLogger });
    await project();
    await project();

    const alerts = await prisma.inboxAlert.findMany({
      where: { userId: addressee.user.id, type: "FRIEND_REQUEST_SENT" },
      include: { outbox: true },
    });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].outbox.length, 1);

    await project();
    assert.equal(
      await prisma.inboxAlert.count({ where: { userId: addressee.user.id, type: "FRIEND_REQUEST_SENT" } }),
      1,
      "completion replay is idempotent",
    );

    const handlers = new Map();
    const compatibilityBus = {
      on(name, handler) { handlers.set(name, handler); },
      async emit(name, payload) { return handlers.get(name)?.(payload); },
    };
    registerNotificationHandlers({ eventBus: compatibilityBus, logger: quietLogger });
    await compatibilityBus.emit("FRIEND_REQUEST_SENT", {
      userId: requester.user.id,
      addresseeId: addressee.user.id,
    });
    assert.equal(
      await prisma.inboxAlert.count({ where: { userId: addressee.user.id, type: "FRIEND_REQUEST_SENT" } }),
      1,
      "mixed old/new producers dedupe on the canonical public delivery key",
    );
    assert.equal(
      await prisma.inboxDeliveryOutbox.count({ where: { alert: { userId: addressee.user.id } } }),
      1,
    );
  });

  it("projects real friend and race lifecycle request/command producers into Inbox", async () => {
    const creator = await createTestUser({ displayName: "Lifecycle Creator" });
    const participant = await createTestUser({ displayName: "Lifecycle Participant" });
    const friendRequest = await request(server.baseUrl, "POST", "/friends/request", {
      token: creator.token,
      body: { addresseeId: participant.user.id },
    });
    assert.equal(friendRequest.status, 201);
    const friendshipId = (await friendRequest.json()).friendship.id;
    const accepted = await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
      token: participant.token,
      body: { accept: true },
    });
    assert.equal(accepted.status, 200);

    async function createRace(name) {
      const response = await request(server.baseUrl, "POST", "/races", {
        token: creator.token,
        body: {
          name,
          targetSteps: 10_000,
          maxDurationDays: 1,
          powerupsEnabled: false,
        },
      });
      assert.equal(response.status, 201);
      return (await response.json()).race;
    }
    async function inviteAndAccept(raceId) {
      const invite = await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        token: creator.token,
        body: { inviteeIds: [participant.user.id] },
      });
      assert.equal(invite.status, 200);
      const response = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        token: participant.token,
        body: { accept: true },
      });
      assert.equal(response.status, 200);
    }

    const completedRace = await createRace("Lifecycle completion race");
    await inviteAndAccept(completedRace.id);
    await completeRace({
      raceId: completedRace.id,
      winnerUserId: creator.user.id,
      participantUserIds: [creator.user.id, participant.user.id],
    });

    const cancelledRace = await createRace("Lifecycle cancellation race");
    await inviteAndAccept(cancelledRace.id);
    const cancelled = await request(server.baseUrl, "DELETE", `/races/${cancelledRace.id}`, {
      token: creator.token,
    });
    assert.equal(cancelled.status, 200);

    const expectedEvents = [
      "FRIEND_REQUEST_SENT_V1",
      "FRIEND_REQUEST_ACCEPTED_V1",
      "RACE_INVITE_SENT_V1",
      "RACE_INVITE_ACCEPTED_V1",
      "RACE_STARTED_V1",
      "RACE_COMPLETED_V1",
      "RACE_CANCELLED_V1",
    ];
    for (const eventType of expectedEvents) {
      assert.ok(
        await prisma.domainEventOutbox.count({ where: { eventType } }),
        `${eventType} is appended by its real domain path`,
      );
    }
    const project = buildDomainEventProjectionJob({ logger: quietLogger });
    await project();
    await project();
    for (const type of expectedEvents.map((eventType) => eventType.slice(0, -3))) {
      assert.ok(
        await prisma.inboxAlert.count({ where: { type } }),
        `${type} reaches Inbox through the V1 projector`,
      );
    }
  });

  it("a support projection failure cannot roll back the committed staff message and later retries", async () => {
    const user = await createTestUser();
    const admin = await createTestUser({ email: ADMIN_EMAIL });
    const thread = await createLegacyFeedbackThread({
      userId: user.user.id,
      text: "Please investigate this notification.",
    });

    const reply = await request(
      server.baseUrl,
      "POST",
      `/admin/feedback/threads/${thread.id}/messages`,
      {
        token: admin.token,
        headers: INBOX_HEADERS,
        body: {
          text: "The domain reply remains valid even if projection is down.",
          idempotencyKey: "fe4e3840-f74d-4d44-aec9-5fabb0cc4344",
        },
      },
    );
    assert.equal(reply.status, 201);
    const message = (await reply.json()).message;

    const failingProjector = buildDomainEventProjectionJob({
      logger: quietLogger,
      random: () => 0,
      notificationIntentService: {
        async submit() { throw Object.assign(new Error("Inbox unavailable"), { code: "INBOX_UNAVAILABLE" }); },
      },
    });
    const failed = await failingProjector();
    assert.equal(failed.retries, 1);
    assert.ok(await prisma.feedbackMessage.findUnique({ where: { id: message.id } }));
    const event = await prisma.domainEventOutbox.findUnique({
      where: { eventKey: `SUPPORT_REPLY_CREATED_V1:${message.id}` },
      include: { projections: true },
    });
    assert.equal(event.status, "PROJECTING");
    assert.equal(event.projections[0].status, "RETRY");
    assert.equal(await prisma.inboxAlert.count({ where: { userId: user.user.id, type: "SUPPORT_REPLY" } }), 0);

    await prisma.domainEventNotificationProjection.updateMany({
      where: { domainEventId: event.id },
      data: { availableAt: new Date(0) },
    });
    const recover = buildDomainEventProjectionJob({ logger: quietLogger });
    await recover();
    const alert = await prisma.inboxAlert.findFirst({
      where: { userId: user.user.id, type: "SUPPORT_REPLY" },
      include: { outbox: true },
    });
    assert.ok(alert);
    assert.deepEqual(alert.destination, { route: "supportThread", threadId: thread.id });
    assert.equal(alert.outbox.length, 1);
  });

  it("reclaims an expired PROCESSING projection lease and fences the crashed worker", async () => {
    const requester = await createTestUser({ displayName: "Lease Requester" });
    const addressee = await createTestUser({ displayName: "Lease Addressee" });
    const response = await request(server.baseUrl, "POST", "/friends/request", {
      token: requester.token,
      body: { addresseeId: addressee.user.id },
    });
    assert.equal(response.status, 201);
    const friendship = (await response.json()).friendship;
    const event = await prisma.domainEventOutbox.findUniqueOrThrow({
      where: { eventKey: `FRIEND_REQUEST_SENT_V1:${friendship.id}` },
    });
    const deliveryKey = canonicalPushDeliveryKey(
      "FRIEND_REQUEST_SENT",
      addressee.user.id,
      `${requester.user.id}:${addressee.user.id}`,
    );
    await prisma.domainEventOutbox.update({
      where: { id: event.id },
      data: { status: "PROJECTING", expansionCompletedAt: new Date() },
    });
    const crashedLease = "00000000-0000-4000-8000-000000000001";
    const projection = await prisma.domainEventNotificationProjection.create({
      data: {
        domainEventId: event.id,
        recipientUserId: addressee.user.id,
        deliveryKey,
        projectionKind: "VISIBLE",
        status: "PROCESSING",
        leaseToken: crashedLease,
        leaseUntil: new Date(Date.now() - 60_000),
        availableAt: new Date(0),
      },
    });
    await prisma.notification.create({
      data: {
        userId: addressee.user.id,
        type: "FRIEND_REQUEST_SENT",
        title: "New Friend Request",
        body: `${requester.user.displayName} sent you a friend request`,
        deliveryKey: `audit:${deliveryKey}`,
      },
    });

    const project = buildDomainEventProjectionJob({ logger: quietLogger });
    await project();

    const recovered = await prisma.domainEventNotificationProjection.findUniqueOrThrow({
      where: { id: projection.id },
    });
    assert.equal(recovered.status, "COMPLETED");
    assert.equal(recovered.leaseToken, null);
    assert.equal(
      await prisma.inboxAlert.count({ where: { sourceKey: deliveryKey } }),
      1,
    );
    const staleFinish = await domainEventRepository.finishProjection(prisma, {
      id: projection.id,
      leaseToken: crashedLease,
      status: "SUPPRESSED",
    });
    assert.equal(staleFinish.count, 0, "the expired worker is fenced after reclaim");
  });

  it("does not spend the failure budget on successful fan-out pages", async () => {
    const occurredAt = new Date();
    const event = await prisma.domainEventOutbox.create({
      data: {
        eventKey: "RACE_STARTED_V1:large-fanout-failure-budget",
        eventType: "RACE_STARTED_V1",
        schemaVersion: 1,
        aggregateType: "RACE",
        aggregateId: "large-fanout-failure-budget",
        payload: {
          raceId: "large-fanout-failure-budget",
          raceName: "Large fan-out",
          creatorId: "creator",
        },
        occurredAt,
        availableAt: occurredAt,
        audience: {
          create: Array.from({ length: 1200 }, (_, ordinal) => ({
            recipientId: `fanout-user-${String(ordinal).padStart(4, "0")}`,
            ordinal,
            facts: {},
          })),
        },
      },
    });
    const lateFailureRepository = {
      ...domainEventRepository,
      async loadAudiencePage(tx, options) {
        if (Number(options.afterOrdinal) >= 1199) {
          throw Object.assign(new Error("late transient read failure"), { code: "DB_TRANSIENT" });
        }
        return domainEventRepository.loadAudiencePage(tx, options);
      },
    };
    for (let page = 0; page < 13; page += 1) {
      await prisma.domainEventOutbox.update({
        where: { id: event.id },
        data: { availableAt: new Date(0) },
      });
      let claimedThisTick = false;
      const projector = buildNotificationProjector({
        repository: lateFailureRepository,
        claimDomainEvents: async (options) => {
          if (claimedThisTick) return [];
          claimedThisTick = true;
          return domainEventRepository.claimEvents({ prisma, ...options });
        },
        claimNotificationProjections: async () => [],
        logger: quietLogger,
        random: () => 0,
      });
      await projector.run();
    }
    const failed = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { id: event.id } });
    assert.equal(failed.status, "RETRY", "a first late transient failure is retryable");
    assert.equal(failed.attemptCount, 1, "successful pages are not failure attempts");
    assert.equal(failed.expansionCursor, "1199");
    assert.equal(
      await prisma.domainEventNotificationProjection.count({ where: { domainEventId: event.id } }),
      1200,
    );

    // Local representative capacity gate: finish the largest checked-in fanout
    // while a lightweight cron-style DB probe competes for the same 20-slot
    // pool. Missing recipients intentionally exercise terminal suppression
    // without provider/network variance.
    await prisma.domainEventOutbox.update({
      where: { id: event.id },
      data: { availableAt: new Date(0) },
    });
    const capacityProjector = buildNotificationProjector({ logger: quietLogger });
    const capacityStarted = Date.now();
    const probeLatencies = [];
    for (let tick = 0; tick < 100; tick += 1) {
      const probeStarted = Date.now();
      const probe = prisma.$queryRaw`SELECT 1`.then(() => {
        probeLatencies.push(Date.now() - probeStarted);
      });
      await Promise.all([
        capacityProjector.run(),
        probe,
      ]);
      const current = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { id: event.id } });
      if (["COMPLETED", "SUPPRESSED", "FAILED_TERMINAL"].includes(current.status)) break;
    }
    const capacityElapsedMs = Date.now() - capacityStarted;
    const finalCapacityEvent = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { id: event.id } });
    const [connectionSnapshot] = await prisma.$queryRaw`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE state='active' AND wait_event_type IS NOT NULL)::int AS waiters
        FROM pg_stat_activity
       WHERE datname=current_database()
    `;
    const [latencySnapshot] = await prisma.$queryRaw`
      SELECT percentile_cont(0.95) WITHIN GROUP (
               ORDER BY extract(epoch FROM (p.completed_at-p.created_at))*1000
             )::float8 AS "p95Ms",
             percentile_cont(0.99) WITHIN GROUP (
               ORDER BY extract(epoch FROM (p.completed_at-p.created_at))*1000
             )::float8 AS "p99Ms"
        FROM domain_event_notification_projections p
       WHERE p.domain_event_id=${event.id}::uuid
    `;
    assert.equal(finalCapacityEvent.status, "COMPLETED");
    assert.ok(capacityElapsedMs < 30_000, `1200-recipient capacity elapsed ${capacityElapsedMs}ms`);
    assert.ok(Math.max(...probeLatencies) < 5_000, `cron probe max ${Math.max(...probeLatencies)}ms`);
    assert.ok(connectionSnapshot.total <= 20, `pool connections ${connectionSnapshot.total}`);
    assert.equal(connectionSnapshot.waiters, 0);
    assert.ok(latencySnapshot.p95Ms < 10_000, `projection p95 ${latencySnapshot.p95Ms}ms`);
    assert.ok(latencySnapshot.p99Ms < 30_000, `projection p99 ${latencySnapshot.p99Ms}ms`);
    console.log("[CAPACITY] domain-event fanout", {
      recipients: 1200,
      elapsedMs: capacityElapsedMs,
      cronProbeMaxMs: Math.max(...probeLatencies),
      connections: connectionSnapshot.total,
      waiters: connectionSnapshot.waiters,
      projectionP95Ms: Math.round(latencySnapshot.p95Ms),
      projectionP99Ms: Math.round(latencySnapshot.p99Ms),
    });
  });

  it("classifies consecutive race-chat events from notification-owned durable cooldown state", async () => {
    const sender = await createTestUser({ displayName: "Chat Sender" });
    const recipient = await createTestUser({ displayName: "Chat Recipient" });
    const race = await prisma.race.create({
      data: {
        creator: { connect: { id: sender.user.id } },
        name: "Cooldown Race",
        status: "ACTIVE",
        targetSteps: 10_000,
        timeBased: true,
        startedAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    await prisma.raceParticipant.createMany({
      data: [sender.user.id, recipient.user.id].map((userId) => ({
        raceId: race.id,
        userId,
        status: "ACCEPTED",
        lastChatPushAt: null,
      })),
    });
    const send = async (body) => {
      const response = await request(server.baseUrl, "POST", `/races/${race.id}/messages`, {
        token: sender.token,
        body: { body },
      });
      assert.equal(response.status, 201);
      const message = (await response.json()).message;
      await buildDomainEventProjectionJob({ logger: quietLogger })();
      return prisma.domainEventNotificationProjection.findFirstOrThrow({
        where: { event: { eventKey: `RACE_MESSAGE_SENT_V1:${message.id}` } },
      });
    };

    const first = await send("first chat message");
    assert.equal(first.projectionKind, "VISIBLE");
    const second = await send("second chat message");
    assert.equal(second.projectionKind, "SILENT_REFRESH");
    assert.equal(
      (await prisma.raceParticipant.findUniqueOrThrow({
        where: { raceId_userId: { raceId: race.id, userId: recipient.user.id } },
      })).lastChatPushAt,
      null,
      "the notification projector never writes gameplay-owned race_participants",
    );

    await prisma.notification.updateMany({
      where: { userId: recipient.user.id, type: "RACE_MESSAGE_COOLDOWN", raceId: race.id },
      data: { createdAt: new Date(Date.now() - 61_000) },
    });
    const third = await send("third chat message outside cooldown");
    assert.equal(third.projectionKind, "VISIBLE");
  });

  it("persists placement and team-lead throttle outcomes before processing", async () => {
    const first = await createTestUser({ displayName: "Placement One" });
    const second = await createTestUser({ displayName: "Placement Two" });
    const race = await prisma.race.create({
      data: {
        creator: { connect: { id: first.user.id } },
        name: "Persisted throttle race",
        targetSteps: 10_000,
        timeBased: true,
        status: "ACTIVE",
        startedAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    const occurredAt = new Date();
    const appendPlacement = async ({ suffix, previousPlacement, placement, user = first.user }) => {
      const transitionId = `placement:${race.id}:${suffix}`;
      const event = await prisma.domainEventOutbox.create({
        data: {
          eventKey: `PLACEMENT_CHANGED_V1:${transitionId}`,
          eventType: "PLACEMENT_CHANGED_V1",
          schemaVersion: 1,
          aggregateType: "RACE",
          aggregateId: race.id,
          payload: {
            transitionId,
            raceId: race.id,
            raceName: race.name,
            userId: user.id,
            previousPlacement,
            placement,
            paidPlaces: 1,
            endsAt: race.endsAt,
          },
          occurredAt,
          availableAt: occurredAt,
          audience: { create: [{ recipientId: user.id, ordinal: 0, facts: {} }] },
        },
      });
      await buildDomainEventProjectionJob({ logger: quietLogger })();
      return prisma.domainEventNotificationProjection.findFirstOrThrow({
        where: { domainEventId: event.id },
      });
    };
    assert.equal((await appendPlacement({ suffix: "take-first", previousPlacement: 2, placement: 1 })).projectionKind, "VISIBLE");
    assert.equal((await appendPlacement({ suffix: "lose-first", previousPlacement: 1, placement: 2 })).projectionKind, "SILENT_REFRESH");
    assert.equal((await appendPlacement({ suffix: "midpack", previousPlacement: 3, placement: 2 })).projectionKind, "SILENT_REFRESH");
    const payoutDrop = await appendPlacement({
      suffix: "payout-drop",
      previousPlacement: 1,
      placement: 2,
      user: second.user,
    });
    assert.equal(payoutDrop.projectionKind, "VISIBLE");
    assert.equal(
      payoutDrop.deliveryKey,
      canonicalPushDeliveryKey(
        "PLACEMENT_CHANGED",
        second.user.id,
        `payout-drop:${race.id}:${second.user.id}`,
      ),
      "the durable final classification owns the once-per-race payout delivery key",
    );

    const appendLead = async (suffix, at) => {
      const transitionId = `team-lead:${race.id}:${suffix}`;
      const event = await prisma.domainEventOutbox.create({
        data: {
          eventKey: `TEAM_LEAD_CHANGED_V1:${transitionId}`,
          eventType: "TEAM_LEAD_CHANGED_V1",
          schemaVersion: 1,
          aggregateType: "RACE",
          aggregateId: race.id,
          payload: {
            transitionId,
            raceId: race.id,
            raceName: race.name,
            leadingTeamName: "A",
            trailingTeamName: "B",
          },
          occurredAt: at,
          availableAt: at,
          audience: { create: [first.user.id, second.user.id].map((recipientId, ordinal) => ({
            recipientId,
            ordinal,
            facts: {},
          })) },
        },
      });
      await buildDomainEventProjectionJob({ logger: quietLogger })();
      return prisma.domainEventNotificationProjection.findMany({
        where: { domainEventId: event.id },
        orderBy: { recipientUserId: "asc" },
      });
    };
    const leadFirst = await appendLead("first", occurredAt);
    assert.deepEqual(leadFirst.map((row) => row.status), ["COMPLETED", "COMPLETED"]);
    const leadSecond = await appendLead("second", occurredAt);
    assert.deepEqual(leadSecond.map((row) => row.status), ["SUPPRESSED", "SUPPRESSED"]);
    assert.ok(leadSecond.every((row) => row.lastErrorCode === "TEAM_LEAD_COOLDOWN"));

    const appendFinalStretch = async (suffix, at) => {
      const transitionId = `team-final-stretch:${race.id}:${suffix}`;
      const event = await prisma.domainEventOutbox.create({
        data: {
          eventKey: `TEAM_FINAL_STRETCH_V1:${transitionId}`,
          eventType: "TEAM_FINAL_STRETCH_V1",
          schemaVersion: 1,
          aggregateType: "RACE",
          aggregateId: race.id,
          payload: {
            transitionId,
            raceId: race.id,
            raceName: race.name,
            teamATotal: 5_000,
            teamBTotal: 4_500,
            endsAt: race.endsAt,
          },
          occurredAt: at,
          availableAt: at,
          audience: { create: [first.user.id, second.user.id].map((recipientId, ordinal) => ({
            recipientId,
            ordinal,
            facts: { memberTeam: ordinal === 0 ? "TEAM_A" : "TEAM_B" },
          })) },
        },
      });
      await buildDomainEventProjectionJob({ logger: quietLogger })();
      return prisma.domainEventNotificationProjection.findMany({
        where: { domainEventId: event.id },
        orderBy: { recipientUserId: "asc" },
      });
    };
    const stretchFirst = await appendFinalStretch("first", occurredAt);
    assert.deepEqual(stretchFirst.map((row) => row.status), ["COMPLETED", "COMPLETED"]);
    const stretchSecond = await appendFinalStretch("second", occurredAt);
    assert.deepEqual(stretchSecond.map((row) => row.status), ["SUPPRESSED", "SUPPRESSED"]);
    assert.ok(stretchSecond.every((row) => row.lastErrorCode === "TEAM_FINAL_STRETCH_COOLDOWN"));
  });

  it("completes a no-device placement backlog in bounded set-based pages", async () => {
    const recipient = await createTestUser({ displayName: "No Device Placement" });
    const now = new Date();
    const events = Array.from({ length: 120 }, (_, index) => ({
      id: crypto.randomUUID(),
      eventKey: `PLACEMENT_CHANGED_V1:no-device:${index}`,
      eventType: "PLACEMENT_CHANGED_V1",
      schemaVersion: 1,
      aggregateType: "RACE",
      aggregateId: "no-device-race",
      payload: { raceId: "no-device-race", placement: 2 },
      occurredAt: now,
      availableAt: now,
      status: "PROJECTING",
      expansionCompletedAt: now,
    }));
    await prisma.$transaction(async (tx) => {
      await tx.domainEventOutbox.createMany({ data: events });
      await tx.domainEventAudience.createMany({ data: events.map((event) => ({
        domainEventId: event.id,
        recipientId: recipient.user.id,
        ordinal: 0,
        facts: {},
      })) });
      await tx.domainEventNotificationProjection.createMany({ data: events.map((event) => ({
        domainEventId: event.id,
        recipientUserId: recipient.user.id,
        deliveryKey: `silent:no-device:${event.id}`,
        projectionKind: "SILENT_REFRESH",
        availableAt: now,
      })) });
    });

    const result = await buildNotificationProjector({ logger: quietLogger }).run();
    assert.equal(result.noDeviceSilentProjected, 120);
    assert.equal(await prisma.domainEventNotificationProjection.count({
      where: { domainEventId: { in: events.map((event) => event.id) }, status: "COMPLETED" },
    }), 120);
    assert.equal(await prisma.domainEventOutbox.count({
      where: { id: { in: events.map((event) => event.id) }, status: "COMPLETED" },
    }), 120);
  });

  it("expands pure silent placement events in bounded set-based pages", async () => {
    const recipient = await createTestUser({ displayName: "Silent Placement Expansion" });
    const now = new Date();
    const events = Array.from({ length: 120 }, (_, index) => ({
      id: crypto.randomUUID(),
      eventKey: `PLACEMENT_CHANGED_V1:silent-expansion:${index}`,
      eventType: "PLACEMENT_CHANGED_V1",
      schemaVersion: 1,
      aggregateType: "RACE",
      aggregateId: `silent-expansion-race-${index}`,
      payload: {
        transitionId: `silent-expansion-${index}`,
        raceId: `silent-expansion-race-${index}`,
        previousPlacement: 3,
        placement: 2,
        paidPlaces: 1,
      },
      occurredAt: now,
      availableAt: now,
    }));
    await prisma.$transaction(async (tx) => {
      await tx.domainEventOutbox.createMany({ data: events });
      await tx.domainEventAudience.createMany({ data: events.map((event) => ({
        domainEventId: event.id,
        recipientId: recipient.user.id,
        ordinal: 0,
        facts: {},
      })) });
    });

    const result = await buildNotificationProjector({ logger: quietLogger }).run();
    assert.equal(result.placementSilentEventsExpanded, 120);
    assert.equal(result.noDeviceSilentProjected, 120);
    assert.equal(await prisma.domainEventNotificationProjection.count({
      where: {
        domainEventId: { in: events.map((event) => event.id) },
        projectionKind: "SILENT_REFRESH",
        status: "COMPLETED",
      },
    }), 120);
    assert.equal(await prisma.domainEventOutbox.count({
      where: { id: { in: events.map((event) => event.id) }, status: "COMPLETED" },
    }), 120);
  });

  it("projects the real placement job's ending, team, slacker, and placement producers", async () => {
    const members = await Promise.all([
      createTestUser({ displayName: "Team A Lead" }),
      createTestUser({ displayName: "Team A Slacker" }),
      createTestUser({ displayName: "Team B One" }),
      createTestUser({ displayName: "Team B Two" }),
    ]);
    const current = new Date();
    const startedAt = new Date(current.getTime() - 3 * 60 * 60_000);
    const endsAt = new Date(current.getTime() + 30 * 60_000);
    const teamRace = await prisma.race.create({
      data: {
        creatorId: members[0].user.id,
        name: "Real placement team job",
        status: "ACTIVE",
        targetSteps: 10_000,
        timeBased: true,
        isTeamRace: true,
        teamSize: 2,
        teamAName: "Climbers",
        teamBName: "Pacers",
        startedAt,
        endsAt,
      },
    });
    const totals = [11_000, 0, 5_000, 5_000];
    await prisma.raceParticipant.createMany({
      data: members.map((member, index) => ({
        raceId: teamRace.id,
        userId: member.user.id,
        status: "ACCEPTED",
        team: index < 2 ? "TEAM_A" : "TEAM_B",
        totalSteps: totals[index],
        lastNotifiedPlacement: index < 2 ? 2 : 1,
      })),
    });

    const individualRace = await prisma.race.create({
      data: {
        creatorId: members[0].user.id,
        name: "Real placement individual job",
        status: "ACTIVE",
        targetSteps: 10_000,
        timeBased: true,
        startedAt,
        endsAt,
      },
    });
    await prisma.raceParticipant.createMany({
      data: [
        { raceId: individualRace.id, userId: members[0].user.id, status: "ACCEPTED", totalSteps: 8_000, lastNotifiedPlacement: 2 },
        { raceId: individualRace.id, userId: members[1].user.id, status: "ACCEPTED", totalSteps: 1_000, lastNotifiedPlacement: 1 },
      ],
    });

    await buildRecomputePlacements()();
    const expectedEvents = [
      "RACE_ENDING_SOON_V1",
      "TEAM_LEAD_CHANGED_V1",
      "TEAM_FINAL_STRETCH_V1",
      "TEAM_SLACKER_NUDGE_V1",
      "PLACEMENT_CHANGED_V1",
    ];
    for (const eventType of expectedEvents) {
      assert.ok(
        await prisma.domainEventOutbox.count({ where: { eventType } }),
        `${eventType} is appended by the real placement job`,
      );
    }
    const project = buildDomainEventProjectionJob({ logger: quietLogger });
    await project();
    await project();
    for (const type of [
      "RACE_ENDING_SOON",
      "TEAM_LEAD_CHANGE",
      "TEAM_FINAL_STRETCH",
      "TEAM_SLACKER_NUDGE",
      "PLACEMENT_CHANGED",
    ]) {
      assert.ok(await prisma.inboxAlert.count({ where: { type } }), `${type} reaches Inbox`);
    }
  });

  it("fences concurrent projection claims and lets a poison recipient yield to healthy work", async () => {
    const requester = await createTestUser({ displayName: "Poison Source" });
    const poison = await createTestUser({ displayName: "Poison Recipient" });
    const healthy = await createTestUser({ displayName: "Healthy Recipient" });
    const later = await createTestUser({ displayName: "Later Recipient" });
    const now = new Date();
    const createEvent = (key, recipientIds, aggregateId = key) => prisma.domainEventOutbox.create({
      data: {
        eventKey: `FRIEND_REQUEST_SENT_V1:${key}`,
        eventType: "FRIEND_REQUEST_SENT_V1",
        schemaVersion: 1,
        aggregateType: "FRIENDSHIP",
        aggregateId,
        payload: { requesterId: requester.user.id, addresseeId: recipientIds[0] },
        occurredAt: now,
        availableAt: now,
        audience: { create: recipientIds.map((recipientId, ordinal) => ({ recipientId, ordinal, facts: {} })) },
      },
    });
    const firstEvent = await createEvent("poison-batch", [poison.user.id, healthy.user.id]);
    const laterEvent = await createEvent("later-batch", [later.user.id], "later-aggregate");
    const expansionOnly = buildNotificationProjector({
      claimNotificationProjections: async () => [],
      logger: quietLogger,
    });
    await expansionOnly.run();

    const claimNow = new Date();
    const [workerOne, workerTwo] = await Promise.all([
      domainEventRepository.claimProjections({ prisma, now: claimNow, batchSize: 1 }),
      domainEventRepository.claimProjections({ prisma, now: claimNow, batchSize: 1 }),
    ]);
    assert.equal(workerOne.length + workerTwo.length, 2);
    assert.notEqual(workerOne[0]?.id, workerTwo[0]?.id, "SKIP LOCKED gives workers distinct rows");
    for (const claim of [...workerOne, ...workerTwo]) {
      await prisma.domainEventNotificationProjection.update({
        where: { id: claim.id },
        data: { status: "PENDING", leaseToken: null, leaseUntil: null },
      });
    }

    const projector = buildNotificationProjector({
      logger: quietLogger,
      random: () => 0,
      typedProjection: async ({ audience }) => {
        if (audience.recipientId === poison.user.id) {
          throw Object.assign(new Error("poison fixture"), { code: "POISON_RECIPIENT" });
        }
        return { status: "COMPLETED" };
      },
    });
    await projector.run();
    const rows = await prisma.domainEventNotificationProjection.findMany({
      where: { domainEventId: { in: [firstEvent.id, laterEvent.id] } },
    });
    const byRecipient = new Map(rows.map((row) => [row.recipientUserId, row]));
    assert.equal(byRecipient.get(poison.user.id).status, "RETRY");
    assert.equal(byRecipient.get(healthy.user.id).status, "COMPLETED");
    assert.equal(byRecipient.get(later.user.id).status, "COMPLETED");
  });

  it("concurrent projector jobs repair stranded terminal parents before later aggregate work", async () => {
    const [claimIndex] = await prisma.$queryRawUnsafe(
      `SELECT index_row.indisvalid AS "isValid", index_row.indisready AS "isReady",
              pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate
         FROM pg_index index_row
         JOIN pg_class index_class ON index_class.oid=index_row.indexrelid
        WHERE index_class.relname='domain_event_outbox_active_aggregate_order_idx'`,
    );
    assert.deepEqual(
      { isValid: claimIndex?.isValid, isReady: claimIndex?.isReady },
      { isValid: true, isReady: true },
      "the migrated partial claim index is usable, not a failed concurrent-index shell",
    );
    assert.match(claimIndex.predicate, /COMPLETED.*SUPPRESSED.*FAILED_TERMINAL/);

    const recipient = await createTestUser({ displayName: "Stranded Projection Recipient" });
    const occurredAt = new Date("2026-08-26T18:43:38.916Z");
    const createProjectedEvent = async ({ aggregateId, suffix, offsetMs, projectionStatus }) => {
      const event = await prisma.domainEventOutbox.create({
        data: {
          eventKey: `PLACEMENT_CHANGED_V1:stranded:${suffix}`,
          eventType: "PLACEMENT_CHANGED_V1",
          schemaVersion: 1,
          aggregateType: "RACE",
          aggregateId,
          payload: { raceId: aggregateId, placement: 1 },
          occurredAt: new Date(occurredAt.getTime() + offsetMs),
          availableAt: occurredAt,
          status: "PROJECTING",
          expansionCompletedAt: occurredAt,
          audience: {
            create: [{ recipientId: recipient.user.id, ordinal: 0, facts: {} }],
          },
          projections: {
            create: [{
              recipientUserId: recipient.user.id,
              deliveryKey: `stranded:${suffix}`,
              projectionKind: "VISIBLE",
              availableAt: occurredAt,
              status: projectionStatus,
              ...(["COMPLETED", "FAILED_TERMINAL"].includes(projectionStatus)
                ? { completedAt: occurredAt }
                : {}),
            }],
          },
        },
        include: { projections: true },
      });
      return event;
    };

    const fixtures = [];
    for (const terminalStatus of ["COMPLETED", "FAILED_TERMINAL"]) {
      const aggregateId = crypto.randomUUID();
      const label = terminalStatus.toLowerCase();
      fixtures.push({
        terminalStatus,
        stranded: await createProjectedEvent({
          aggregateId, suffix: `${label}:older`, offsetMs: 0,
          projectionStatus: terminalStatus,
        }),
        later: await createProjectedEvent({
          aggregateId, suffix: `${label}:later`, offsetMs: 1,
          projectionStatus: "PENDING",
        }),
      });
    }

    const projectedEventIds = [];
    const projectorDependencies = {
      prisma,
      now: () => new Date(occurredAt.getTime() + 1_000),
      logger: quietLogger,
      typedProjection: async ({ event }) => {
        projectedEventIds.push(event.id);
        return { status: "COMPLETED" };
      },
    };
    await Promise.all([
      buildNotificationProjector(projectorDependencies).run(),
      buildNotificationProjector(projectorDependencies).run(),
    ]);

    assert.deepEqual(
      projectedEventIds.sort(),
      fixtures.map(({ later }) => later.id).sort(),
      "concurrent real projector paths claim only the later work once",
    );
    for (const { stranded, terminalStatus, later } of fixtures) {
      assert.equal(
        (await prisma.domainEventOutbox.findUnique({ where: { id: stranded.id } })).status,
        terminalStatus,
        "the claimant heals the parent state left behind by a timed-out finalization",
      );
      assert.equal(
        (await prisma.domainEventNotificationProjection.findUnique({
          where: { id: later.projections[0].id },
        })).status,
        "COMPLETED",
      );
    }
  });

  it("recovers durable daily-reward and milestone reminders without Redis", async () => {
    const localDate = "2026-08-25";
    const user = await createTestUser({
      timezone: "America/New_York",
      lastDailyClaimDate: null,
      dailyRewardRemindersEnabled: true,
      stepMilestoneRemindersEnabled: true,
    });
    await prisma.step.create({
      data: { userId: user.user.id, steps: 12_000, date: new Date(`${localDate}T00:00:00.000Z`) },
    });
    await prisma.deviceToken.create({
      data: { userId: user.user.id, token: `reminder-${user.user.id}`, platform: "ios" },
    });
    const previousRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      await buildDailyRewardReminder({
        now: () => new Date("2026-08-25T21:15:00.000Z"),
        isDisabled: () => false,
        logger: quietLogger,
      })();
      await buildStepMilestoneReminder({
        now: () => new Date("2026-08-25T23:15:00.000Z"),
        isDisabled: () => false,
        logger: quietLogger,
      })();
      const events = await prisma.domainEventOutbox.findMany({
        where: { eventType: { in: ["UNCLAIMED_REWARD_REMINDER_V1", "STEP_MILESTONE_REMINDER_V1"] } },
      });
      assert.deepEqual(events.map((row) => row.eventType).sort(), [
        "STEP_MILESTONE_REMINDER_V1",
        "UNCLAIMED_REWARD_REMINDER_V1",
      ]);
      await buildDomainEventProjectionJob({
        logger: quietLogger,
        now: () => new Date("2026-08-25T23:15:00.000Z"),
      })();
      assert.equal(await prisma.inboxAlert.count({ where: { userId: user.user.id } }), 2);
    } finally {
      if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousRedisUrl;
    }
  });

  it("projects eligible and deleted-recipient outcomes from the real daily-mover job", async () => {
    const racers = await Promise.all(
      Array.from({ length: 6 }, (_, index) => createTestUser({ displayName: `Mover ${index}` })),
    );
    const current = new Date("2026-08-25T21:15:00.000Z");
    const race = await prisma.race.create({
      data: {
        creatorId: racers[0].user.id,
        name: "Daily mover producer coverage",
        status: "ACTIVE",
        targetSteps: 50_000,
        timeBased: true,
        startedAt: new Date(current.getTime() - 3 * 60 * 60_000),
        endsAt: new Date(current.getTime() + 3 * 60 * 60_000),
      },
    });
    await prisma.raceParticipant.createMany({
      data: racers.map((racer, index) => ({
        raceId: race.id,
        userId: racer.user.id,
        status: "ACCEPTED",
        totalSteps: 6_000 - index * 1_000,
        dayStartPlacement: index < 2 ? 6 : index + 1,
      })),
    });
    const emitted = await buildDailyMover({
      now: () => current,
      logger: quietLogger,
    })();
    assert.equal(emitted.length, 2);
    assert.deepEqual(
      (await prisma.raceParticipant.findMany({
        where: { raceId: race.id },
        orderBy: { totalSteps: "desc" },
        select: { dayStartPlacement: true },
      })).map((participant) => participant.dayStartPlacement),
      [1, 2, 3, 4, 5, 6],
      "the durable job resets all baselines through the real database path",
    );
    assert.equal(
      (await prisma.jobRun.findUnique({ where: { jobName: "daily_mover" } })).lastRanFor,
      "2026-08-25",
    );
    assert.equal(await prisma.domainEventOutbox.count({ where: { eventType: "DAILY_MOVER_V1" } }), 2);
    const removed = await request(server.baseUrl, "DELETE", "/auth/account", {
      token: racers[1].token,
    });
    assert.equal(removed.status, 204);

    const project = buildDomainEventProjectionJob({
      logger: quietLogger,
      now: () => current,
    });
    await project();
    const projections = await prisma.domainEventNotificationProjection.findMany({
      where: { event: { eventType: "DAILY_MOVER_V1" } },
    });
    assert.deepEqual(projections.map((row) => row.status).sort(), ["COMPLETED", "SUPPRESSED"]);
    assert.equal(
      projections.find((row) => row.recipientUserId === racers[1].user.id).lastErrorCode,
      "RECIPIENT_DELETED",
    );
    assert.equal(await prisma.inboxAlert.count({ where: { type: "DAILY_MOVER" } }), 1);
  });

  it("replays partially appended reminder fan-outs with immutable occurrence facts", async () => {
    const first = await createTestUser({ timezone: "America/New_York" });
    const second = await createTestUser({ timezone: "America/New_York" });
    const users = [first.user, second.user];

    async function exercise({ build, eventType, firstNow, retryNow, userMethod }) {
      let currentTime = firstNow;
      let completedDay = null;
      let failSecondOnce = true;
      const User = {
        async distinctTimezones() { return ["America/New_York"]; },
        async [userMethod]() {
          return users.map((user) => ({
            id: user.id,
            lastDailyClaimDate: null,
          }));
        },
      };
      const JobRun = {
        async lastRanFor() { return completedDay; },
        async markRan(_name, day) { completedDay = day; },
      };
      const appendWithCrash = async (tx, event) => {
        if (event.aggregateId === second.user.id && failSecondOnce) {
          failSecondOnce = false;
          throw new Error("simulated midway crash");
        }
        return appendDomainEvent(tx, event);
      };
      const run = build({
        User,
        JobRun,
        now: () => currentTime,
        isDisabled: () => false,
        appendDomainEvent: appendWithCrash,
        logger: quietLogger,
      });

      await run();
      const firstStored = await prisma.domainEventOutbox.findFirstOrThrow({
        where: { eventType, aggregateId: first.user.id },
        include: { audience: true },
      });
      currentTime = retryNow;
      await run();

      assert.equal(completedDay, "2026-08-25", "the retried fan-out reaches its completion marker");
      assert.equal(await prisma.domainEventOutbox.count({ where: { eventType } }), 2);
      const replayed = await prisma.domainEventOutbox.findUniqueOrThrow({
        where: { id: firstStored.id },
        include: { audience: true },
      });
      assert.equal(replayed.occurredAt.toISOString(), firstStored.occurredAt.toISOString());
      assert.equal(replayed.availableAt.toISOString(), firstStored.availableAt.toISOString());
      assert.deepEqual(replayed.audience[0].facts, firstStored.audience[0].facts);
    }

    await exercise({
      build: buildDailyRewardReminder,
      eventType: "UNCLAIMED_REWARD_REMINDER_V1",
      firstNow: new Date("2026-08-25T21:15:00.000Z"),
      retryNow: new Date("2026-08-25T21:20:00.000Z"),
      userMethod: "findRemindableInZones",
    });
    await exercise({
      build: buildStepMilestoneReminder,
      eventType: "STEP_MILESTONE_REMINDER_V1",
      firstNow: new Date("2026-08-25T23:15:00.000Z"),
      retryNow: new Date("2026-08-25T23:20:00.000Z"),
      userMethod: "findStepMilestoneRemindable",
    });
  });

  it("projects missing-copy mystery-box reminders with race fallback copy and destination", async () => {
    const recipient = await createTestUser({ displayName: "Mystery Reminder Recipient" });
    const creator = await createTestUser({ displayName: "Mystery Reminder Creator" });
    const race = await prisma.race.create({
      data: {
        name: "Reminder Race",
        creatorId: creator.user.id,
        targetSteps: 10_000,
        maxDurationDays: 1,
        status: "ACTIVE",
        startedAt: new Date(),
        endsAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    const occurredAt = new Date();
    await appendDomainEvent(prisma, {
      eventKey: `UNCLAIMED_REWARD_REMINDER_V1:mystery-fallback:${recipient.user.id}`,
      eventType: "UNCLAIMED_REWARD_REMINDER_V1",
      schemaVersion: 1,
      aggregateType: "USER",
      aggregateId: recipient.user.id,
      occurredAt,
      payload: {
        userId: recipient.user.id,
        localDate: "2026-08-25",
        rewardType: "MYSTERY_BOX",
        raceId: race.id,
      },
      audience: [{ recipientId: recipient.user.id, facts: {} }],
    });

    const project = buildDomainEventProjectionJob({ logger: quietLogger });
    await project();
    const alert = await prisma.inboxAlert.findFirstOrThrow({
      where: { userId: recipient.user.id, type: "UNCLAIMED_REWARD" },
      include: { outbox: true },
    });
    assert.equal(alert.title, "Your mystery box is waiting");
    assert.equal(alert.body, "Open it before your race ends.");
    assert.deepEqual(alert.destination, { route: "raceDetail", raceId: race.id });
    assert.equal(alert.outbox.length, 1);
    assert.deepEqual(alert.outbox[0].payload, {
      title: "Your mystery box is waiting",
      body: "Open it before your race ends.",
      payload: {
        type: "UNCLAIMED_REWARD",
        rewardType: "MYSTERY_BOX",
        destination: "RACE",
        raceId: race.id,
        route: "race_detail",
        params: { raceId: race.id },
      },
      destination: { route: "raceDetail", raceId: race.id },
    });
  });

  it("keeps event availability immutable on retry and atomically replays failed children", async () => {
    const originalAvailableAt = new Date("2026-08-25T12:00:00.000Z");
    const retryAt = new Date("2026-08-25T12:05:00.000Z");
    const event = await prisma.domainEventOutbox.create({
      data: {
        eventKey: "FRIEND_REQUEST_SENT_V1:operator-replay-parent",
        eventType: "FRIEND_REQUEST_SENT_V1",
        schemaVersion: 1,
        aggregateType: "FRIENDSHIP",
        aggregateId: "operator-replay-parent",
        payload: { requesterId: "requester", addresseeId: "recipient" },
        occurredAt: originalAvailableAt,
        availableAt: originalAvailableAt,
        status: "EXPANDING",
        leaseToken: "00000000-0000-4000-8000-000000000111",
        leaseUntil: new Date("2026-08-25T12:01:00.000Z"),
      },
    });
    await domainEventRepository.failEvent(prisma, {
      id: event.id,
      leaseToken: "00000000-0000-4000-8000-000000000111",
      status: "RETRY",
      errorCode: "TRANSIENT",
      retryAt,
      now: new Date("2026-08-25T12:00:30.000Z"),
      incrementAttempt: true,
    });
    const retrying = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { id: event.id } });
    assert.equal(retrying.availableAt.toISOString(), originalAvailableAt.toISOString());
    assert.equal(retrying.leaseUntil.toISOString(), retryAt.toISOString());
    assert.equal(
      (await domainEventRepository.claimEvents({
        prisma,
        now: new Date(retryAt.getTime() - 1),
        batchSize: 25,
      })).length,
      0,
      "RETRY work remains ineligible until its mutable retry deadline",
    );
    assert.equal(
      (await domainEventRepository.nextDueAt(prisma)).toISOString(),
      retryAt.toISOString(),
      "the exact due timer follows RETRY.lease_until, not immutable available_at",
    );
    const [dueRetry] = await domainEventRepository.claimEvents({
      prisma,
      now: retryAt,
      batchSize: 25,
    });
    assert.equal(dueRetry.id, event.id);
    await prisma.domainEventOutbox.update({
      where: { id: event.id },
      data: {
        status: "RETRY",
        leaseToken: null,
        leaseUntil: retryAt,
      },
    });

    const child = await prisma.domainEventNotificationProjection.create({
      data: {
        domainEventId: event.id,
        recipientUserId: "deleted-recipient",
        deliveryKey: "operator-replay-child",
        projectionKind: "VISIBLE",
        status: "FAILED_TERMINAL",
        attemptCount: 5,
        availableAt: originalAvailableAt,
        completedAt: retryAt,
        lastErrorCode: "POISON",
      },
    });
    await prisma.domainEventOutbox.update({
      where: { id: event.id },
      data: {
        status: "FAILED_TERMINAL",
        expansionCompletedAt: originalAvailableAt,
        completedAt: retryAt,
        lastErrorCode: "CHILD_FAILED",
      },
    });
    const replayed = await domainEventRepository.replayTerminal(prisma, {
      eventIds: [event.id],
      projectionIds: [],
      now: retryAt,
    });
    assert.deepEqual(replayed, { events: 1, projections: 1 });
    const [replayedEvent, replayedChild] = await Promise.all([
      prisma.domainEventOutbox.findUniqueOrThrow({ where: { id: event.id } }),
      prisma.domainEventNotificationProjection.findUniqueOrThrow({ where: { id: child.id } }),
    ]);
    assert.equal(replayedEvent.status, "PROJECTING");
    assert.equal(replayedEvent.availableAt.toISOString(), originalAvailableAt.toISOString());
    assert.equal(replayedChild.status, "PENDING");
    assert.equal(replayedChild.attemptCount, 0);
    assert.equal(replayedChild.completedAt, null);
  });

  it("operator replay resumes incomplete expansion for event and projection targets", async () => {
    const occurredAt = new Date("2026-08-25T12:00:00.000Z");
    const replayAt = new Date("2026-08-25T12:05:00.000Z");
    const replay = buildReplayDomainEvent({
      prisma,
      now: () => replayAt,
    });

    async function createIncompleteFailure(suffix) {
      const event = await prisma.domainEventOutbox.create({
        data: {
          eventKey: `FRIEND_REQUEST_SENT_V1:incomplete-replay-${suffix}`,
          eventType: "FRIEND_REQUEST_SENT_V1",
          schemaVersion: 1,
          aggregateType: "FRIENDSHIP",
          aggregateId: `incomplete-replay-${suffix}`,
          payload: { requesterId: "requester", addresseeId: "recipient" },
          occurredAt,
          availableAt: occurredAt,
          status: "FAILED_TERMINAL",
          expansionCursor: "00000001",
          expansionCompletedAt: null,
          attemptCount: 5,
          completedAt: replayAt,
          lastErrorCode: "EXPANSION_POISON",
        },
      });
      const child = await prisma.domainEventNotificationProjection.create({
        data: {
          domainEventId: event.id,
          recipientUserId: `deleted-${suffix}`,
          deliveryKey: `incomplete-replay-child-${suffix}`,
          projectionKind: "VISIBLE",
          status: "FAILED_TERMINAL",
          attemptCount: 5,
          availableAt: occurredAt,
          completedAt: replayAt,
          lastErrorCode: "PROJECTION_POISON",
        },
      });
      return { event, child };
    }

    const byEvent = await createIncompleteFailure("event");
    assert.deepEqual(await replay({ eventIds: [byEvent.event.id], projectionIds: [] }), {
      events: 1,
      projections: 1,
    });
    assert.equal((await prisma.domainEventOutbox.findUniqueOrThrow({
      where: { id: byEvent.event.id },
    })).status, "PENDING", "--event must return unfinished expansion to the parent queue");

    const byProjection = await createIncompleteFailure("projection");
    assert.deepEqual(await replay({ eventIds: [], projectionIds: [byProjection.child.id] }), {
      events: 0,
      projections: 1,
    });
    assert.equal((await prisma.domainEventOutbox.findUniqueOrThrow({
      where: { id: byProjection.event.id },
    })).status, "PENDING", "--projection must also resume its unfinished parent expansion");
  });

  it("retention waits for downstream delivery, survives account deletion, and cascades only terminal coordination rows", async () => {
    const requester = await createTestUser({ displayName: "Retention Requester" });
    const addressee = await createTestUser({ displayName: "Retention Addressee" });
    const response = await request(server.baseUrl, "POST", "/friends/request", {
      token: requester.token,
      body: { addresseeId: addressee.user.id },
    });
    assert.equal(response.status, 201);
    const friendship = (await response.json()).friendship;
    const project = buildDomainEventProjectionJob({ logger: quietLogger });
    await project();

    const oldCompletion = new Date("2099-01-01T00:00:00.000Z");
    const retentionNow = new Date("2099-02-15T03:00:00.000Z");
    const event = await prisma.domainEventOutbox.update({
      where: { eventKey: `FRIEND_REQUEST_SENT_V1:${friendship.id}` },
      data: { completedAt: oldCompletion },
      include: { audience: true, projections: true },
    });
    assert.equal(event.audience.length, 1);
    assert.equal(event.projections.length, 1);

    const JobRun = {
      async lastRanFor() { return null; },
      async claimRun() { return true; },
    };
    const retain = buildDomainEventRetention({
      JobRun,
      now: () => retentionNow,
      logger: quietLogger,
    });
    assert.deepEqual(await retain(), { deleted: 0 }, "pending push outbox protects its source event");

    await prisma.friendship.delete({ where: { id: friendship.id } });
    await prisma.user.delete({ where: { id: addressee.user.id } });
    assert.ok(
      await prisma.domainEventOutbox.findUnique({ where: { id: event.id } }),
      "recipient deletion cannot cascade into coordination history",
    );
    assert.deepEqual(await retain(), { deleted: 1 });
    assert.equal(await prisma.domainEventOutbox.count({ where: { id: event.id } }), 0);
    assert.equal(await prisma.domainEventAudience.count({ where: { domainEventId: event.id } }), 0);
    assert.equal(await prisma.domainEventNotificationProjection.count({ where: { domainEventId: event.id } }), 0);
    assert.deepEqual(await retain(), { deleted: 0 }, "cleanup replay is idempotent");
  });
});
