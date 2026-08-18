const { prisma: defaultPrisma } = require("../../../db");
const { DeviceToken: defaultDeviceToken } = require("../../../shared/push/deviceToken");
const { apnsService: defaultApns } = require("../../../shared/push/apns");
const { fcmService: defaultFcm } = require("../../../shared/push/fcm");

const LEASE_MS = 30_000;
const TICK_INTERVAL_MS = 15_000;

function retryAt(now, attempts) {
  return new Date(now.getTime() + Math.min(60 * 60_000, 1_000 * 2 ** Math.min(attempts, 10)));
}

function pushPayload(alert) {
  const destination = alert.destination || {};
  const payload = { type: alert.type, destination };
  // Carry the established fields alongside the Inbox destination during the
  // mixed-version rollout. Frozen builds keep their existing notification
  // type/params deep link; carrying builds may use the stricter destination.
  if (destination.route === "raceDetail") {
    payload.route = "race_detail";
    payload.params = { raceId: destination.raceId };
  } else if (destination.route === "tournamentDetail") {
    payload.route = "tournament_detail";
    payload.params = { tournamentId: destination.tournamentId };
  } else if (destination.route === "friends") {
    payload.route = "friends";
  } else if (destination.route === "dailyReward") {
    payload.route = "daily_reward";
  } else if (destination.route === "supportThread") {
    payload.route = "support_thread";
    payload.params = { threadId: destination.threadId };
  } else {
    payload.route = "home";
  }
  return payload;
}

// A small SKIP-LOCKED equivalent implemented by conditional row leasing. The
// unique alert/kind key gives us exactly one durable delivery intent; retries
// only move that row through PENDING → LEASED → DELIVERED/RETRY.
function buildInboxDelivery(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const deviceTokens = dependencies.DeviceToken || defaultDeviceToken;
  const apns = dependencies.apnsService || defaultApns;
  const fcm = dependencies.fcmService || defaultFcm;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const batchSize = dependencies.batchSize || 25;
  return async function deliverInbox() {
    if (process.env.INBOX_DELIVERY_DISABLED === "true") return null;
    const current = now();
    const candidates = await prisma.inboxDeliveryOutbox.findMany({
      where: {
        OR: [
          { status: { in: ["PENDING", "RETRY"] }, availableAt: { lte: current } },
          { status: "LEASED", leaseUntil: { lte: current } },
        ],
      },
      orderBy: { availableAt: "asc" }, take: batchSize,
      include: { alert: { select: { userId: true, type: true, destination: true } } },
    });
    let delivered = 0;
    for (const row of candidates) {
      const leased = await prisma.inboxDeliveryOutbox.updateMany({
        where: {
          id: row.id,
          OR: [
            { status: { in: ["PENDING", "RETRY"] }, availableAt: { lte: current } },
            { status: "LEASED", leaseUntil: { lte: current } },
          ],
        },
        data: { status: "LEASED", leaseUntil: new Date(current.getTime() + LEASE_MS) },
      });
      if (leased.count !== 1) continue;
      try {
        const tokens = await deviceTokens.findByUserId(row.alert.userId);
        // No device is a successful delivery disposition: the alert is already
        // durable in Inbox and retrying forever cannot create a device.
        let transientFailure = false;
        for (const token of tokens) {
          const push = token.platform === "android" ? fcm : apns;
          const result = await push.sendNotification({
            deviceToken: token.token,
            title: row.payload.title,
            body: row.payload.body,
            payload: pushPayload(row.alert),
          });
          if (result?.unregistered) {
            await deviceTokens.deleteToken({ userId: row.alert.userId, token: token.token });
          } else if (!result?.success) {
            transientFailure = true;
          }
        }
        if (transientFailure) throw new Error("At least one inbox push delivery failed");
        await prisma.inboxDeliveryOutbox.update({ where: { id: row.id }, data: { status: "DELIVERED", deliveredAt: now(), leaseUntil: null } });
        delivered += 1;
      } catch (error) {
        const attempts = row.attemptCount + 1;
        await prisma.inboxDeliveryOutbox.update({
          where: { id: row.id },
          data: { status: "RETRY", attemptCount: attempts, leaseUntil: null, availableAt: retryAt(current, attempts) },
        });
        logger.error("[CRON] inbox delivery failed", { outboxId: row.id, error: error?.message || String(error) });
      }
    }
    return { claimed: candidates.length, delivered };
  };
}

function scheduleInboxDelivery(dependencies = {}) {
  const run = buildInboxDelivery(dependencies);
  const logger = dependencies.logger || console;
  const tick = () => run().catch((error) => logger.error("[CRON] inboxDelivery tick error:", error));
  tick();
  const interval = setInterval(tick, dependencies.intervalMs || TICK_INTERVAL_MS);
  interval.unref?.();
  logger.log("[CRON] Inbox delivery scheduled");
}

module.exports = { buildInboxDelivery, scheduleInboxDelivery, retryAt, pushPayload };
