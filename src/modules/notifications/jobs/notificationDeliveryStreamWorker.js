const { prisma: defaultPrisma } = require("../../../db");
const {
  STREAMS,
  GROUPS,
  ensureGroup,
  readGroup,
  reclaimIdle,
  ack,
  consumerName,
} = require("../../../shared/queues/redisStreams");
const {
  parseNotificationDelivery,
} = require("../../../shared/queues/workMessages");
const {
  createInboxAlert: defaultCreateInboxAlert,
} = require("../../inbox/services/inbox");
const {
  DeviceToken: defaultDeviceToken,
} = require("../../../shared/push/deviceToken");
const {
  apnsService: defaultApns,
} = require("../../../shared/push/apns");
const {
  fcmService: defaultFcm,
} = require("../../../shared/push/fcm");

const RECLAIM_IDLE_MS = 30_000;
const READ_COUNT = 25;
const CONCURRENCY = 10;
const DELIVERY_LEASE_MS = 30_000;

function buildNotificationDeliveryStreamWorker(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const DeviceToken = dependencies.DeviceToken || defaultDeviceToken;
  const apns = dependencies.apnsService || defaultApns;
  const fcm = dependencies.fcmService || defaultFcm;
  const createInboxAlert = dependencies.createInboxAlert || defaultCreateInboxAlert;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;

  async function loadGlobalEventIntent(message) {
    if (message.type !== "GLOBAL_EVENT_STARTED" ||
        message.sourceType !== "GLOBAL_STEP_EVENT_ENTITLEMENT") {
      const error = new Error("unsupported notification stream source");
      error.code = "UNSUPPORTED_NOTIFICATION_STREAM_SOURCE";
      error.nonRetryable = true;
      throw error;
    }
    const entitlement = await prisma.globalStepEventEntitlement.findUnique({
      where: { id: message.sourceId },
      include: { event: true },
    });
    if (!entitlement) return null;
    if (Number(entitlement.scheduleRevision || 0) !== message.sourceRevision) return null;
    const current = new Date(now());
    if (!entitlement.startProcessedAt ||
        !["ACTIVATED_ON_TIME", "ACTIVATED_LATE_JOIN"].includes(entitlement.startOutcome) ||
        new Date(entitlement.endsAt) <= current) {
      return null;
    }
    const impact = await prisma.globalEventRaceImpact.findFirst({
      where: { eventId: entitlement.eventId, userId: entitlement.userId },
      select: { id: true },
    });
    if (!impact) return null;

    const multiplier = Number(entitlement.event?.multiplier || 2);
    return {
      entitlement,
      title: `${multiplier}x STEPS EVENT`,
      body: `Your ${multiplier}x steps event is live now.`,
      destination: { route: "home" },
      payload: {
        type: "GLOBAL_EVENT_STARTED",
        route: "home",
        eventId: entitlement.eventId,
        entitlementId: entitlement.id,
        multiplier,
        endsAt: new Date(entitlement.endsAt).toISOString(),
        collapseId: `global_event_${String(entitlement.eventId).slice(0, 12)}`,
      },
    };
  }

  async function claimOutbox(alertId, current) {
    return prisma.$transaction(async (tx) => {
      const outbox = await tx.inboxDeliveryOutbox.findUnique({
        where: { alertId_kind: { alertId, kind: "PUSH" } },
      });
      if (!outbox) return null;
      if (["DELIVERED", "EXPIRED", "EXHAUSTED"].includes(outbox.status)) {
        return { terminal: true, outbox };
      }
      const claimed = await tx.inboxDeliveryOutbox.updateMany({
        where: {
          id: outbox.id,
          OR: [
            { status: "PENDING" },
            { status: "RETRY", OR: [{ retryAt: null }, { retryAt: { lte: current } }] },
            { status: "CLAIMED", leaseUntil: { lte: current } },
          ],
        },
        data: {
          status: "CLAIMED",
          claimedAt: current,
          leaseUntil: new Date(current.getTime() + DELIVERY_LEASE_MS),
          leaseToken: consumerName("notification-delivery-claim"),
          attemptCount: { increment: 1 },
        },
      });
      if (claimed.count !== 1) return { busy: true, outbox };
      return {
        claimed: true,
        outbox: await tx.inboxDeliveryOutbox.findUnique({ where: { id: outbox.id } }),
      };
    });
  }

  async function deliver(message) {
    const intent = await loadGlobalEventIntent(message);
    if (!intent) return { terminal: true, reason: "INELIGIBLE" };
    const current = new Date(now());

    const alert = await createInboxAlert({
      userId: message.recipientUserId,
      type: message.type,
      title: intent.title,
      body: intent.body,
      destination: intent.destination,
      sourceKey: message.deliveryKey,
      payload: intent.payload,
      now: current,
      expiresAt: new Date(message.expiresAt),
      prisma,
      // This worker owns provider delivery. Do not wake the legacy Inbox worker
      // for the same outbox row.
      publishWakeup: async () => {},
    });

    const claim = await claimOutbox(alert.id, current);
    if (!claim || claim.busy) return { terminal: false, reason: "BUSY" };
    if (claim.terminal) return { terminal: true, replay: true };

    const tokens = await DeviceToken.findByUserId(message.recipientUserId);
    if (!tokens.length) {
      await prisma.inboxDeliveryOutbox.update({
        where: { id: claim.outbox.id },
        data: {
          status: "EXHAUSTED",
          deliveredAt: current,
          leaseUntil: null,
          leaseToken: null,
          lastErrorCode: "NO_DEVICE_TOKEN",
        },
      });
      return { terminal: true, sent: 0 };
    }

    const accepted = [];
    let transientFailure = false;
    for (const token of tokens) {
      const provider = token.platform === "android" ? fcm : apns;
      const result = await provider.sendNotification({
        deviceToken: token.token,
        title: intent.title,
        body: intent.body,
        payload: intent.payload,
        expiresAt: new Date(message.expiresAt),
        collapseId: intent.payload.collapseId,
      });
      if (result?.success) {
        accepted.push(token.token);
      } else if (result?.unregistered || result?.invalidToken) {
        await DeviceToken.deleteToken({
          userId: message.recipientUserId,
          token: token.token,
        });
      } else {
        transientFailure = true;
      }
    }

    if (accepted.length) {
      await prisma.inboxDeliveryOutbox.update({
        where: { id: claim.outbox.id },
        data: {
          status: "DELIVERED",
          providerAcceptedAt: current,
          deliveredAt: current,
          acceptedTokens: accepted,
          leaseUntil: null,
          leaseToken: null,
          retryAt: null,
          lastErrorCode: null,
        },
      });
      return { terminal: true, sent: accepted.length };
    }

    if (transientFailure) {
      await prisma.inboxDeliveryOutbox.update({
        where: { id: claim.outbox.id },
        data: {
          status: "RETRY",
          retryAt: new Date(current.getTime() + 1000),
          leaseUntil: null,
          leaseToken: null,
          lastErrorCode: "PROVIDER_RETRY",
        },
      });
      return { terminal: false, sent: 0 };
    }

    await prisma.inboxDeliveryOutbox.update({
      where: { id: claim.outbox.id },
      data: {
        status: "EXHAUSTED",
        deliveredAt: current,
        leaseUntil: null,
        leaseToken: null,
        lastErrorCode: "PROVIDER_REJECTED",
      },
    });
    return { terminal: true, sent: 0 };
  }

  async function processEntry(entry) {
    try {
      const message = parseNotificationDelivery(entry.fields);
      const result = await deliver(message);
      if (result.terminal) {
        await ack(STREAMS.NOTIFICATION_DELIVERY, GROUPS.NOTIFICATION_DELIVERY, entry.id);
      }
      return result.terminal;
    } catch (error) {
      if (error?.nonRetryable) {
        await ack(STREAMS.NOTIFICATION_DELIVERY, GROUPS.NOTIFICATION_DELIVERY, entry.id);
        return false;
      }
      logger.error?.("[NOTIFICATION_STREAM] delivery failed", {
        messageId: entry.id,
        code: error?.code || error?.name || "NOTIFICATION_STREAM_ERROR",
      });
      return false;
    }
  }

  return { processEntry, deliver };
}

