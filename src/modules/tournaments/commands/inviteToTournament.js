const { prisma: defaultPrisma } = require("../../../db");
const { eventBus } = require("../../../shared/events/eventBus");
const { Tournament } = require("../models/tournament");
const { Friendship } = require("../../social");
const { User } = require("../../users");
const { TournamentError } = require("../services/tournamentErrors");
const { TOURNAMENTS_FEATURE } = require("../constants/tournaments");
const {
  serializeTournamentPayload,
} = require("../queries/serializeTournament");

// Creator-only, PENDING-only lobby invites. Friends of the creator only. Users
// already ACCEPTED/INVITED are skipped; a previously DECLINED/left user is
// re-flipped to INVITED. Invitees whose sticky clientFeatures lack the
// tournaments token are skipped and reported in `needsUpdate`.
function buildInviteToTournament(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const tournamentModel = dependencies.Tournament || Tournament;
  const friendshipModel = dependencies.Friendship || Friendship;
  const userModel = dependencies.User || User;
  const events = dependencies.eventBus || eventBus;

  return async function inviteToTournament({
    userId,
    tournamentId,
    userIds,
    supportsCharacters,
  }) {
    const tournament = await tournamentModel.findById(tournamentId);
    if (!tournament) {
      throw new TournamentError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");
    }
    if (tournament.creatorId !== userId) {
      throw new TournamentError("Only the creator can invite", 403, "NOT_CREATOR");
    }
    if (tournament.status !== "PENDING") {
      throw new TournamentError(
        "This tournament has already started",
        409,
        "TOURNAMENT_NOT_PENDING"
      );
    }

    const existingByUser = new Map(
      (tournament.participants || []).map((p) => [p.userId, p])
    );

    const invited = [];
    const needsUpdate = [];
    const uniqueIds = [...new Set(userIds || [])].filter(
      (id) => id && id !== userId
    );

    for (const inviteeId of uniqueIds) {
      const existing = existingByUser.get(inviteeId);
      // Already in the lobby (accepted or pending invite) -> skip silently.
      if (existing && (existing.status === "ACCEPTED" || existing.status === "INVITED")) {
        continue;
      }

      const friendship = await friendshipModel.findBetweenUsers(userId, inviteeId);
      if (!friendship || friendship.status !== "ACCEPTED") {
        // Not a friend -> skip (don't fail the whole batch).
        continue;
      }

      const invitee = await userModel.findById(inviteeId);
      const features = (invitee && invitee.clientFeatures) || [];
      if (!features.includes(TOURNAMENTS_FEATURE)) {
        needsUpdate.push(inviteeId);
        continue;
      }

      if (existing) {
        // Re-flip a DECLINED/left row back to INVITED.
        await db.tournamentParticipant.update({
          where: { id: existing.id },
          data: { status: "INVITED" },
        });
      } else {
        await db.tournamentParticipant.create({
          data: { tournamentId, userId: inviteeId, status: "INVITED" },
        });
      }
      invited.push(inviteeId);
      events.emit("TOURNAMENT_INVITE_SENT", {
        tournamentId,
        tournamentName: tournament.name,
        creatorUserId: userId,
        userId: inviteeId,
        bracketSize: tournament.bracketSize,
        potCoins: tournament.bracketSize * (tournament.buyInAmount || 0),
        buyInAmount: tournament.buyInAmount || 0,
      });
    }

    const full = await tournamentModel.findById(tournamentId);
    return {
      tournament: serializeTournamentPayload(full, userId, { supportsCharacters }),
      invited,
      needsUpdate,
    };
  };
}

const inviteToTournament = buildInviteToTournament();

module.exports = { buildInviteToTournament, inviteToTournament };
