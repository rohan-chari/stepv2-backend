const { prisma: defaultPrisma } = require("../../../db");
const {
  markUnreadAlertsRead,
  markUnreadSupportThreadsRead,
} = require("../models/inbox");
const { getInboxUnreadCounts } = require("../queries/getInboxUnreadCounts");
const { invalidateInboxUnread } = require("../services/inbox");

async function markInboxReadAll({
  userId,
  now = new Date(),
  prisma = defaultPrisma,
}) {
  const result = await prisma.$transaction(async (tx) => {
    const [alerts, threads] = await Promise.all([
      markUnreadAlertsRead({ userId, now, prisma: tx }),
      markUnreadSupportThreadsRead({ userId, now, prisma: tx }),
    ]);
    const unreadCounts = await getInboxUnreadCounts({ userId, now, prisma: tx });
    return {
      readAlertCount: alerts.count,
      readThreadCount: threads.count,
      ...unreadCounts,
    };
  });

  // The cache is invalidated only after the transaction has committed, so a
  // rollback can never advertise a read inbox to Home.
  try {
    await invalidateInboxUnread(userId);
  } catch (error) {
    // Redis is derived state; a committed Postgres read must remain successful
    // even when cache invalidation is unavailable.
    console.error("Inbox read-all cache invalidation failed:", error);
  }
  return result;
}

module.exports = { markInboxReadAll };
