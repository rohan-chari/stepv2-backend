const { prisma: defaultPrisma } = require("../../../db");

// Minimal fresh-read used before exposing the Races tab. It deliberately
// returns only decision-card fields, not the full race-list summaries (effects,
// inventory, podiums, and every participant), so an invite check stays cheap.
function buildGetRaceInvitePreflight(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;

  return async function getRaceInvitePreflight({
    userId,
    supportsTournaments,
    supportsTeamRaces = false,
    homeInviteModal = false,
  }) {
    const now = new Date();
    const liveInvite = {
      userId,
      status: "INVITED",
      OR: [{ inviteExpiresAt: null }, { inviteExpiresAt: { gt: now } }],
    };
    const [races, tournaments] = await Promise.all([
      prisma.race.findMany({
        where: {
          // Tournament matchup races are answered solely through their bracket;
          // never duplicate one into a race decision surface.
          tournamentId: null,
          status: { in: ["PENDING", "ACTIVE"] },
          participants: { some: liveInvite },
        },
        select: {
          id: true,
          name: true,
          status: true,
          maxDurationDays: true,
          buyInAmount: true,
          isTeamRace: true,
          scheduledStartAt: true,
          scheduledEndAt: true,
          createdAt: true,
          creator: { select: { id: true, displayName: true, profilePhotoUrl: true } },
          participants: {
            where: liveInvite,
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

    if (homeInviteModal) {
      const invites = [];
      // Brackets always precede races; createdAt then id forms the stable
      // canonical tie-break. Omit brackets unless their renderer token exists.
      for (const tournament of tournaments) {
        invites.push({
          kind: "TOURNAMENT",
          id: tournament.id,
          name: tournament.name,
          status: "PENDING",
          createdAt: tournament.createdAt,
          matchupDurationDays: tournament.matchupDurationDays ?? null,
          buyInAmount: tournament.buyInAmount ?? null,
          creator: tournament.creator
            ? { id: tournament.creator.id, displayName: tournament.creator.displayName ?? null }
            : null,
        });
      }
      for (const race of races) {
        invites.push({
          kind: "RACE",
          id: race.id,
          name: race.name,
          status: race.status,
          createdAt: race.createdAt,
          scheduledStartAt: race.scheduledStartAt ?? null,
          scheduledEndAt: race.scheduledEndAt ?? null,
          myInviteExpiresAt: race.participants[0]?.inviteExpiresAt ?? null,
          maxDurationDays: race.maxDurationDays ?? null,
          isTeamRace: race.isTeamRace === true,
          // Home's one-tap response will auto-assign a side, but this remains a
          // truthful safe disclosure for old/non-team-capable accounts.
          requiresTeamRaceSupport:
            race.isTeamRace === true && supportsTeamRaces !== true,
          buyInAmount: race.buyInAmount ?? null,
          creator: race.creator
            ? { id: race.creator.id, displayName: race.creator.displayName ?? null }
            : null,
        });
      }
      invites.sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "TOURNAMENT" ? -1 : 1;
        if (left.kind === "RACE") {
          const leftExpiry = left.myInviteExpiresAt ? new Date(left.myInviteExpiresAt).getTime() : Infinity;
          const rightExpiry = right.myInviteExpiresAt ? new Date(right.myInviteExpiresAt).getTime() : Infinity;
          if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
          const leftStart = left.scheduledStartAt ? new Date(left.scheduledStartAt).getTime() : Infinity;
          const rightStart = right.scheduledStartAt ? new Date(right.scheduledStartAt).getTime() : Infinity;
          if (leftStart !== rightStart) return leftStart - rightStart;
        }
        const created = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
        return created || String(left.id).localeCompare(String(right.id));
      });
      return { resolved: true, invites };
    }

    const result = { active: [], pending: [] };
    for (const race of races) {
      const row = {
        id: race.id,
        name: race.name,
        status: race.status,
        maxDurationDays: race.maxDurationDays,
        buyInAmount: race.buyInAmount,
        // NOTE: scheduledEndAt is deliberately NOT added to this LEGACY
        // serializer. It is the payload a frozen, non-capability client
        // receives, and test/integration/home-invite-preflight.test.js pins it
        // byte-for-byte ("keeps frozen gate clients byte-compatible"). The
        // capability-gated `invites` serializer above carries the field, which
        // is the surface any client that can render a window actually reads.
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
