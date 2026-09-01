const { prisma: defaultPrisma } = require("../../../db");
const defaultPresentationCache = require("../../social/services/userPresentationCache");

const PODIUM_PLACEMENTS = [1, 2, 3];

function buildRaceParticipantPresentationRead({
  prisma = defaultPrisma,
  presentationCache = defaultPresentationCache,
} = {}) {
  async function findPresentationsByUserIds(userIds) {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (ids.length === 0) return [];
    const presentations = await presentationCache.getMany(ids, true);
    return ids.map((id) => presentations.get(id)).filter(Boolean);
  }

  async function findPodiumForRaces(raceIds) {
    const ids = [...new Set((raceIds || []).filter(Boolean))];
    if (ids.length === 0) return [];
    // Keep every participant scalar exactly as the former include returned;
    // only the expensive participant -> user -> equipment relation is split
    // out and served through the shared generation-safe presentation cache.
    const rows = await prisma.raceParticipant.findMany({
      where: {
        raceId: { in: ids },
        status: "ACCEPTED",
        placement: { in: PODIUM_PLACEMENTS },
      },
      orderBy: [{ raceId: "asc" }, { placement: "asc" }],
    });
    const userIds = [...new Set(rows.map((row) => row.userId).filter(Boolean))];
    const presentations = await presentationCache.getMany(userIds, true);
    return rows.map((row) => ({
      ...row,
      user: presentations.get(row.userId) ?? null,
    }));
  }

  return { findPodiumForRaces, findPresentationsByUserIds };
}

const raceParticipantPresentationRead = buildRaceParticipantPresentationRead();

module.exports = {
  PODIUM_PLACEMENTS,
  buildRaceParticipantPresentationRead,
  raceParticipantPresentationRead,
};
