const { prisma } = require("../db");
const { buildLeaderboardHighlightCards, getRacePodiumTargetToAdvance } = require("../utils/leaderboardHighlights");
const { rankRaceRecordEntries } = require("../utils/recordLeaderboardRankings");
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
  const [steps, races] = await Promise.all([
    getStepCandidates(currentUserId, timeZone),
    getRaceCandidate(currentUserId),
  ]);

  return {
    cards: buildLeaderboardHighlightCards({
      steps,
      races,
    }),
  };
}

module.exports = { getLeaderboardHighlights };
