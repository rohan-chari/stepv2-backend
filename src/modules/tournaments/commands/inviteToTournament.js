const { prisma: defaultPrisma } = require("../../../db");
const { eventBus } = require("../../../shared/events/eventBus");
const { Tournament } = require("../models/tournament");
const { Friendship } = require("../../social");
const { User } = require("../../users");
const { TournamentError } = require("../services/tournamentErrors");
const {
  TOURNAMENTS_FEATURE,
} = require("../constants/tournaments");
const {
  serializeTournamentPayload,
  tournamentDurationDays,
} = require("../queries/serializeTournament");
const { computePrizePool } = require("../../../shared/economy/prizePool");
const {
  resolveTournamentPrizeStamp,
} = require("../../races/services/fundedExposure");
const { withTournamentLock } = require("../services/tournamentLock");

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
    supportsRemoteAssets = false,
  }) {
    const tournament = await tournamentModel.findById(tournamentId);
    if (!tournament) {
      throw new TournamentError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");
    }
    if (tournament.creatorId !== userId) {
      throw new TournamentError("Only the creator can invite", 403, "NOT_CREATOR");
    }
    const prizeStamp = resolveTournamentPrizeStamp(tournament);
    if (tournament.status !== "PENDING") {
      throw new TournamentError(
        "This tournament has already started",
        409,
        "TOURNAMENT_NOT_PENDING"
      );
    }

    const eligible = [];
    const needsUpdate = [];
    const uniqueIds = [...new Set(userIds || [])].filter(
      (id) => id && id !== userId
    );

    for (const inviteeId of uniqueIds) {
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

      eligible.push(inviteeId);
    }

    const invited = [];
    await withTournamentLock(
      tournamentId,
      async (tx, _deferred, lockedTournament) => {
        if (!lockedTournament) {
          throw new TournamentError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");
        }
        if (lockedTournament.creatorId !== userId) {
          throw new TournamentError("Only the creator can invite", 403, "NOT_CREATOR");
        }
        if (lockedTournament.status !== "PENDING") {
          throw new TournamentError(
            "This tournament has already started",
            409,
            "TOURNAMENT_NOT_PENDING",
          );
        }
        for (const inviteeId of eligible) {
          const existing = await tx.tournamentParticipant.findUnique({
            where: {
              tournamentId_userId: { tournamentId, userId: inviteeId },
            },
          });
          if (existing && ["ACCEPTED", "INVITED"].includes(existing.status)) {
            continue;
          }
          if (existing) {
            await tx.tournamentParticipant.update({
              where: { id: existing.id },
              data: { status: "INVITED" },
            });
          } else {
            await tx.tournamentParticipant.create({
              data: { tournamentId, userId: inviteeId, status: "INVITED" },
            });
          }
          invited.push(inviteeId);
        }
      },
      { prisma: db, userIds: eligible },
    );

    for (const inviteeId of invited) {
      events.emit("TOURNAMENT_INVITE_SENT", {
        tournamentId,
        tournamentName: tournament.name,
        creatorUserId: userId,
        userId: inviteeId,
        bracketSize: tournament.bracketSize,
        // An app-funded bracket has no buy-in, so the invite push quotes the
        // pool a FULL bracket will mint (a bracket only ever starts full).
        potCoins:
          tournament.fundedPrize === true
            ? computePrizePool({
                playerCount: tournament.bracketSize,
                durationDays: tournamentDurationDays(tournament),
                max: prizeStamp.tournamentChampionMaxCoins,
                unit: prizeStamp.prizeCoinUnit,
              })
            : tournament.bracketSize * (tournament.buyInAmount || 0),
        buyInAmount: tournament.fundedPrize === true ? 0 : tournament.buyInAmount || 0,
      });
    }

    const full = await tournamentModel.findById(tournamentId);
    return {
      tournament: serializeTournamentPayload(full, userId, {
        supportsCharacters,
        supportsRemoteAssets,
      }),
      invited,
      needsUpdate,
    };
  };
}

const inviteToTournament = buildInviteToTournament();

module.exports = { buildInviteToTournament, inviteToTournament };
