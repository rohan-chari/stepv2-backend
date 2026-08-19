const {
  countUnreadAlerts,
  countUnreadSupportThreads,
} = require("../models/inbox");

async function getInboxUnreadCounts({ userId, now = new Date(), prisma }) {
  const [unreadCount, supportThreadUnreadCount] = await Promise.all([
    countUnreadAlerts({ userId, now, prisma }),
    countUnreadSupportThreads({ userId, now, prisma }),
  ]);
  return {
    unreadCount,
    totalUnreadCount: unreadCount + supportThreadUnreadCount,
  };
}

async function getInboxUnreadCount(options) {
  return (await getInboxUnreadCounts(options)).totalUnreadCount;
}

module.exports = { getInboxUnreadCounts, getInboxUnreadCount };
