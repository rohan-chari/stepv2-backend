const { prisma: defaultPrisma } = require("../../../db");
const { hasLiveUserCreatedRace } = require("../services/nextRacePolicy");

const EMPTY = Object.freeze({
  resolved: false,
  eligible: false,
  discoveryEnabled: false,
  createEnabled: false,
  openRaces: [],
});

async function getNextRaceHome({
  userId,
  discoveryEnabled,
  createEnabled,
  prisma = defaultPrisma,
  now = new Date(),
}) {
  const eligible = !(await hasLiveUserCreatedRace(userId, { prisma }));
  if (!eligible || !discoveryEnabled) {
    return {
      resolved: true,
      eligible,
      discoveryEnabled: discoveryEnabled === true,
      createEnabled: createEnabled === true,
      openRaces: [],
    };
  }

  const activeCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  // Bound candidates in SQL before projecting creators/counts. A little
  // headroom allows creator de-duplication without ever loading the unbounded
  // public-race catalog onto Home's hot path.
  const candidates = await prisma.race.findMany({
    where: {
      status: { in: ["PENDING", "ACTIVE"] },
      isPublic: true,
      creatorId: { not: null },
      creator: { isReviewAccount: false },
      buyInAmount: 0,
      isTeamRace: false,
      participants: { none: { userId, status: { not: "DECLINED" } } },
      OR: [
        { status: "PENDING", startPolicy: "ON_MINIMUM_PARTICIPANTS" },
        {
          status: "ACTIVE",
          startedAt: { gte: activeCutoff },
          endsAt: { gt: now },
        },
      ],
    },
    select: {
      id: true,
      name: true,
      status: true,
      startedAt: true,
      endsAt: true,
      maxParticipants: true,
      isTeamRace: true,
      createdAt: true,
      creatorId: true,
      creator: {
        select: { id: true, displayName: true, profilePhotoUrl: true },
      },
      _count: { select: { participants: { where: { status: "ACCEPTED" } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 24,
  });

  candidates.sort((a, b) => {
    if (a.status !== b.status) return a.status === "PENDING" ? -1 : 1;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  const creators = new Set();
  const openRaces = [];
  for (const race of candidates) {
    const participantCount = race._count.participants;
    if (race.maxParticipants != null && participantCount >= race.maxParticipants) continue;
    if (creators.has(race.creatorId)) continue;
    creators.add(race.creatorId);
    openRaces.push({
      id: race.id,
      name: race.name,
      status: race.status,
      creator: race.creator,
      participantCount,
      maxParticipants: race.maxParticipants ?? null,
      startedAt: race.startedAt,
      endsAt: race.endsAt,
      isTeamRace: false,
    });
    if (openRaces.length === 3) break;
  }

  return {
    resolved: true,
    eligible: true,
    discoveryEnabled: true,
    createEnabled: createEnabled === true,
    openRaces,
  };
}

module.exports = { EMPTY, getNextRaceHome };
