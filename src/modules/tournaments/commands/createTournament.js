const { prisma: defaultPrisma } = require("../../../db");
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
const { validatePowerupConfig } = require("../../races/services/validateRaceConfig");
const {
  validateTournamentName,
  validateBracketSize,
  validateMatchupDuration,
  validateTournamentBuyIn,
  totalRoundsFor,
  clientSupportsTournaments,
  TOURNAMENTS_FEATURE,
} = require("../constants/tournaments");
const {
  serializeTournamentPayload,
} = require("../queries/serializeTournament");

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

  return async function createTournament({
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
    const buyIn = validateTournamentBuyIn({
      bracketSize: size,
      buyInAmount,
      ErrorClass: TournamentError,
    });
    validatePowerupConfig({
      powerupsEnabled,
      powerupStepInterval,
      ErrorClass: TournamentError,
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

    const tournament = await tournamentModel.create({
      creatorId: userId,
      name: trimmedName,
      status: "PENDING",
      bracketSize: size,
      matchupDurationDays: durationDays,
      buyInAmount: buyIn,
      potCoins: 0,
      powerupsEnabled: !!powerupsEnabled,
      powerupStepInterval: powerupsEnabled ? powerupStepInterval : null,
      isPublic: !!isPublic,
      shareToken: mintToken(),
      timezone: normalizeTimeZone(timeZone),
      currentRound: 0,
      totalRounds: totalRoundsFor(size),
      // Creator inserted ACCEPTED with the buy-in held.
      participants: {
        create: {
          userId,
          status: "ACCEPTED",
          buyInAmount: buyIn,
          buyInStatus: buyIn > 0 ? "HELD" : "NONE",
          buyInVersion: 0,
          joinedAt: new Date(),
        },
      },
    });

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
        events.emit("TOURNAMENT_INVITE_SENT", {
          tournamentId: tournament.id,
          tournamentName: tournament.name,
          creatorUserId: userId,
          userId: inviteeId,
          bracketSize: size,
          potCoins: size * buyIn,
          buyInAmount: buyIn,
        });
      }
    }

    const full = await tournamentModel.findById(tournament.id);
    return serializeTournamentPayload(full, userId, { supportsCharacters });
  };
}

const createTournament = buildCreateTournament();

module.exports = { buildCreateTournament, createTournament };
