const { Race } = require("../models/race");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { RacePowerup } = require("../../powerups/models/racePowerup");

function routeError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isStealable(powerup) {
  return Boolean(
    powerup &&
      (!powerup.status || powerup.status === "HELD") &&
      powerup.type !== "SNEAKY_SWAP" &&
      powerup.type !== "MYSTERY_BOX"
  );
}

function buildGetSneakySwapTargets(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const effectModel = dependencies.RaceActiveEffect || RaceActiveEffect;
  const powerupModel = dependencies.RacePowerup || RacePowerup;

  return async function getSneakySwapTargets(userId, raceId) {
    const race = typeof raceModel.findSneakySwapTargetContext === "function"
      ? await raceModel.findSneakySwapTargetContext(raceId)
      : await raceModel.findById(raceId);
    if (!race || race.status !== "ACTIVE") {
      throw routeError("Race is not active", 400);
    }

    const me = race.participants.find(
      (participant) =>
        participant.userId === userId && participant.status === "ACCEPTED"
    );
    if (!me) {
      throw routeError("You are not an active participant in this race", 403);
    }

    const candidates = race.participants.filter(
      (participant) =>
        participant.userId !== userId &&
        participant.status === "ACCEPTED" &&
        !participant.finishedAt &&
        !participant.forfeitedAt &&
        (!race.isTeamRace ||
          (participant.team != null && participant.team !== me.team))
    );
    const candidateIds = candidates.map((participant) => participant.id);
    const hasBulkEffects =
      typeof effectModel.findActiveByTypeForParticipants === "function";
    const hasBulkInventory =
      typeof powerupModel.findInventoryForParticipants === "function";
    const [stealthEffects, heldInventory] = await Promise.all([
      hasBulkEffects
        ? effectModel.findActiveByTypeForParticipants(
            candidateIds,
            "STEALTH_MODE"
          )
        : Promise.all(
            candidateIds.map((id) =>
              effectModel.findActiveByTypeForParticipant(id, "STEALTH_MODE")
            )
          ).then((rows) =>
            rows.flatMap((row, index) =>
              row ? [{ ...row, targetParticipantId: candidateIds[index] }] : []
            )
          ),
      hasBulkInventory
        ? powerupModel.findInventoryForParticipants(candidateIds, ["HELD"])
        : Promise.all(
            candidateIds.map((id) => powerupModel.findHeldByParticipant(id))
          ).then((lists) =>
            lists.flatMap((list, index) =>
              list.map((row) => ({
                ...row,
                participantId: candidateIds[index],
              }))
            )
          ),
    ]);

    const stealthed = new Set(
      (stealthEffects || []).map((effect) => effect.targetParticipantId)
    );
    const hasStealable = new Set();
    for (const powerup of heldInventory || []) {
      if (isStealable(powerup)) {
        if (powerup.participantId) hasStealable.add(powerup.participantId);
      }
    }

    return {
      targets: candidates
        .filter(
          (participant) =>
            !stealthed.has(participant.id) && hasStealable.has(participant.id)
        )
        .map((participant) => ({
          userId: participant.userId,
          displayName: participant.user
            ? participant.user.displayName
            : null,
        })),
    };
  };
}

const getSneakySwapTargets = buildGetSneakySwapTargets();

module.exports = {
  buildGetSneakySwapTargets,
  getSneakySwapTargets,
};
