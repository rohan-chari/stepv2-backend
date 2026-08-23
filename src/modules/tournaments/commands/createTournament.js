const {
  prisma: defaultPrisma,
  deferUntilAfterCommit,
  runInPrismaTransaction,
} = require("../../../db");
const { Tournament } = require("../models/tournament");
const { Friendship } = require("../../social");
const { User } = require("../../users");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const { eventBus } = require("../../../shared/events/eventBus");
const { appSettings } = require("../../../shared/config/appSettings");
const { generateShareToken } = require("../../../shared/lib/shareToken");
const { TournamentError } = require("../services/tournamentErrors");
const {
  buildAtomicHoldFn,
  ensureUserCanAfford,
  reserveTournamentBuyIn,
} = require("../services/tournamentBuyIns");
const { normalizePowerupConfig } = require("../../races/services/validateRaceConfig");
const {
  validateTournamentName,
  validateBracketSize,
  validateMatchupDuration,
  validateTournamentBuyIn,
  totalRoundsFor,
  clientSupportsTournaments,
  TOURNAMENTS_FEATURE,
} = require("../constants/tournaments");
const { computePrizePool } = require("../../../shared/economy/prizePool");
const {
  serializeTournamentPayload,
} = require("../queries/serializeTournament");
const {
  computeTournamentExposureStamp,
  newTournamentPrizeStamp,
  reserveFundedExposure,
  lockFundedExposureUsers,
} = require("../../races/services/fundedExposure");

