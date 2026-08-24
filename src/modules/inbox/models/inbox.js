const { prisma: defaultPrisma } = require("../../../db");

async function countUnreadAlerts({ userId, now, prisma = defaultPrisma }) {
  return prisma.inboxAlert.count({
    where: { userId, expiresAt: { gt: now }, readAt: null },
  });
}

async function countUnreadSupportThreads({ userId, now, prisma = defaultPrisma }) {
  return prisma.feedbackThread.count({
    where: { userId, expiresAt: { gt: now }, userReadAt: null },
  });
}

async function findOwnedActiveAlert({ userId, alertId, now, prisma = defaultPrisma }) {
  return prisma.inboxAlert.findFirst({
    where: { id: alertId, userId, expiresAt: { gt: now } },
    select: { id: true, readAt: true },
  });
}

async function markUnreadAlertRead({ userId, alertId, now, prisma = defaultPrisma }) {
  return prisma.inboxAlert.updateMany({
    where: {
      id: alertId,
      userId,
      expiresAt: { gt: now },
      readAt: null,
    },
    data: { readAt: now },
  });
}

async function markUnreadAlertsRead({ userId, now, prisma = defaultPrisma }) {
  return prisma.inboxAlert.updateMany({
    where: {
      userId,
      expiresAt: { gt: now },
      readAt: null,
    },
    data: { readAt: now },
  });
}

async function markUnreadSupportThreadsRead({ userId, now, prisma = defaultPrisma }) {
  return prisma.feedbackThread.updateMany({
    where: {
      userId,
      expiresAt: { gt: now },
      userReadAt: null,
    },
    data: { userReadAt: now },
  });
}

module.exports = {
  countUnreadAlerts,
  countUnreadSupportThreads,
  findOwnedActiveAlert,
  markUnreadAlertRead,
  markUnreadAlertsRead,
  markUnreadSupportThreadsRead,
};
