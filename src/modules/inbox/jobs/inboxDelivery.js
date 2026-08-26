const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");
const { DeviceToken: defaultDeviceToken } = require("../../../shared/push/deviceToken");
const { apnsService: defaultApns } = require("../../../shared/push/apns");
const { fcmService: defaultFcm } = require("../../../shared/push/fcm");
const { appSettings: defaultSettings } = require("../../../shared/config/appSettings");
const { canonicalPushDeliveryKey } = require("../../notifications/pushDeliveryAttribution");
const { notificationIntentService: defaultNotificationIntentService } = require("../../notifications/services/notificationDelivery");
const redisCache = require("../../../shared/cache/redisCache");
const { userFanoutDisabled: defaultUserFanoutDisabled } = require("../../../shared/config/operationalControls");

const LEASE_MS = 30_000;
const TICK_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_CONCURRENCY = 16;
const DEFAULT_PROVIDER_TIMEOUT_MS = 5_000;

function retryAt(now, attempts) {
  return new Date(now.getTime() + Math.min(60 * 60_000, 1_000 * 2 ** Math.min(attempts, 10)));
}

function pushPayload(alert, storedPayload = null) {
  if (storedPayload && typeof storedPayload === "object" && !Array.isArray(storedPayload)) {
    return storedPayload;
  }
  const destination = alert.destination || {};
  if (alert.type === "PRIVATE_RACE_JOIN_APPROVAL" &&
      destination.route === "raceJoinRequest") {
    return {
      type: alert.type,
      destination: "RACE_JOIN_REQUEST",
      raceId: destination.raceId,
      requestId: destination.requestId,
      destinationDetails: destination,
      route: "race_join_request",
      params: {
        raceId: destination.raceId,
        requestId: destination.requestId,
      },
    };
  }
  if (alert.type === "PRIVATE_RACE_JOIN_RESULT" &&
      destination.route === "raceDetail") {
    return {
      type: alert.type,
      destination: "RACE",
      raceId: destination.raceId,
      requestId: destination.requestId,
      status: destination.status,
      destinationDetails: destination,
      route: "race_detail",
      params: {
        raceId: destination.raceId,
        ...(destination.requestId ? { requestId: destination.requestId } : {}),
        ...(destination.status ? { status: destination.status } : {}),
      },
    };
  }
  const payload = { type: alert.type, destination };
  if (destination.route === "raceDetail") {
    payload.route = "race_detail";
    payload.params = {
      raceId: destination.raceId,
      ...(destination.requestId ? { requestId: destination.requestId } : {}),
      ...(destination.status ? { status: destination.status } : {}),
    };
  } else if (destination.route === "raceJoinRequest") {
    payload.route = "race_join_request";
    payload.params = {
      raceId: destination.raceId,
      requestId: destination.requestId,
    };
  } else if (destination.route === "tournamentDetail") {
    payload.route = "tournament_detail";
    payload.params = { tournamentId: destination.tournamentId };
  } else if (destination.route === "friends") payload.route = "friends";
  else if (destination.route === "dailyReward") payload.route = "daily_reward";
  else if (destination.route === "supportThread") {
    payload.route = "support_thread";
    payload.params = { threadId: destination.threadId };
  } else payload.route = "home";
  return payload;
}