function scheduleNotificationDeliveryStreamWorker(dependencies = {}) {
  const worker = dependencies.worker || buildNotificationDeliveryStreamWorker(dependencies);
  const logger = dependencies.logger || console;
  const consumer = dependencies.consumer || consumerName("notification-delivery");
  const concurrency = Math.max(1, Number(dependencies.concurrency) || CONCURRENCY);
  let stopped = false;
  let running;

  async function processBatch(entries) {
    let cursor = 0;
    async function consume() {
      while (!stopped) {
        const index = cursor++;
        if (index >= entries.length) return;
        await worker.processEntry(entries[index]);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, entries.length) }, consume),
    );
  }

  async function loop() {
    await ensureGroup(STREAMS.NOTIFICATION_DELIVERY, GROUPS.NOTIFICATION_DELIVERY);
    while (!stopped) {
      try {
        const reclaimed = await reclaimIdle({
          stream: STREAMS.NOTIFICATION_DELIVERY,
          group: GROUPS.NOTIFICATION_DELIVERY,
          consumer,
          minIdleMs: RECLAIM_IDLE_MS,
          count: 50,
        });
        if (reclaimed.length) {
          await processBatch(reclaimed);
          continue;
        }
        const entries = await readGroup({
          stream: STREAMS.NOTIFICATION_DELIVERY,
          group: GROUPS.NOTIFICATION_DELIVERY,
          consumer,
          count: READ_COUNT,
          blockMs: 5000,
        });
        if (entries.length) await processBatch(entries);
      } catch (error) {
        logger.error?.("[NOTIFICATION_STREAM] worker loop failed", error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  running = loop();
  return {
    async stop() {
      stopped = true;
      await Promise.race([
        running,
        new Promise((resolve) => setTimeout(resolve, 6000)),
      ]);
    },
  };
}

module.exports = {
  buildNotificationDeliveryStreamWorker,
  scheduleNotificationDeliveryStreamWorker,
};
