const { prisma: defaultPrisma } = require("../../../db");
const { NotFoundError } = require("../../../shared/errors/AppError");
const {
  findOwnedActiveAlert,
  markUnreadAlertRead,
} = require("../models/inbox");
const { getInboxUnreadCounts } = require("../queries/getInboxUnreadCounts");
const { invalidateInboxUnread } = require("../services/inbox");

async function markInboxAlertRead({
  userId,
  alertId,
  now = new Date(),
  prisma = defaultPrisma,
}) {
  const counts = await prisma.$transaction(async (tx) => {
    const alert = await findOwnedActiveAlert({
      userId,
      alertId,
      now,
      prisma: tx,
    });
    if (!alert) throw new NotFoundError("Alert not found", "NOT_FOUND");

    // Preserve the first read timestamp. A replay has no write side effect.
    if (alert.readAt === null) {
      await markUnreadAlertRead({
        userId,
        alertId: alert.id,
        now,
        prisma: tx,
      });
    }
    return getInboxUnreadCounts({ userId, now, prisma: tx });
  });

  await invalidateInboxUnread(userId);
  return counts;
}

module.exports = { markInboxAlertRead };