function tokenFingerprint(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

async function withTimeout(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("notification provider timeout");
          error.code = "PROVIDER_TIMEOUT";
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency(values, limit, worker) {
  const results = new Array(values.length);
  let cursor = 0;
  async function consume() {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, consume));
  return results;
}

function buildInboxDelivery(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const deviceTokens = dependencies.DeviceToken || defaultDeviceToken;
  const apns = dependencies.apnsService || defaultApns;
  const fcm = dependencies.fcmService || defaultFcm;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const batchSize = Math.max(1, Number(dependencies.batchSize) || DEFAULT_BATCH_SIZE);
  const concurrency = Math.max(1, Math.min(DEFAULT_CONCURRENCY, Number(dependencies.concurrency) || DEFAULT_CONCURRENCY));
  const providerTimeoutMs = Math.max(1, Number(dependencies.providerTimeoutMs) || DEFAULT_PROVIDER_TIMEOUT_MS);
  const settings = dependencies.appSettings || defaultSettings;
  const userFanoutDisabled = dependencies.userFanoutDisabled || defaultUserFanoutDisabled;

  async function renewLease(rowId, leaseToken, leaseUntil) {
    const renewed = await prisma.inboxDeliveryOutbox.updateMany({
      where: { id: rowId, status: "LEASED", leaseToken },
      data: { leaseUntil },
    });
    return renewed.count === 1;
  }

  async function deliverRow(row, leaseToken, current) {
    let leaseLost = false;
    const renewal = setInterval(async () => {
      try {
        const renewed = await renewLease(row.id, leaseToken, new Date(now().getTime() + LEASE_MS));
        if (!renewed) leaseLost = true;
      } catch (error) {
        logger.error("inbox delivery lease renewal failed", { outboxId: row.id, error: error?.message || String(error) });
      }
    }, Math.max(1_000, Math.floor(LEASE_MS / 3)));
    renewal.unref?.();

    try {
      const tokens = await deviceTokens.findByUserId(row.alert.userId);
      const accepted = new Set(Array.isArray(row.acceptedTokens) ? row.acceptedTokens : []);
      const payload = pushPayload(row.alert, row.payload?.payload);
      let transientFailure = false;
      let providerAccepted = false;

      if (!tokens || tokens.length === 0) {
        if (prisma.inboxDeliveryDeviceAttempt) {
          await prisma.inboxDeliveryDeviceAttempt.upsert({
            where: { outboxId_tokenHash: { outboxId: row.id, tokenHash: "__NO_DEVICE__" } },
            update: { disposition: "NO_DEVICE", attemptCount: { increment: 1 } },
            create: { outboxId: row.id, tokenHash: "__NO_DEVICE__", disposition: "NO_DEVICE", attemptCount: 1 },
          });
        }
      }

      let attribution = null;
      let deliveryEpochId = null;
      if ((await settings.getFlag("adminMetricsV2TelemetryEnabled")) === true) {
        const epoch = await prisma.adminMetricsCollectionEpoch.findFirst({ where: { endedAt: null }, orderBy: { startedAt: "desc" } });
        const user = await prisma.user.findUnique({ where: { id: row.alert.userId } });
        if (epoch && user && user.isReviewAccount !== true && tokens.some((token) =>
          token.platform === "ios" && token.adminMetricsOpenCapable === true && token.adminMetricsOpenEpochId === epoch.id)) {
          const deliveryKey = row.alert.sourceKey?.startsWith("visible:")
            ? row.alert.sourceKey
            : canonicalPushDeliveryKey(row.alert.type, row.alert.userId, row.alert.sourceKey || row.id);
          const delivery = await prisma.pushDelivery.upsert({
            where: { deliveryKey }, update: {},
            create: { publicId: crypto.randomUUID(), deliveryKey, userId: row.alert.userId, notificationType: row.alert.type, openCapable: false },
          });
          deliveryEpochId = epoch.id;
          attribution = { delivery, payload: { ...payload, notificationId: delivery.publicId }, epochId: epoch.id };
        }
      }
      const sendPayload = attribution?.payload || payload;

      const outcomes = await mapWithConcurrency(tokens || [], concurrency, async (token) => {
        const fingerprint = tokenFingerprint(token.token);
        if (accepted.has(fingerprint)) return { accepted: true, skipped: true };
        const record = async (disposition, lastErrorCode = null) => {
          if (!prisma.inboxDeliveryDeviceAttempt) return null;
          return prisma.inboxDeliveryDeviceAttempt.upsert({
            where: { outboxId_tokenHash: { outboxId: row.id, tokenHash: fingerprint } },
            update: {
              disposition,
              attemptCount: { increment: 1 },
              lastErrorCode,
              acceptedAt: disposition === "ACCEPTED" ? now() : undefined,
            },
            create: {
              outboxId: row.id,
              tokenHash: fingerprint,
              disposition,
              lastErrorCode,
              acceptedAt: disposition === "ACCEPTED" ? now() : null,
            },
          });
        };
        try {
          const provider = token.platform === "android" ? fcm : apns;
          const result = await withTimeout(() => provider.sendNotification({
            deviceToken: token.token,
            title: row.payload.title,
            body: row.payload.body,
            payload: sendPayload,
            ...(sendPayload.collapseId ? { collapseId: sendPayload.collapseId } : {}),
            ...(sendPayload.threadId ? { threadId: sendPayload.threadId } : {}),
          }), providerTimeoutMs);
          if (result?.success) {
            accepted.add(fingerprint);
            providerAccepted = true;
            await record("ACCEPTED");
            if (attribution?.delivery && token.platform === "ios" && token.adminMetricsOpenCapable === true && token.adminMetricsOpenEpochId === deliveryEpochId) {
              await prisma.pushDelivery.updateMany({ where: { id: attribution.delivery.id, providerAcceptedAt: null }, data: { openCapable: true, providerAcceptedAt: now() } });
            }
            return { accepted: true };
          }
          if (result?.unregistered) {
            await deviceTokens.deleteToken({ userId: row.alert.userId, token: token.token });
            await record("UNREGISTERED");
            return { unregistered: true, terminal: true };
          }
          const permanent = result?.permanent === true || Number(result?.statusCode) >= 400 && Number(result?.statusCode) < 500;
          const attempt = await record(permanent ? "PERMANENT_FAIL" : "TRANSIENT_FAIL", result?.reason || null);
          const exhausted = !permanent && attempt && attempt.attemptCount >= 8;
          if (exhausted) await record("EXHAUSTED", result?.reason || "RETRY_EXHAUSTED");
          return { failed: !permanent && !exhausted, terminal: permanent || exhausted };
        } catch (error) {
          const attempt = await record(error?.code === "PROVIDER_TIMEOUT" ? "TIMEOUT" : "TRANSIENT_FAIL", error?.code || null);
          const exhausted = attempt && attempt.attemptCount >= 8;
          if (exhausted) await record("EXHAUSTED", error?.code || "RETRY_EXHAUSTED");
          return { failed: !exhausted, error };
        }
      });
      transientFailure = outcomes.some((outcome) => outcome?.failed);

      if (providerAccepted) {
        const acceptedUpdate = await prisma.inboxDeliveryOutbox.updateMany({
          where: { id: row.id, status: "LEASED", leaseToken },
          data: { providerAcceptedAt: row.providerAcceptedAt || now(), acceptedTokens: [...accepted] },
        });
        if (acceptedUpdate.count !== 1) leaseLost = true;
      }
      if (leaseLost) return { state: "LOST_LEASE" };
      if (transientFailure) {
        const error = new Error("At least one inbox push delivery failed");
        error.code = outcomes.find((outcome) => outcome?.error)?.error?.code || "PROVIDER_REJECTED";
        throw error;
      }
      const completed = await prisma.inboxDeliveryOutbox.updateMany({
        where: { id: row.id, status: "LEASED", leaseToken },
        data: { status: "DELIVERED", deliveredAt: now(), leaseUntil: null, leaseToken: null },
      });
      return completed.count === 1 ? { state: "DELIVERED" } : { state: "LOST_LEASE" };
    } finally {
      clearInterval(renewal);
    }
  }

  return async function deliverInbox() {
    if (userFanoutDisabled("INBOX_DELIVERY_DISABLED")) return null;
    const current = now();
    const candidates = await prisma.inboxDeliveryOutbox.findMany({
      where: {
        OR: [
          { status: { in: ["PENDING", "RETRY"] }, availableAt: { lte: current } },
          { status: "LEASED", leaseUntil: { lte: current } },
        ],
      },
      orderBy: { availableAt: "asc" },
      take: batchSize,
      include: { alert: { select: { userId: true, type: true, destination: true, sourceKey: true } } },
    });
    let delivered = 0;
    let claimed = 0;
    await mapWithConcurrency(candidates, concurrency, async (row) => {
      const leaseToken = crypto.randomUUID();
      const leased = await prisma.inboxDeliveryOutbox.updateMany({
        where: {
          id: row.id,
          OR: [
            { status: { in: ["PENDING", "RETRY"] }, availableAt: { lte: current } },
            { status: "LEASED", leaseUntil: { lte: current } },
          ],
        },
        data: { status: "LEASED", claimedAt: row.claimedAt || current, leaseUntil: new Date(current.getTime() + LEASE_MS), leaseToken },
      });
      if (leased.count !== 1) return;
      claimed += 1;
      try {
        const result = await deliverRow({ ...row, leaseToken }, leaseToken, current);
        if (result.state === "DELIVERED") delivered += 1;
        if (result.state === "LOST_LEASE") return;
      } catch (error) {
        const attempts = row.attemptCount + 1;
        const nextRetry = retryAt(current, attempts);
        await prisma.inboxDeliveryOutbox.updateMany({
          where: { id: row.id, status: "LEASED", leaseToken },
          data: { status: attempts >= 8 ? "EXHAUSTED" : "RETRY", attemptCount: attempts, leaseUntil: null, leaseToken: null, availableAt: nextRetry, retryAt: nextRetry, lastErrorCode: error?.code || "PROVIDER_REJECTED" },
        });
        logger.error("[CRON] inbox delivery failed", { outboxId: row.id, error: error?.message || String(error) });
      }
    });
    return { claimed, delivered };
  };
}

function scheduleInboxDelivery(dependencies = {}) {
  const run = buildInboxDelivery(dependencies);
  const releaseDue = dependencies.releaseDue ||
    (dependencies.notificationIntentService || defaultNotificationIntentService).releaseDue;
  const subscribeWakeup = dependencies.subscribeNotificationWakeup ||
    redisCache.subscribeNotificationWakeup;
  const nextDueAt = dependencies.nextDueAt ||
    (dependencies.notificationIntentService || defaultNotificationIntentService).nextDueAt;
  const logger = dependencies.logger || console;
  let running = null;
  let dueTimer = null;
  const tick = () => {
    if (running) return running;
    running = Promise.resolve()
      .then(() => releaseDue({ now: dependencies.now?.() }))
      .then(() => run())
      .then(async () => {
        if (typeof nextDueAt !== "function") return;
        const dueAt = await nextDueAt();
        if (!dueAt) return;
        const delay = Math.max(0, Math.min(60_000, new Date(dueAt).getTime() - Date.now()));
        if (dueTimer) clearTimeout(dueTimer);
        dueTimer = setTimeout(tick, delay);
        dueTimer.unref?.();
      })
      .catch((error) => logger.error("[CRON] inboxDelivery tick error:", error))
      .finally(() => { running = null; });
    return running;
  };
  tick();
  const interval = setInterval(tick, dependencies.intervalMs || TICK_INTERVAL_MS);
  interval.unref?.();
  Promise.resolve(subscribeWakeup(() => tick())).catch((error) => {
    logger.error("[CRON] notification wake subscription failed:", error);
  });
  logger.log("[CRON] Inbox delivery scheduled");
  return {
    tick,
    stop() {
      clearInterval(interval);
    },
  };
}

module.exports = {
  buildInboxDelivery,
  scheduleInboxDelivery,
  retryAt,
  pushPayload,
  mapWithConcurrency,
  LEASE_MS,
};
