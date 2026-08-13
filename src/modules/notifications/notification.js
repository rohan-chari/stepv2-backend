const { prisma } = require("../../db");

const Notification = {
  // Record one user-facing notification we sent. One row per recipient user per
  // notification (not per device token). `type` is the push payload type string
  // (e.g. RACE_STARTED, race_message, PLACEMENT_CHANGED, DAILY_MOVER).
  async create({ userId, type, title = null, body = null, raceId = null, deliveryKey = null }) {
    return prisma.notification.create({
      data: { userId, type, title, body, raceId, deliveryKey },
    });
  },

  // First recorded notification of `type` sent to `userId` about `raceId`, or
  // null. Used as a send-once dedup key (e.g. the TR-304 "teams are uneven"
  // scheduled-start push fires only on the first failed attempt).
  async findFirstByUserTypeRace(userId, type, raceId) {
    return prisma.notification.findFirst({
      where: { userId, type, raceId },
    });
  },

  // Bulk equivalent for cron jobs that evaluate many recipient/race keys at
  // once. The caller performs exact-key matching on the returned rows; the
  // independent IN predicates intentionally keep this to one parameterized
  // query rather than constructing a very large OR expression.
  async findExistingByUserTypeRaceKeys(keys) {
    const normalized = (keys || []).filter(
      (key) => key?.userId && key?.type && key?.raceId
    );
    if (normalized.length === 0) return [];
    return prisma.notification.findMany({
      where: {
        userId: { in: [...new Set(normalized.map((key) => key.userId))] },
        type: { in: [...new Set(normalized.map((key) => key.type))] },
        raceId: { in: [...new Set(normalized.map((key) => key.raceId))] },
      },
      select: { userId: true, type: true, raceId: true },
    });
  },

  // INSERT-first durable claim for cron notifications. deliveryKey is unique,
  // so concurrent ticks/processes race in Postgres and exactly one wins. The
  // claim row is also the audit row; the notification handler must skip its
  // normal after-send audit write.
  async claimDelivery({ userId, type, raceId, deliveryKey }) {
    try {
      await prisma.notification.create({
        data: { userId, type, raceId, deliveryKey },
      });
      return true;
    } catch (error) {
      if (error && error.code === "P2002") return false;
      throw error;
    }
  },

  // Most recent `type` row for `userId` created on/after `since`, or null.
  // Backs rolling-window recipient caps (e.g. HIGH_MULTIPLIER_ALERT's
  // once-per-24h limit). Rows only exist for ~a week (nightly prune), which
  // comfortably covers any sane window.
  async findFirstByUserTypeSince(userId, type, since) {
    return prisma.notification.findFirst({
      where: { userId, type, createdAt: { gte: since } },
    });
  },

  // Nightly-cleanup primitive: delete everything older than `cutoff`. Returns the
  // Prisma batch-payload ({ count }). Idempotent — re-running deletes nothing more.
  async deleteOlderThan(cutoff) {
    return prisma.notification.deleteMany({
      where: { createdAt: { lt: new Date(cutoff) } },
    });
  },
};

module.exports = { Notification };
