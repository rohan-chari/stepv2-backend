const {
  countUnreadAlerts,
  countUnreadSupportThreads,
} = require("../models/inbox");
const { prisma: defaultPrisma } = require("../../../db");
const {
  homeLaunchAuxiliaryBatch,
} = require("../../home/services/homeLaunchAuxiliaryBatch");

async function getInboxUnreadCounts({ userId, now = new Date(), prisma }) {
  if (!prisma || prisma === defaultPrisma) {
    const counts = await homeLaunchAuxiliaryBatch.loadInboxCounts({
      prisma: prisma || defaultPrisma,
      userId,
      now,
    });
    return {
      unreadCount: counts.unreadCount,
      totalUnreadCount: counts.unreadCount + counts.supportThreadUnreadCount,
    };
  }
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
