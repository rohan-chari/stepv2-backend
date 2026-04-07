const { prisma } = require("../db");
const { buildLeaderboardHighlightCards, getChallengeWinsNeededToAdvance, getRacePodiumTargetToAdvance } = require("../utils/leaderboardHighlights");
const { CHALLENGE_RECORD_MINIMUM_COMPLETED, rankChallengeRecordEntries, rankRaceRecordEntries } = require("../utils/recordLeaderboardRankings");
const { getMondayOfWeek, getTimeZoneParts } = require("../utils/week");

function getDateBoundary(period, timeZone) {
  const now = new Date();
  const parts = getTimeZoneParts(now, timeZone);

  switch (period) {
    case "today":
      return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    case "week":
      return getMondayOfWeek(now, timeZone);
    case "month":
      return `${parts.year}-${String(parts.month).padStart(2, "0")}-01`;
    case "allTime":
    default:
      return null;
  }
}

function rankStepGroups(groups) {
  let previousSteps = null;
  let previousRank = 1;

  return groups.map((group, index) => {
    const totalSteps = group._sum.steps || 0;
    const rank = totalSteps === previousSteps ? previousRank : index + 1;
    previousSteps = totalSteps;
    previousRank = rank;

    return {
      userId: group.userId,
      totalSteps,
      rank,
    };
  });
}

function findCurrentAndNextBetter(rankedEntries, currentUserId) {
  const currentIndex = rankedEntries.findIndex((entry) => entry.userId === currentUserId);
  if (currentIndex === -1) {
    return { current: null, nextBetter: null };
  }

  const current = rankedEntries[currentIndex];
  if (current.rank === 1) {
    return { current, nextBetter: null };
  }

  for (let index = currentIndex - 1; index >= 0; index--) {
    if (rankedEntries[index].rank < current.rank) {
      return { current, nextBetter: rankedEntries[index] };
    }
  }

  return { current, nextBetter: null };
}

async function getStepCandidates(currentUserId, timeZone) {
  const periods = ["allTime", "month", "week", "today"];
  const candidates = [];

  for (const period of periods) {
    const dateBoundary = getDateBoundary(period, timeZone);
    const groups = await prisma.step.groupBy({
      by: ["userId"],
      _sum: { steps: true },
      where: dateBoundary ? { date: { gte: new Date(dateBoundary) } } : undefined,
      orderBy: { _sum: { steps: "desc" } },
    });

    const ranked = rankStepGroups(groups);
    const { current, nextBetter } = findCurrentAndNextBetter(ranked, currentUserId);
    if (!current) {
      continue;
    }

    candidates.push({
      period,
      rank: current.rank,
      nextRank: nextBetter?.rank ?? null,
      distanceToNext: nextBetter ? nextBetter.totalSteps - current.totalSteps + 1 : 0,
    });
  }

  return candidates;
}

async function getChallengeCandidate(currentUserId) {
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

  const userIds = [...statsByUserId.keys()];
  if (!userIds.includes(currentUserId)) {
    return null;
  }

  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, displayName: true },
  });
  const userMap = new Map(users.map((user) => [user.id, user.displayName || "Anonymous"]));

  const ranked = rankChallengeRecordEntries(
    [...statsByUserId.entries()].map(([userId, record]) => ({
      userId,
      displayName: userMap.get(userId) || "Anonymous",
      wins: record.wins,
      losses: record.losses,
    }))
  );

  const { current, nextBetter } = findCurrentAndNextBetter(ranked, currentUserId);
  if (!current || current.completedCount < CHALLENGE_RECORD_MINIMUM_COMPLETED) {
    return null;
  }

  return {
    rank: current.rank,
    winsNeededToAdvance: nextBetter
      ? getChallengeWinsNeededToAdvance(
          { wins: current.wins, losses: current.losses },
          { wins: nextBetter.wins, losses: nextBetter.losses }
        )
      : null,
  };
}

async function getRaceCandidate(currentUserId) {
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

  const userIds = [...statsByUserId.keys()];
  if (!userIds.includes(currentUserId)) {
    return null;
  }

  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, displayName: true },
  });
  const userMap = new Map(users.map((user) => [user.id, user.displayName || "Anonymous"]));

  const ranked = rankRaceRecordEntries(
    [...statsByUserId.entries()].map(([userId, record]) => ({
      userId,
      displayName: userMap.get(userId) || "Anonymous",
      firsts: record.firsts,
      seconds: record.seconds,
      thirds: record.thirds,
    }))
  );

  const { current, nextBetter } = findCurrentAndNextBetter(ranked, currentUserId);
  if (!current) {
    return null;
  }

  return {
    rank: current.rank,
    podiumTarget: nextBetter
      ? getRacePodiumTargetToAdvance(
          {
            firsts: current.firsts,
            seconds: current.seconds,
            thirds: current.thirds,
          },
          {
            firsts: nextBetter.firsts,
            seconds: nextBetter.seconds,
            thirds: nextBetter.thirds,
          }
        )
      : null,
  };
}

async function getLeaderboardHighlights(currentUserId, timeZone) {
  const [steps, challenges, races] = await Promise.all([
    getStepCandidates(currentUserId, timeZone),
    getChallengeCandidate(currentUserId),
    getRaceCandidate(currentUserId),
  ]);

  return {
    cards: buildLeaderboardHighlightCards({
      steps,
      challenges,
      races,
    }),
  };
}

module.exports = { getLeaderboardHighlights };
