const { prisma } = require("../db");
const {
  CHALLENGE_RECORD_MINIMUM_COMPLETED,
  buildChallengeRecordLeaderboard,
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
  const whereClause = dateBoundary
    ? { date: { gte: new Date(dateBoundary) } }
    : {};

  const top10Groups = await prisma.step.groupBy({
    by: ["userId"],
    _sum: { steps: true },
    where: whereClause,
    orderBy: { _sum: { steps: "desc" } },
    take: 10,
  });

  const userMap = await getUserProfiles(top10Groups.map((group) => group.userId));

  let prevRank = 0;
  let prevSteps = null;
  const top10 = top10Groups.map((group, index) => {
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

  const currentUserInTop10 = top10.find((entry) => entry.userId === currentUserId);
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

  const currentUserAgg = await prisma.step.aggregate({
    _sum: { steps: true },
    where: { userId: currentUserId, ...whereClause },
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
    top10,
    currentUser: {
      rank: usersAbove.length + 1,
      displayName: currentUserProfile.displayName,
      profilePhotoUrl: currentUserProfile.profilePhotoUrl,
      totalSteps: currentUserSteps,
      inTop10: false,
    },
  };
}

async function getChallengeLeaderboard(currentUserId) {
  const completedInstances = await prisma.challengeInstance.findMany({
    where: {
      status: "COMPLETED",
      winnerUserId: { not: null },
    },
    select: {
      userAId: true,
      userBId: true,
      winnerUserId: true,
    },
  });

  const statsByUserId = new Map();

  function ensureRecord(userId) {
    if (!statsByUserId.has(userId)) {
      statsByUserId.set(userId, { wins: 0, losses: 0 });
    }
    return statsByUserId.get(userId);
  }

  for (const instance of completedInstances) {
    const userA = ensureRecord(instance.userAId);
    const userB = ensureRecord(instance.userBId);

    if (instance.winnerUserId === instance.userAId) {
      userA.wins += 1;
      userB.losses += 1;
    } else if (instance.winnerUserId === instance.userBId) {
      userB.wins += 1;
      userA.losses += 1;
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
    wins: record.wins,
    losses: record.losses,
  }));

  return {
    minimumCompletedChallenges: CHALLENGE_RECORD_MINIMUM_COMPLETED,
    ...buildChallengeRecordLeaderboard(entries, currentUserId, currentUserDisplayName),
  };
}

async function getRaceLeaderboard(currentUserId) {
  const completedParticipants = await prisma.raceParticipant.findMany({
    where: {
      status: "ACCEPTED",
      race: { status: "COMPLETED" },
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
  if (type === "challenges") {
    return getChallengeLeaderboard(currentUserId);
  }

  if (type === "races") {
    return getRaceLeaderboard(currentUserId);
  }

  return getStepLeaderboard(period, currentUserId, timeZone);
}

module.exports = { getLeaderboard };
