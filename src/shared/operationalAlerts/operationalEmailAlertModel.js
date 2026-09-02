const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../db");

const DELIVERY_LEASE_MS = 60_000;
const SLOW_COOLDOWN_MS = 15 * 60_000;
const RETENTION_MS = 90 * 24 * 60 * 60_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

function boundedPayload(payload) {
  const serialized = JSON.stringify(payload || {});
  if (Buffer.byteLength(serialized) > 8 * 1024) throw new Error("operational alert payload exceeds 8 KiB");
  return JSON.parse(serialized);
}

function buildOperationalEmailAlertModel({ prisma = defaultPrisma, randomUUID = crypto.randomUUID } = {}) {
  return {
    async admit({ alertType, attemptId, payload, now = new Date() }) {
      const dedupeKey = `${alertType}:${attemptId}`;
      if (dedupeKey.length > 160 || !/^(slow|watchdog):[0-9a-f:-]+$/.test(dedupeKey)) {
        throw new Error("invalid operational alert dedupe key");
      }
      const safePayload = boundedPayload(payload);
      return prisma.$transaction(async (tx) => {
        if (alertType === "slow") {
          await tx.$executeRawUnsafe(
            "SELECT pg_advisory_xact_lock(hashtext('operational-email-alert:slow-admission')::bigint)"
          );
        }
        // Admission time is the database clock observed after serialization.
        // CURRENT_TIMESTAMP is the transaction-start time and a pre-lock clock
        // becomes stale while a contender waits, either of which can shorten
        // the next exact 15-minute suppression window.
        const clock = await tx.$queryRawUnsafe("SELECT clock_timestamp() AS now");
        const databaseNow = new Date(clock[0].now);
        if (alertType === "slow") {
          const newest = await tx.operationalEmailAlert.findFirst({
            where: { alertType: "slow" },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true },
          });
          if (newest && databaseNow.getTime() - newest.createdAt.getTime() < SLOW_COOLDOWN_MS) {
            return { admitted: false, reason: "cooldown" };
          }
        }
        try {
          const row = await tx.operationalEmailAlert.create({
            data: {
              dedupeKey,
              alertType,
              payload: safePayload,
              notBeforeAt: databaseNow,
              createdAt: databaseNow,
              updatedAt: databaseNow,
            },
          });
          return { admitted: true, row };
        } catch (error) {
          if (error?.code === "P2002") return { admitted: false, reason: "duplicate" };
          throw error;
        }
      });
    },

    async claimNext({ now = new Date(), leaseMs = DELIVERY_LEASE_MS } = {}) {
      const leaseToken = randomUUID();
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe(
          `SELECT id FROM operational_email_alerts
             WHERE state='PENDING' AND not_before_at <= $1
             ORDER BY not_before_at ASC, id ASC
             FOR UPDATE SKIP LOCKED LIMIT 1`,
          now
        );
        if (!rows[0]) return null;
        return tx.operationalEmailAlert.update({
          where: { id: rows[0].id },
          data: {
            state: "SENDING",
            attempts: { increment: 1 },
            leaseToken,
            leaseExpiresAt: new Date(now.getTime() + leaseMs),
          },
        });
      });
    },

    async markAccepted({ id, leaseToken, now = new Date() }) {
      return prisma.operationalEmailAlert.updateMany({
        where: { id, state: "SENDING", leaseToken },
        data: {
          state: "ACCEPTED", acceptedAt: now, terminalAt: now,
          leaseToken: null, leaseExpiresAt: null, lastErrorCode: null,
        },
      });
    },

    async markUncertain({ id, leaseToken, errorCode, now = new Date() }) {
      return prisma.operationalEmailAlert.updateMany({
        where: { id, state: "SENDING", leaseToken },
        data: {
          state: "UNCERTAIN", terminalAt: now,
          leaseToken: null, leaseExpiresAt: null,
          lastErrorCode: String(errorCode || "DELIVERY_UNCERTAIN").slice(0, 64),
        },
      });
    },

    async markFailed({ id, leaseToken, errorCode, now = new Date() }) {
      return prisma.operationalEmailAlert.updateMany({
        where: { id, state: "SENDING", leaseToken },
        data: {
          state: "FAILED", terminalAt: now,
          leaseToken: null, leaseExpiresAt: null,
          lastErrorCode: String(errorCode || "DELIVERY_FAILED").slice(0, 64),
        },
      });
    },

    async retry({ id, leaseToken, attempts, errorCode, now = new Date() }) {
      const delay = RETRY_DELAYS_MS[Math.max(0, Math.min(3, Number(attempts) - 1))];
      return prisma.operationalEmailAlert.updateMany({
        where: { id, state: "SENDING", leaseToken },
        data: {
          state: "PENDING", notBeforeAt: new Date(now.getTime() + delay),
          leaseToken: null, leaseExpiresAt: null,
          lastErrorCode: String(errorCode || "DELIVERY_UNAVAILABLE").slice(0, 64),
        },
      });
    },

    async reconcileExpiredSending({ now = new Date(), limit = 25 } = {}) {
      const ids = await prisma.operationalEmailAlert.findMany({
        where: { state: "SENDING", leaseExpiresAt: { lte: now } },
        orderBy: [{ leaseExpiresAt: "asc" }, { id: "asc" }],
        take: Math.min(25, Math.max(1, limit)),
        select: { id: true },
      });
      if (ids.length === 0) return 0;
      const result = await prisma.operationalEmailAlert.updateMany({
        where: { id: { in: ids.map((row) => row.id) }, state: "SENDING", leaseExpiresAt: { lte: now } },
        data: {
          state: "UNCERTAIN", terminalAt: now, leaseToken: null,
          leaseExpiresAt: null, lastErrorCode: "DELIVERY_LEASE_EXPIRED",
        },
      });
      return result.count;
    },

    async scrubTerminalPayloads({ now = new Date(), limit = 25 } = {}) {
      const before = new Date(now.getTime() - RETENTION_MS);
      const rows = await prisma.operationalEmailAlert.findMany({
        where: {
          state: { in: ["ACCEPTED", "UNCERTAIN", "FAILED"] },
          terminalAt: { lte: before },
          NOT: { payload: { equals: {} } },
        },
        orderBy: [{ terminalAt: "asc" }, { id: "asc" }],
        take: Math.min(25, Math.max(1, limit)),
        select: { id: true },
      });
      if (rows.length === 0) return 0;
      const result = await prisma.operationalEmailAlert.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: { payload: {}, lastErrorCode: null },
      });
      return result.count;
    },
  };
}

module.exports = {
  DELIVERY_LEASE_MS,
  RETENTION_MS,
  RETRY_DELAYS_MS,
  SLOW_COOLDOWN_MS,
  buildOperationalEmailAlertModel,
};
