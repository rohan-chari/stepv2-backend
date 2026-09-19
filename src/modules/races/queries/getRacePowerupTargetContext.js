const { Race } = require("../models/race");
const { compareParticipantsForPlacement } = require("../placementOrder");
const { collectRaceIllusions } = require("../services/raceIllusions");
const {
  buildViewerDisplayPlacementMap,
} = require("../services/viewerDisplayPlacements");
const defaultDisplayCache = require("../services/raceOpenDisplayCache");
const defaultUserPresentationCache = require("../../social/services/userPresentationCache");
const {
  eligiblePowerupTargets,
} = require("../services/powerupTargetEligibility");
const {
  stealableParticipants: defaultStealableParticipants,
  participantInventorySummary: defaultParticipantInventorySummary,
} = require("../services/stealableTargetCache");

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
  const displayCache = dependencies.raceOpenDisplayCache || defaultDisplayCache;
  const userPresentationCache =
    dependencies.userPresentationCache || defaultUserPresentationCache;
  const stealableParticipants =
    dependencies.stealableParticipants || defaultStealableParticipants;
  const participantInventorySummary =
    dependencies.participantInventorySummary || defaultParticipantInventorySummary;
  const now = dependencies.now || (() => new Date());

  return async function getRacePowerupTargetContext({
    userId,
    raceId,
    powerupType,
    loadBountyProgress,
    privacySafeDisplayRanks = false,
  }) {
    if (!TARGETED_TYPES.has(powerupType)) return null;

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
        contract: "race-powerup-target-context-v2",
        participants: Array.isArray(progress.participants)
          ? progress.participants
          : [],
        powerupData: {
          powerupSlots: progress.powerupData.powerupSlots ?? 3,
          inventory: Array.isArray(progress.powerupData.inventory)
            ? progress.powerupData.inventory
            : [],
          queuedBoxCount: progress.powerupData.queuedBoxCount ?? 0,
          myPlacement: progress.myPlacement ?? null,
          ...(privacySafeDisplayRanks
            ? { myDisplayPlacement: progress.myDisplayPlacement ?? null }
            : {}),
        },
      };
    }

    let race;
    if (dependencies.Race) {
      race = await raceModel.findPowerupTargetContext(raceId);
    } else {
      const core = await displayCache.core(raceId);
      race = core
        ? await displayCache.fullDisplayContext(raceId, { race: core, userId })
        : null;
      if (race?.participants?.length) {
        const presentations = await userPresentationCache.getMany(
          race.participants.map((participant) => participant.userId),
          true
        );
        race.participants = race.participants.map((participant) => ({
          ...participant,
          user: presentations.get(participant.userId) || null,
        }));
      }
    }
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

    const effectsPromise =
      typeof displayCache.effects === "function"
        ? displayCache.effects(raceId)
        : Promise.resolve([]);
    const inventoryPromise = participantInventorySummary(mine.id);
    const stealablePromise =
      powerupType === "SNEAKY_SWAP"
        ? stealableParticipants(
            raceId,
            race.participants.map((participant) => participant.id)
          )
        : Promise.resolve(new Set());

    const [effects, inventorySummary, stealableParticipantIds] = await Promise.all([
      effectsPromise,
      inventoryPromise,
      stealablePromise,
    ]);

    const eligible = eligiblePowerupTargets({
      powerupType,
      participants: race.participants,
      viewerUserId: userId,
      effects,
      stealableParticipantIds,
      now: now(),
    });

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
    const eligibleIds = new Set(eligible.map((participant) => participant.id));
    const presentationOrdered = [...ordered]
      .filter((participant) => eligibleIds.has(participant.id))
      .sort((left, right) => {
        const leftMasked = viewerIsDetoured || maskedUserIds.has(left.userId);
        const rightMasked = viewerIsDetoured || maskedUserIds.has(right.userId);
        if (leftMasked !== rightMasked) return leftMasked ? -1 : 1;
        if (leftMasked) {
          return String(left.userId).localeCompare(String(right.userId));
        }
        return ordered.indexOf(left) - ordered.indexOf(right);
      });
    return {
      contract: "race-powerup-target-context-v2",
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
          placement:
            masked || (!privacySafeDisplayRanks && placementPrivacyActive)
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
          stealthed: masked,
          ...(viewerIsDetoured && !actuallyStealthed
            ? { targetable: true }
            : {}),
        };
      }),
      powerupData: {
        powerupSlots: mine.powerupSlots ?? 3,
        inventory: Array.isArray(inventorySummary?.inventory)
          ? inventorySummary.inventory
          : [],
        queuedBoxCount: inventorySummary?.queuedBoxCount ?? 0,
        myPlacement:
          viewerIsDetoured ||
          (!privacySafeDisplayRanks && placementPrivacyActive)
            ? null
            : myIndex >= 0
              ? mine.placement ?? myIndex + 1
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
