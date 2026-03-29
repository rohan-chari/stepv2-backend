const { prisma } = require("../db");
const { getMondayOfWeek, getTimeZoneParts } = require("../utils/week");

function getDateBoundary(period) {
  const now = new Date();
  const parts = getTimeZoneParts(now);

  switch (period) {
    case "today": {
      return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    }
    case "week": {
      return getMondayOfWeek(now);
    }
    case "month": {
      return `${parts.year}-${String(parts.month).padStart(2, "0")}-01`;
    }
    case "allTime": {
      return null;
    }
    default: {
      return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    }
  }
}

async function getLeaderboard(period, currentUserId) {
  const dateBoundary = getDateBoundary(period);

  const whereClause = dateBoundary
    ? { date: { gte: new Date(dateBoundary) } }
    : {};

  // Top 10 by total steps
  const top10Groups = await prisma.step.groupBy({
    by: ["userId"],
    _sum: { steps: true },
    where: whereClause,
    orderBy: { _sum: { steps: "desc" } },
    take: 10,
  });

  const top10UserIds = top10Groups.map((g) => g.userId);

  // Fetch display names for top 10
  const users = await prisma.user.findMany({
    where: { id: { in: top10UserIds } },
    select: { id: true, displayName: true },
  });

  const userMap = new Map(users.map((u) => [u.id, u.displayName]));

  const top10 = top10Groups.map((g, i) => ({
    rank: i + 1,
    userId: g.userId,
    displayName: userMap.get(g.userId) || "Anonymous",
    totalSteps: g._sum.steps || 0,
  }));

  // Current user info
  const currentUserInTop10 = top10.find((e) => e.userId === currentUserId);

  if (currentUserInTop10) {
    return {
      top10,
      currentUser: {
        rank: currentUserInTop10.rank,
        displayName: currentUserInTop10.displayName,
        totalSteps: currentUserInTop10.totalSteps,
        inTop10: true,
      },
    };
  }

  // Current user not in top 10 — get their total
  const currentUserAgg = await prisma.step.aggregate({
    _sum: { steps: true },
    where: { userId: currentUserId, ...whereClause },
  });

  const currentUserSteps = currentUserAgg._sum.steps || 0;

  // Count users with more steps to determine rank
  const usersAbove = await prisma.step.groupBy({
    by: ["userId"],
    _sum: { steps: true },
    where: whereClause,
    having: { steps: { _sum: { gt: currentUserSteps } } },
  });

  const currentUserData = await prisma.user.findUnique({
    where: { id: currentUserId },
    select: { displayName: true },
  });

  return {
    top10,
    currentUser: {
      rank: usersAbove.length + 1,
      displayName: currentUserData?.displayName || "Anonymous",
      totalSteps: currentUserSteps,
      inTop10: false,
    },
  };
}

module.exports = { getLeaderboard };
