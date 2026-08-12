const { prisma: defaultPrisma } = require("../../../db");

// Minimal fresh-read used before exposing the Races tab. It deliberately
// returns only decision-card fields, not the full race-list summaries (effects,
// inventory, podiums, and every participant), so an invite check stays cheap.
function buildGetRaceInvitePreflight(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;

  return async function getRaceInvitePreflight({ userId, supportsTournaments }) {
    const [races, tournaments] = await Promise.all([
      prisma.race.findMany({
        where: {
          status: { in: ["PENDING", "ACTIVE"] },
          participants: { some: { userId, status: "INVITED" } },
        },
        select: {
          id: true,
          name: true,
          status: true,
          maxDurationDays: true,
          buyInAmount: true,
          scheduledStartAt: true,
          createdAt: true,
          creator: { select: { id: true, displayName: true, profilePhotoUrl: true } },
          participants: {
            where: { userId, status: "INVITED" },
            select: { inviteExpiresAt: true },
            take: 1,
          },
        },
        orderBy: { createdAt: "asc" },
      }),
      supportsTournaments
        ? prisma.tournament.findMany({
            where: {
              status: "PENDING",
              participants: { some: { userId, status: "INVITED" } },
            },
            select: {
              id: true,
              name: true,
              matchupDurationDays: true,
              buyInAmount: true,
              createdAt: true,
              creator: { select: { id: true, displayName: true, profilePhotoUrl: true } },
            },
            orderBy: { createdAt: "asc" },
          })
        : Promise.resolve([]),
    ]);

    const result = { active: [], pending: [] };
    for (const race of races) {
      const row = {
        id: race.id,
        name: race.name,
        status: race.status,
        maxDurationDays: race.maxDurationDays,
        buyInAmount: race.buyInAmount,
        scheduledStartAt: race.scheduledStartAt,
        createdAt: race.createdAt,
        creator: race.creator,
        myStatus: "INVITED",
        myInviteExpiresAt: race.participants[0]?.inviteExpiresAt ?? null,
      };
      (race.status === "ACTIVE" ? result.active : result.pending).push(row);
    }
    if (supportsTournaments) {
      result.tournaments = tournaments.map((tournament) => ({
        id: tournament.id,
        name: tournament.name,
        matchupDurationDays: tournament.matchupDurationDays,
        buyInAmount: tournament.buyInAmount,
        createdAt: tournament.createdAt,
        creator: tournament.creator,
        myStatus: "INVITED",
      }));
    }
    return result;
  };
}

const getRaceInvitePreflight = buildGetRaceInvitePreflight();

module.exports = { buildGetRaceInvitePreflight, getRaceInvitePreflight };
