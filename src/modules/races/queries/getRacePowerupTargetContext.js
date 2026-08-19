const { Race } = require("../models/race");
const { compareParticipantsForPlacement } = require("../placementOrder");
const { collectRaceIllusions } = require("../services/raceIllusions");
const { RaceActiveEffect, RacePowerup } = require("../../powerups");

const TARGETED_TYPES = new Set([
  "LEG_CRAMP",
  "SHORTCUT",
  "WRONG_TURN",
  "DETOUR_SIGN",
  "SNEAKY_SWAP",
  "IMPOSTER",
  "SIGNAL_JAMMER",
  "LEECH",
  "HITCHHIKE",
  "QUICKSAND",
  "DRILL_SERGEANT",
  "BOUNTY",
]);

function domainError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function buildGetRacePowerupTargetContext(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const effectModel = dependencies.RaceActiveEffect || RaceActiveEffect;
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const now = dependencies.now || (() => new Date());

  return async function getRacePowerupTargetContext({
    userId,
    raceId,
    powerupType,
    loadBountyProgress,
  }) {
    if (!TARGETED_TYPES.has(powerupType)) return null;

    // Bounty is the sole picker that needs calculated totals. Reuse the public
    // progress seam so its Redis snapshot/fallback and canonical scoring rules
    // remain the authority; this endpoint only downcasts its wire shape.
    if (powerupType === "BOUNTY") {
      const progress = await loadBountyProgress();
      if (progress?.status !== "ACTIVE") {
        throw domainError("Race is not active", 400, "RACE_NOT_ACTIVE");
      }
      if (!progress?.powerupData || progress.powerupData.enabled !== true) {
        throw domainError(
          "You are not an active participant in this race",
          403,
          "NOT_ACTIVE_PARTICIPANT"
        );
      }
      return {
        contract: "race-powerup-target-context-v1",
        participants: (Array.isArray(progress.participants)
          ? progress.participants
          : []).map((participant) => ({
          userId: participant.userId,
          displayName: participant.displayName,
          profilePhotoUrl: participant.profilePhotoUrl ?? null,
          team: participant.team ?? null,
          forfeitedAt: participant.forfeitedAt ?? null,
          stealthed: participant.stealthed === true,
          totalSteps: participant.totalSteps ?? 0,
        })),
        powerupData: {
          powerupSlots: progress.powerupData.powerupSlots ?? 3,
          inventory: Array.isArray(progress.powerupData.inventory)
            ? progress.powerupData.inventory
            : [],
          queuedBoxCount: progress.powerupData.queuedBoxCount ?? 0,
          myPlacement: progress.myPlacement ?? null,
        },
      };
    }

    const race = await raceModel.findPowerupTargetContext(raceId);
    if (!race) throw domainError("Race not found", 404, "RACE_NOT_FOUND");
    if (race.status !== "ACTIVE") {
      throw domainError("Race is not active", 400, "RACE_NOT_ACTIVE");
    }
    const mine = race.participants.find((row) => row.userId === userId);
    if (!mine || race.powerupsEnabled !== true) {
      throw domainError(
        "You are not an active participant in this race",
        403,
        "NOT_ACTIVE_PARTICIPANT"
      );
    }

    const [effects, inventoryRows] = await Promise.all([
      effectModel.findActiveForRace(raceId),
      powerupModel.findInventoryForParticipants(
        [mine.id],
        ["HELD", "MYSTERY_BOX", "QUEUED"]
      ),
    ]);
    const { stealthedUserIds } = collectRaceIllusions(
      effects,
      userId,
      now().getTime()
    );
    const ordered = [...race.participants].sort(compareParticipantsForPlacement);
    const myIndex = ordered.findIndex((row) => row.userId === userId);
    const slotRows = inventoryRows.filter(
      (row) => row.status === "HELD" || row.status === "MYSTERY_BOX"
    );

    return {
      contract: "race-powerup-target-context-v1",
      participants: race.participants.map((participant) => {
        const stealthed =
          participant.userId !== userId &&
          participant.finishedAt == null &&
          stealthedUserIds.has(participant.userId);
        return {
          userId: participant.userId,
          displayName: stealthed
            ? "???"
            : participant.user?.displayName ?? null,
          profilePhotoUrl: stealthed
            ? null
            : participant.user?.profilePhotoUrl ?? null,
          team: participant.team ?? null,
          forfeitedAt: participant.forfeitedAt ?? null,
          stealthed,
        };
      }),
      powerupData: {
        powerupSlots: mine.powerupSlots ?? 3,
        inventory: slotRows.map((row) => ({
          id: row.id,
          type: row.type,
          rarity: row.rarity,
          status: row.status,
        })),
        queuedBoxCount: inventoryRows.filter((row) => row.status === "QUEUED").length,
        myPlacement: myIndex >= 0 ? myIndex + 1 : null,
      },
    };
  };
}

const getRacePowerupTargetContext = buildGetRacePowerupTargetContext();

module.exports = {
  TARGETED_TYPES,
  buildGetRacePowerupTargetContext,
  getRacePowerupTargetContext,
};
