const { prisma: defaultPrisma } = require("../../../db");
const { hasLiveUserCreatedRace } = require("../services/nextRacePolicy");
const { findNextRaceCandidates } = require("./publicRaceHomeCandidates");

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

  // Bound candidates in SQL before projecting creators/counts. A little
  // headroom allows creator de-duplication without ever loading the unbounded
  // public-race catalog onto Home's hot path.
  const candidates = await findNextRaceCandidates({ prisma, userId, now });

  candidates.sort((a, b) => {
    if (a.status !== b.status) return a.status === "PENDING" ? -1 : 1;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  const creators = new Set();
  const openRaces = [];
  for (const race of candidates) {
    const participantCount = race.participantCount;
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
