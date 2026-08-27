const { prisma: defaultPrisma } = require("../../../db");
const { eventBus } = require("../../../shared/events/eventBus");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const { appSettings } = require("../../../shared/config/appSettings");
const { Tournament } = require("../models/tournament");
const { TournamentError } = require("../services/tournamentErrors");
const { withTournamentLock } = require("../services/tournamentLock");
const { runTournamentStart } = require("../services/tournamentStart");
const {
  buildAtomicHoldFn,
  ensureUserCanAfford,
  reserveTournamentBuyIn,
} = require("../services/tournamentBuyIns");
const { clientSupportsTournaments } = require("../constants/tournaments");
const {
  serializeTournamentPayload,
} = require("../queries/serializeTournament");
const {
  computeTournamentExposureStamp,
  reserveFundedExposure,
  resolveTournamentPrizeStamp,
} = require("../../races/services/fundedExposure");

// Shared join engine for every entry point (public join, share-link join,
// invite accept). Resolves the tournament (by id or share token), gates the
// feature token + kill switch, then — inside the tournament advisory lock —
// runs the D12 featured guard, capacity check, buy-in hold, participant
// create/flip, and the pop-when-full inline start. Returns the full payload.
function buildJoinTournamentCore(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const tournamentModel = dependencies.Tournament || Tournament;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  // Holds use the balance-guarded atomic debit (ensureUserCanAfford is only a
  // fast-fail pre-check); an injected awardCoins fake still takes both roles.
  const holdCoinsFn =
    dependencies.awardCoins ||
    buildAtomicHoldFn({ ErrorClass: TournamentError, code: "INSUFFICIENT_COINS" });
  const compatibilityEvents = dependencies.eventBus || eventBus;
  const settings = dependencies.appSettings || appSettings;
  const now = dependencies.now || (() => new Date());
  const rng = dependencies.rng;
  const stepsModel = dependencies.Steps;

  // mode: "public" | "share" | "invite"
  return async function joinTournamentCore({
    userId,
    tournamentId = null,
    shareToken = null,
    mode,
    accept = true,
    clientFeatures = null,
    supportsCharacters = false,
    supportsRemoteAssets = false,
  }) {
    if (!clientSupportsTournaments(clientFeatures)) {
      throw new TournamentError(
        "Update the app to join tournaments",
        403,
        "UPDATE_REQUIRED"
      );
    }
    const enabled = await settings.getFlag("tournamentsEnabled");
    if (!enabled) {
      throw new TournamentError(
        "Tournaments are temporarily disabled",
        403,
        "FEATURE_DISABLED"
      );
    }

    // Resolve the tournament id (share token -> id) up front.
    let resolvedId = tournamentId;
    if (mode === "share") {
      const t = await tournamentModel.findByShareToken(shareToken);
      // 404 (not leaking existence) when the token resolves to nothing.
      if (!t) throw new TournamentError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");
      resolvedId = t.id;
    }
    if (!resolvedId) {
      throw new TournamentError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");
    }

    const { deferred } = await withTournamentLock(
      resolvedId,
      async (tx, def, tournament) => {
        if (!tournament) {
          throw new TournamentError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");
        }

        // Decline branch (invite mode only).
        if (mode === "invite" && accept === false) {
          const existing = await tx.tournamentParticipant.findUnique({
            where: {
              tournamentId_userId: { tournamentId: resolvedId, userId },
            },
          });
          if (!existing || existing.status === "DECLINED") {
            throw new TournamentError("You were not invited", 403, "NOT_INVITED");
          }
          if (existing.status === "ACCEPTED") {
            throw new TournamentError("You already responded", 409, "ALREADY_RESPONDED");
          }
          await tx.tournamentParticipant.update({
            where: { id: existing.id },
            data: { status: "DECLINED" },
          });
          return; // decline never starts anything
        }

        if (tournament.status !== "PENDING") {
          throw new TournamentError(
            "This tournament has already started",
            409,
            "TOURNAMENT_NOT_PENDING"
          );
        }

        // Access gating per mode. Share join bypasses isPublic (the token is the
        // invite); public join requires isPublic; invite-accept requires an
        // INVITED row.
        const existing = await tx.tournamentParticipant.findUnique({
          where: {
            tournamentId_userId: { tournamentId: resolvedId, userId },
          },
        });

        if (mode === "invite") {
          if (!existing || existing.status === "DECLINED") {
            throw new TournamentError("You were not invited", 403, "NOT_INVITED");
          }
          if (existing.status === "ACCEPTED") {
            throw new TournamentError("You already responded", 409, "ALREADY_RESPONDED");
          }
        } else {
          if (existing && existing.status === "ACCEPTED") {
            throw new TournamentError("You are already in this tournament", 409, "ALREADY_JOINED");
          }
          if (mode === "public" && !tournament.isPublic) {
            throw new TournamentError("This tournament is not public", 403, "NOT_PUBLIC");
          }
        }

        // D12: featured mint-farming guard. On any join into a seeded tournament,
        // reject if the user is still ALIVE in ANOTHER bracket of the SAME seed.
        if (tournament.seedId) {
          const aliveElsewhere = await tx.tournamentParticipant.findFirst({
            where: {
              userId,
              status: "ACCEPTED",
              eliminatedInRound: null,
              tournamentId: { not: resolvedId },
              tournament: {
                seedId: tournament.seedId,
                status: { in: ["PENDING", "ACTIVE"] },
              },
            },
            select: { id: true },
          });
          if (aliveElsewhere) {
            throw new TournamentError(
              "You're already in this featured tournament. Finish it first",
              409,
              "ALREADY_IN_FEATURED"
            );
          }
        }

        // Capacity: ACCEPTED-only, excluding this user's own (possibly INVITED/
        // DECLINED) row.
        const acceptedCount = await tx.tournamentParticipant.count({
          where: {
            tournamentId: resolvedId,
            status: "ACCEPTED",
            userId: { not: userId },
          },
        });
        if (acceptedCount >= tournament.bracketSize) {
          throw new TournamentError("This tournament is full", 409, "TOURNAMENT_FULL");
        }

        // Buy-in hold. On a rejoin from DECLINED the version was already bumped
        // at refund time, so re-hold uses the CURRENT counter.
        // App-funded brackets never charge to enter (the row's fundedPrize flag,
        // not the feature flag, is the authority).
        const buyIn =
          tournament.fundedPrize === true ? 0 : tournament.buyInAmount || 0;
        const prizeStamp = resolveTournamentPrizeStamp(tournament);
        const fundedExposureStamp =
          tournament.fundedPrize === true && !tournament.seedId
            ? computeTournamentExposureStamp({
                bracketSize: tournament.bracketSize,
                totalRounds: tournament.totalRounds,
                matchupDurationDays: tournament.matchupDurationDays,
                prizeCoinUnit: prizeStamp.prizeCoinUnit,
                tournamentChampionMaxCoins:
                  prizeStamp.tournamentChampionMaxCoins,
              })
            : null;
        if (fundedExposureStamp) {
          await reserveFundedExposure({
            tx,
            userId,
            stamp: fundedExposureStamp,
            competition: { tournamentId: resolvedId },
            // This branch only runs for non-seeded user-funded tournaments.
            enforceLimits: false,
            enforceMembershipLimit: tournament.creatorId != null,
          });
          await tx.$queryRaw`
            SELECT id FROM tournaments WHERE id = ${resolvedId} FOR UPDATE
          `;
        }
        const version = existing ? existing.buyInVersion || 0 : 0;
        if (buyIn > 0) {
          await ensureUserCanAfford({
            userModel: {
              findById: (id) => tx.user.findUnique({ where: { id } }),
            },
            userId,
            amount: buyIn,
            ErrorClass: TournamentError,
            code: "INSUFFICIENT_COINS",
          });
        }

        // Create or flip the participant to ACCEPTED with a fresh joinedAt (the
        // D3 tiebreak key reflects the latest entry).
        if (existing) {
          await tx.tournamentParticipant.update({
            where: { id: existing.id },
            data: {
              status: "ACCEPTED",
              buyInAmount: buyIn,
              buyInStatus: buyIn > 0 ? "HELD" : "NONE",
              joinedAt: now(),
              ...(fundedExposureStamp
                ? {
                    fundedExposureMillicoins:
                      fundedExposureStamp.exposureMillicoins,
                    fundedExposureRateMillicoinsPerDay:
                      fundedExposureStamp.exposureRateMillicoinsPerDay,
                  }
                : {}),
            },
          });
        } else {
          await tx.tournamentParticipant.create({
            data: {
              tournamentId: resolvedId,
              userId,
              status: "ACCEPTED",
              buyInAmount: buyIn,
              buyInStatus: buyIn > 0 ? "HELD" : "NONE",
              buyInVersion: 0,
              joinedAt: now(),
              ...(fundedExposureStamp
                ? {
                    fundedExposureMillicoins:
                      fundedExposureStamp.exposureMillicoins,
                    fundedExposureRateMillicoinsPerDay:
                      fundedExposureStamp.exposureRateMillicoinsPerDay,
                  }
                : {}),
            },
          });
        }

        if (buyIn > 0) {
          await reserveTournamentBuyIn({
            awardCoinsFn: holdCoinsFn,
            userId,
            tournamentId: resolvedId,
            amount: buyIn,
            version,
          });
        }

        // Pop-when-full (D9): the join that fills the last slot starts the
        // tournament INLINE inside this same lock (seeding + round 1 + pushes).
        const newAccepted = acceptedCount + 1;
        if (newAccepted === tournament.bracketSize) {
          const startEvents = await runTournamentStart({
            tx,
            tournament,
            now,
            rng,
            stepsModel,
          });
          if (startEvents) def.push(...startEvents);
        }
      },
      {
        prisma: db,
        resolveUserIds: async (tx) => {
          const participants = await tx.tournamentParticipant.findMany({
            where: { tournamentId: resolvedId, status: "ACCEPTED" },
            select: { userId: true },
          });
          return [userId, ...participants.map((row) => row.userId)];
        },
      }
    );

    for (const payload of deferred) {
      compatibilityEvents?.emit(payload.type, payload);
    }

    const full = await tournamentModel.findById(resolvedId);
    return serializeTournamentPayload(full, userId, {
      supportsCharacters,
      supportsRemoteAssets,
    });
  };
}

module.exports = { buildJoinTournamentCore };
