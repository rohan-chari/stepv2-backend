const { prisma } = require("../db");

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

  // Nightly-cleanup primitive: delete everything older than `cutoff`. Returns the
  // Prisma batch-payload ({ count }). Idempotent — re-running deletes nothing more.
  async deleteOlderThan(cutoff) {
    return prisma.notification.deleteMany({
      where: { createdAt: { lt: new Date(cutoff) } },
    });
  },
};

module.exports = { Notification };
