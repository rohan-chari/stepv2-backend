const { Race } = require("../models/race");
const { compareParticipantsForPlacement } = require("../placementOrder");
const { collectRaceIllusions } = require("../services/raceIllusions");
const {
  buildViewerDisplayPlacementMap,
} = require("../services/viewerDisplayPlacements");
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
    privacySafeDisplayRanks = false,
  }) {
    if (!TARGETED_TYPES.has(powerupType)) return null;

    // Keep a compatibility fallback for injected/older model seams, but the
    // production model has a narrow persisted target-context query. Bounty does
    // not need the full progress payload here: persisted participant totals,
    // active illusions, and the viewer's inventory are sufficient to build the
    // action-time picker. This avoids loading the full progress/accessory graph.
    if (
      powerupType === "BOUNTY" &&
      typeof raceModel.findPowerupTargetContext !== "function"
    ) {
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
          totalSteps: participant.stealthed === true
            ? null
            : participant.totalSteps ?? 0,
          placement: participant.placement ?? null,
          ...(privacySafeDisplayRanks
            ? { displayPlacement: participant.displayPlacement ?? null }
            : {}),
        })),
        ...(privacySafeDisplayRanks
          ? {
              placementPrivacyActive:
                progress.placementPrivacyActive === true,
            }
          : {}),
        powerupData: {
          powerupSlots: progress.powerupData.powerupSlots ?? 3,
          inventory: Array.isArray(progress.powerupData.inventory)
            ? progress.powerupData.inventory
            : [],
          queuedBoxCount: progress.powerupData.queuedBoxCount ?? 0,
          myPlacement: progress.myPlacement ?? null,
          ...(privacySafeDisplayRanks
            ? {
                myDisplayPlacement: progress.myDisplayPlacement ?? null,
              }
            : {}),
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
    const { stealthedUserIds, viewerIsDetoured } = collectRaceIllusions(
      effects,
      userId,
      now().getTime()
    );
    const ordered = [...race.participants].sort(compareParticipantsForPlacement);
    const myIndex = ordered.findIndex((row) => row.userId === userId);
    const maskedUserIds = new Set(
      ordered
        .filter(
          (participant) =>
            participant.userId !== userId &&
            participant.finishedAt == null &&
            stealthedUserIds.has(participant.userId)
        )
        .map((participant) => participant.userId)
    );
    const placementPrivacyActive = viewerIsDetoured || maskedUserIds.size > 0;
    const displayPlacementByUserId = viewerIsDetoured
      ? new Map()
      : buildViewerDisplayPlacementMap(
          ordered.map((participant, index) => ({
            userId: participant.userId,
            placement: participant.placement ?? index + 1,
          })),
          maskedUserIds
        );
    const presentationOrdered = [...ordered].sort((left, right) => {
      const leftMasked = viewerIsDetoured || maskedUserIds.has(left.userId);
      const rightMasked = viewerIsDetoured || maskedUserIds.has(right.userId);
      if (leftMasked !== rightMasked) return leftMasked ? -1 : 1;
      if (leftMasked) return String(left.userId).localeCompare(String(right.userId));
      return ordered.indexOf(left) - ordered.indexOf(right);
    });
    const slotRows = inventoryRows.filter(
      (row) => row.status === "HELD" || row.status === "MYSTERY_BOX"
    );

    return {
      contract: "race-powerup-target-context-v1",
      ...(privacySafeDisplayRanks ? { placementPrivacyActive } : {}),
      participants: presentationOrdered.map((participant) => {
        const index = ordered.indexOf(participant);
        const actuallyStealthed =
          participant.userId !== userId &&
          participant.finishedAt == null &&
          stealthedUserIds.has(participant.userId);
        const masked = viewerIsDetoured || actuallyStealthed;
        return {
          userId: participant.userId,
          displayName: masked
            ? "???"
            : participant.user?.displayName ?? null,
          profilePhotoUrl: masked
            ? null
            : participant.user?.profilePhotoUrl ?? null,
          ...(powerupType === "BOUNTY"
            ? { totalSteps: masked ? null : participant.totalSteps ?? 0 }
            : {}),
          placement: masked || (!privacySafeDisplayRanks && placementPrivacyActive)
            ? null
            : participant.placement ?? index + 1,
          ...(privacySafeDisplayRanks
            ? {
                displayPlacement: masked
                  ? null
                  : displayPlacementByUserId.get(participant.userId) ?? null,
              }
            : {}),
          team: participant.team ?? null,
          forfeitedAt: participant.forfeitedAt ?? null,
          // Keep the existing presentation/privacy guard for Detour while
          // exposing offensive eligibility through a separate additive field.
          stealthed: masked,
          ...(viewerIsDetoured && !actuallyStealthed
            ? { targetable: true }
            : {}),
          // Additive targeting metadata. Older clients ignore this field;
          // newer clients can avoid presenting a target that the use endpoint
          // would reject for an already-active Leg Cramp.
          legCramped: effects.some(
            (effect) =>
              effect.targetParticipantId === participant.id &&
              effect.type === "LEG_CRAMP"
          ),
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
        myPlacement:
          viewerIsDetoured || (!privacySafeDisplayRanks && placementPrivacyActive)
            ? null
            : myIndex >= 0
              ? (mine.placement ?? myIndex + 1)
              : null,
        ...(privacySafeDisplayRanks
          ? {
              myDisplayPlacement: viewerIsDetoured
                ? null
                : displayPlacementByUserId.get(userId) ?? null,
            }
          : {}),
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
