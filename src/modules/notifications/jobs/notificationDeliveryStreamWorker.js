const {
  parseNotificationDelivery,
} = require("../../../shared/queues/workMessages");
const RECLAIM_IDLE_MS = 30_000;
const READ_COUNT = 100;
const PREFETCH_MAX_AGE_MS = 5000;
const CONCURRENCY = 10;
const DELIVERY_LEASE_MS = 30_000;

function buildNotificationDeliveryStreamWorker(dependencies = {}) {
  const prisma = dependencies.prisma || require("../../../db").prisma;
  const DeviceToken = dependencies.DeviceToken || require("../../../shared/push/deviceToken").DeviceToken;
  const apns = dependencies.apnsService || require("../../../shared/push/apns").apnsService;
  const fcm = dependencies.fcmService || require("../../../shared/push/fcm").fcmService;
  const createInboxAlert = dependencies.createInboxAlert || require("../../inbox/services/inbox").createInboxAlert;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;

  const queue = dependencies.queue || require("../../../shared/queues/redisStreams");
  const { STREAMS, GROUPS, ack, consumerName } = queue;
  const concurrency = Math.max(1, Number(dependencies.concurrency) || CONCURRENCY);

  function eligible(message, entitlement) {
    return entitlement && entitlement.userId === message.recipientUserId &&
      Number(entitlement.scheduleRevision || 0) === message.sourceRevision &&
      entitlement.startProcessedAt &&
      ["ACTIVATED_ON_TIME", "ACTIVATED_LATE_JOIN"].includes(entitlement.startOutcome) &&
      new Date(entitlement.endsAt) > new Date(now()) &&
      new Date(message.expiresAt) > new Date(now());
  }

  async function prefetchBatch(entries) {
    const preparedAt = new Date(now()).getTime();
    const messages = entries.flatMap((entry) => {
      try {
        const message = parseNotificationDelivery(entry.fields);
        return message.type === "GLOBAL_EVENT_STARTED" &&
          message.sourceType === "GLOBAL_STEP_EVENT_ENTITLEMENT" ? [message] : [];
      } catch { return []; } // processEntry retains the existing invalid-message handling.
    });
    const entitlements = new Map();
    const impactKeys = new Set();
    const tokensByUser = new Map();
    if (!messages.length) return { preparedAt, entitlements, impactKeys, tokensByUser };
    const rows = await prisma.globalStepEventEntitlement.findMany({
      where: { id: { in: [...new Set(messages.map((message) => message.sourceId))] } },
      include: { event: true },
    });
    for (const row of rows) entitlements.set(row.id, row);
    const sources = new Map();
    for (const message of messages) {
      const row = entitlements.get(message.sourceId);
      if (eligible(message, row)) sources.set(`${row.eventId}:${row.userId}`, { eventId: row.eventId, userId: row.userId });
    }
    if (sources.size) {
      // One row per eligible event/user, not one row per race membership.
      const impacts = await prisma.globalEventRaceImpact.groupBy({
        by: ["eventId", "userId"], where: { OR: [...sources.values()] },
      });
      for (const row of impacts) impactKeys.add(`${row.eventId}:${row.userId}`);
      const userIds = [...new Set(impacts.map((row) => row.userId))];
      if (userIds.length) {
        const tokens = await DeviceToken.findForDeliveryByUserIds(userIds);
        for (const token of tokens) {
          if (!tokensByUser.has(token.userId)) tokensByUser.set(token.userId, []);
          tokensByUser.get(token.userId).push(token);
        }
      }
    }
    return { preparedAt, entitlements, impactKeys, tokensByUser };
  }

  async function loadGlobalEventIntent(message, prefetch = null) {
    if (message.type !== "GLOBAL_EVENT_STARTED" ||
        message.sourceType !== "GLOBAL_STEP_EVENT_ENTITLEMENT") {
      const error = new Error("unsupported notification stream source");
      error.code = "UNSUPPORTED_NOTIFICATION_STREAM_SOURCE";
      error.nonRetryable = true;
      throw error;
    }
    const entitlement = prefetch ? prefetch.entitlements.get(message.sourceId) : await prisma.globalStepEventEntitlement.findUnique({
      where: { id: message.sourceId },
      include: { event: true },
    });
    if (!eligible(message, entitlement)) return null;
    const impact = prefetch ? prefetch.impactKeys.has(`${entitlement.eventId}:${entitlement.userId}`)
      : await prisma.globalEventRaceImpact.findFirst({
          where: { eventId: entitlement.eventId, userId: entitlement.userId },
          select: { id: true },
        });
    if (!impact) return null;

    const multiplier = Number(entitlement.event?.multiplier || 2);
    return {
      entitlement,
      title: `${multiplier}x STEPS EVENT`,
      body: `Double steps are LIVE for 30 minutes. Every step counts ${multiplier}x in your races! Go!`,
      destination: { route: "home" },
      payload: {
        type: "GLOBAL_EVENT_STARTED",
        route: "home",
        eventId: entitlement.eventId,
        entitlementId: entitlement.id,
        multiplier,
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

  async function deliver(message, prefetch = null) {
    // Batch-local reuse only. Slow batches and retries must read fresh decisions.
    if (prefetch && new Date(now()).getTime() - prefetch.preparedAt >= PREFETCH_MAX_AGE_MS) prefetch = null;
    const intent = await loadGlobalEventIntent(message, prefetch);
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

    const tokens = prefetch ? (prefetch.tokensByUser.get(message.recipientUserId) || [])
      : await DeviceToken.findByUserId(message.recipientUserId);
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
    let expired = false;
    for (const token of tokens) {
      if (new Date(message.expiresAt) <= new Date(now()) || new Date(intent.entitlement.endsAt) <= new Date(now())) {
        expired = true;
        break;
      }
      const provider = token.platform === "android" ? fcm : apns;
      const result = await provider.sendNotification({
        deviceToken: token.token,
        title: intent.title,
        body: intent.body,
        payload: intent.payload,
        expiresAt: new Date(message.expiresAt),
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

    if (expired) {
      await prisma.inboxDeliveryOutbox.update({
        where: { id: claim.outbox.id },
        data: { status: "EXPIRED", leaseUntil: null, leaseToken: null, retryAt: null },
      });
      return { terminal: true, sent: 0 };
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

  async function processEntry(entry, prefetch = null) {
    try {
      const message = parseNotificationDelivery(entry.fields);
      const result = await deliver(message, prefetch);
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

  async function processEntries(entries, { shouldStop = () => false } = {}) {
    let completed = 0;
    for (let offset = 0; offset < entries.length && !shouldStop(); offset += READ_COUNT) {
      const batch = entries.slice(offset, offset + READ_COUNT);
      const prefetch = await prefetchBatch(batch);
      let cursor = 0;
      async function consume() {
        while (!shouldStop()) {
          const index = cursor++;
          if (index >= batch.length) return;
          if (await processEntry(batch[index], prefetch)) completed += 1;
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, consume));
    }
    return completed;
  }

  return { processEntries, processEntry, deliver };
}

function scheduleNotificationDeliveryStreamWorker(dependencies = {}) {
  const { STREAMS, GROUPS, ensureGroup, reclaimIdle, readGroup, consumerName } =
    dependencies.queue || require("../../../shared/queues/redisStreams");
  const worker = dependencies.worker || buildNotificationDeliveryStreamWorker(dependencies);
  const logger = dependencies.logger || console;
  const consumer = dependencies.consumer || consumerName("notification-delivery");
  const concurrency = Math.max(1, Number(dependencies.concurrency) || CONCURRENCY);
  let stopped = false;
  let running;

  async function processBatch(entries) {
    if (worker.processEntries) return worker.processEntries(entries, { shouldStop: () => stopped });
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
          count: READ_COUNT,
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