function normalizeTimeZone(value) {
  if (!value || typeof value !== "string") return null;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

function buildCreateTournament(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const tournamentModel = dependencies.Tournament || Tournament;
  const friendshipModel = dependencies.Friendship || Friendship;
  const userModel = dependencies.User || User;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  // Holds use the balance-guarded atomic debit (ensureUserCanAfford is only a
  // fast-fail pre-check); an injected awardCoins fake still takes both roles.
  const holdCoinsFn =
    dependencies.awardCoins ||
    buildAtomicHoldFn({ ErrorClass: TournamentError, code: "INSUFFICIENT_COINS" });
  const events = dependencies.eventBus || eventBus;
  const settings = dependencies.appSettings || appSettings;
  const mintToken = dependencies.generateShareToken || generateShareToken;
  const usesDefaultPersistence =
    !dependencies.prisma &&
    !dependencies.Tournament &&
    !dependencies.User;

  const createTournamentCore = async function createTournament({
    userId,
    name,
    bracketSize,
    matchupDurationDays,
    buyInAmount = 0,
    powerupsEnabled = false,
    powerupStepInterval,
    isPublic = false,
    inviteeIds = [],
    timeZone = null,
    clientFeatures = null,
    supportsCharacters = false,
    supportsRemoteAssets = false,
  }) {
    if (!clientSupportsTournaments(clientFeatures)) {
      throw new TournamentError(
        "Update the app to create tournaments",
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

    const trimmedName = validateTournamentName(name, TournamentError);
    const size = validateBracketSize(bracketSize, TournamentError);
    const durationDays = validateMatchupDuration(
      matchupDurationDays,
      TournamentError
    );
    // App-funded bracket pools: while the flag is on, entry is FREE and a frozen
    // client's buyInAmount is accepted and IGNORED (coerced to 0 BEFORE
    // validation, so an amount above the legacy per-bracket ceiling can't 400 an
    // un-updated binary out of creating a bracket).
    const fundedPrizePools = await settings.getFlag("fundedPrizePoolsEnabled");
    const payoutRoundingV1Enabled = await settings.getFlag(
      "payoutRoundingV1Enabled",
    );
    const buyIn = validateTournamentBuyIn({
      bracketSize: size,
      buyInAmount: fundedPrizePools ? 0 : buyInAmount,
      ErrorClass: TournamentError,
    });
    // Server-decided interval (2,000 always); a frozen client's
    // powerupStepInterval is accepted and IGNORED, never a 400. Bracket matchup
    // races copy this value in tournamentRounds.js, so they inherit it too.
    const normalizedPowerupStepInterval = normalizePowerupConfig({
      powerupsEnabled,
    });
    const totalRounds = totalRoundsFor(size);
    const prizeStamp = newTournamentPrizeStamp();
    const fundedExposureStamp = computeTournamentExposureStamp({
      bracketSize: size,
      totalRounds,
      matchupDurationDays: durationDays,
      prizeCoinUnit: prizeStamp.prizeCoinUnit,
      tournamentChampionMaxCoins:
        prizeStamp.tournamentChampionMaxCoins,
    });

    await ensureUserCanAfford({
      userModel,
      userId,
      amount: buyIn,
      ErrorClass: TournamentError,
      code: "INSUFFICIENT_COINS",
    });

    // Validate invitees: accepted friends whose sticky clientFeatures advertise
    // the tournaments token (a frozen old build could receive the push but never
    // see/answer the invite). Over-inviting beyond capacity is allowed.
    const uniqueInvitees = [...new Set(inviteeIds || [])].filter(
      (id) => id && id !== userId
    );
    for (const inviteeId of uniqueInvitees) {
      const friendship = await friendshipModel.findBetweenUsers(
        userId,
        inviteeId
      );
      if (!friendship || friendship.status !== "ACCEPTED") {
        throw new TournamentError(
          "You can only invite accepted friends",
          403,
          "NOT_INVITED"
        );
      }
      const invitee = await userModel.findById(inviteeId);
      const features = (invitee && invitee.clientFeatures) || [];
      if (!features.includes(TOURNAMENTS_FEATURE)) {
        const friendName = (invitee && invitee.displayName) || "That friend";
        throw new TournamentError(
          `${friendName} needs to update the app to join tournaments`,
          400,
          "INVITEE_NEEDS_UPDATE"
        );
      }
    }

    if (usesDefaultPersistence) {
      await lockFundedExposureUsers(db, [userId, ...uniqueInvitees]);
    }
    if (fundedPrizePools === true && usesDefaultPersistence) {
      await reserveFundedExposure({
        tx: db,
        userId,
        stamp: fundedExposureStamp,
        // User-created funded tournaments have no aggregate exposure cap.
        // Seeded tournament callers retain their own admission policy.
        enforceLimits: false,
      });
    }

    const tournamentData = {
      creatorId: userId,
      name: trimmedName,
      status: "PENDING",
      bracketSize: size,
      matchupDurationDays: durationDays,
      buyInAmount: buyIn,
      potCoins: 0,
      // Row-level discriminator: this bracket's champion prize is app-minted and
      // stays that way even if the flag is flipped back off mid-bracket.
      fundedPrize: fundedPrizePools === true,
      prizeCalculationVersion: prizeStamp.prizeCalculationVersion,
      prizeCoinUnit:
        prizeStamp.prizeCalculationVersion >= 2
          ? prizeStamp.prizeCoinUnit
          : null,
      tournamentChampionMaxCoins:
        prizeStamp.prizeCalculationVersion >= 2
          ? prizeStamp.tournamentChampionMaxCoins
          : null,
      payoutRoundingVersion: fundedPrizePools === true && payoutRoundingV1Enabled === true ? 1 : 0,
      powerupsEnabled: !!powerupsEnabled,
      powerupStepInterval: normalizedPowerupStepInterval,
      isPublic: !!isPublic,
      shareToken: mintToken(),
      timezone: normalizeTimeZone(timeZone),
      currentRound: 0,
      totalRounds,
      // Creator inserted ACCEPTED with the buy-in held.
      participants: {
        create: {
          userId,
          status: "ACCEPTED",
          buyInAmount: buyIn,
          buyInStatus: buyIn > 0 ? "HELD" : "NONE",
          buyInVersion: 0,
          joinedAt: new Date(),
          ...(fundedPrizePools === true
            ? {
                fundedExposureMillicoins:
                  fundedExposureStamp.exposureMillicoins,
                fundedExposureRateMillicoinsPerDay:
                  fundedExposureStamp.exposureRateMillicoinsPerDay,
              }
            : {}),
        },
      },
    };
    // The model's legacy create seam hydrates every relation. Inside an
    // interactive adapter-pg transaction Prisma fans those relation reads out
    // concurrently on one client. Production only needs the durable id/name
    // until commit; the public payload is hydrated below after the transaction.
    const tournament = usesDefaultPersistence
      ? await db.tournament.create({
          data: tournamentData,
          select: { id: true, name: true },
        })
      : await tournamentModel.create(tournamentData);

    await reserveTournamentBuyIn({
      awardCoinsFn: holdCoinsFn,
      userId,
      tournamentId: tournament.id,
      amount: buyIn,
      version: 0,
    });

    if (uniqueInvitees.length > 0) {
      await db.tournamentParticipant.createMany({
        data: uniqueInvitees.map((inviteeId) => ({
          tournamentId: tournament.id,
          userId: inviteeId,
          status: "INVITED",
        })),
        skipDuplicates: true,
      });
      for (const inviteeId of uniqueInvitees) {
        await deferUntilAfterCommit(() =>
          events.emit("TOURNAMENT_INVITE_SENT", {
            tournamentId: tournament.id,
            tournamentName: tournament.name,
            creatorUserId: userId,
            userId: inviteeId,
            bracketSize: size,
            // Funded brackets quote the pool a full bracket mints (see
            // inviteToTournament); paid brackets quote size x buy-in as before.
            potCoins: fundedPrizePools
              ? computePrizePool({
                  playerCount: size,
                  durationDays: totalRounds * durationDays,
                  max: prizeStamp.tournamentChampionMaxCoins,
                  unit: prizeStamp.prizeCoinUnit,
                })
              : size * buyIn,
            buyInAmount: buyIn,
          })
        );
      }
    }

    if (usesDefaultPersistence) return { id: tournament.id };
    const full = await tournamentModel.findById(tournament.id);
    return serializeTournamentPayload(full, userId, {
      supportsCharacters,
      supportsRemoteAssets,
    });
  };

  return async function createTournament(args) {
    if (!usesDefaultPersistence) return createTournamentCore(args);
    const durable = await runInPrismaTransaction(() => createTournamentCore(args), {
      maxWait: 5_000,
      timeout: 30_000,
    });
    const full = await tournamentModel.findById(durable.id);
    return serializeTournamentPayload(full, args.userId, {
      supportsCharacters: args.supportsCharacters,
      supportsRemoteAssets: args.supportsRemoteAssets,
    });
  };
}

const createTournament = buildCreateTournament();

module.exports = { buildCreateTournament, createTournament };
