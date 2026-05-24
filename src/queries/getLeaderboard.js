const { prisma } = require("../db");
const {
  buildRaceRecordLeaderboard,
} = require("../utils/recordLeaderboardRankings");
const { getMondayOfWeek, getTimeZoneParts } = require("../utils/week");

function getDateBoundary(period, timeZone) {
  const now = new Date();
  const parts = getTimeZoneParts(now, timeZone);

  switch (period) {
    case "today": {
      return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    }
    case "week": {
      return getMondayOfWeek(now, timeZone);
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

async function getUserProfiles(userIds) {
  if (userIds.length === 0) {
    return new Map();
  }

  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, displayName: true, profilePhotoUrl: true },
  });

  return new Map(
    users.map((user) => [
      user.id,
      {
        displayName: user.displayName || "Anonymous",
        profilePhotoUrl: user.profilePhotoUrl || null,
      },
    ])
  );
}

async function getCurrentUserProfile(currentUserId) {
  const currentUserData = await prisma.user.findUnique({
    where: { id: currentUserId },
    select: { displayName: true, profilePhotoUrl: true },
  });

  return {
    displayName: currentUserData?.displayName || "Anonymous",
    profilePhotoUrl: currentUserData?.profilePhotoUrl || null,
  };
}

async function getStepLeaderboard(period, currentUserId, timeZone) {
  const dateBoundary = getDateBoundary(period, timeZone);
  const dateClause = dateBoundary
    ? { date: { gte: new Date(dateBoundary) } }
    : {};
  // Hide review/demo accounts from real users' public leaderboards.
  const whereClause = { ...dateClause, user: { isReviewAccount: false } };

  const top100Groups = await prisma.step.groupBy({
    by: ["userId"],
    _sum: { steps: true },
    where: whereClause,
    orderBy: { _sum: { steps: "desc" } },
    take: 100,
  });

  const userMap = await getUserProfiles(top100Groups.map((group) => group.userId));

  let prevRank = 0;
  let prevSteps = null;
  const top100 = top100Groups.map((group, index) => {
    const totalSteps = group._sum.steps || 0;
    const rank = totalSteps === prevSteps ? prevRank : index + 1;
    prevRank = rank;
    prevSteps = totalSteps;

    return {
      rank,
      userId: group.userId,
      displayName: userMap.get(group.userId)?.displayName || "Anonymous",
      profilePhotoUrl: userMap.get(group.userId)?.profilePhotoUrl || null,
      totalSteps,
    };
  });

  const currentUserInTop100 = top100.find((entry) => entry.userId === currentUserId);
  if (currentUserInTop100) {
    return {
      top100,
      currentUser: {
        rank: currentUserInTop100.rank,
        displayName: currentUserInTop100.displayName,
        totalSteps: currentUserInTop100.totalSteps,
        inTop100: true,
      },
    };
  }

  const currentUserAgg = await prisma.step.aggregate({
    _sum: { steps: true },
    where: { userId: currentUserId, ...dateClause },
  });
  const currentUserSteps = currentUserAgg._sum.steps || 0;

  const usersAbove = await prisma.step.groupBy({
    by: ["userId"],
    _sum: { steps: true },
    where: whereClause,
    having: { steps: { _sum: { gt: currentUserSteps } } },
  });

  const currentUserProfile = await getCurrentUserProfile(currentUserId);

  return {
    top100,
    currentUser: {
      rank: usersAbove.length + 1,
      displayName: currentUserProfile.displayName,
      profilePhotoUrl: currentUserProfile.profilePhotoUrl,
      totalSteps: currentUserSteps,
      inTop100: false,
    },
  };
}

async function getRaceLeaderboard(currentUserId) {
  const completedParticipants = await prisma.raceParticipant.findMany({
    where: {
      status: "ACCEPTED",
      race: { status: "COMPLETED" },
      // Hide review/demo accounts from real users' public records board.
      user: { isReviewAccount: false },
    },
    select: {
      userId: true,
      placement: true,
    },
  });

  const statsByUserId = new Map();

  function ensureRecord(userId) {
    if (!statsByUserId.has(userId)) {
      statsByUserId.set(userId, { firsts: 0, seconds: 0, thirds: 0 });
    }
    return statsByUserId.get(userId);
  }

  for (const participant of completedParticipants) {
    const record = ensureRecord(participant.userId);
    if (participant.placement === 1) {
      record.firsts += 1;
    } else if (participant.placement === 2) {
      record.seconds += 1;
    } else if (participant.placement === 3) {
      record.thirds += 1;
    }
  }

  const userIds = [...statsByUserId.keys(), currentUserId];
  const userMap = await getUserProfiles(userIds);
  const currentUserDisplayName =
    userMap.get(currentUserId)?.displayName || "Anonymous";

  const entries = [...statsByUserId.entries()].map(([userId, record]) => ({
    userId,
    displayName: userMap.get(userId)?.displayName || "Anonymous",
    profilePhotoUrl: userMap.get(userId)?.profilePhotoUrl || null,
    firsts: record.firsts,
    seconds: record.seconds,
    thirds: record.thirds,
  }));

  return buildRaceRecordLeaderboard(entries, currentUserId, currentUserDisplayName);
}

async function getLeaderboard({ type = "steps", period = "today", currentUserId, timeZone }) {
  if (type === "races") {
    return getRaceLeaderboard(currentUserId);
  }

  return getStepLeaderboard(period, currentUserId, timeZone);
}

module.exports = { getLeaderboard };
