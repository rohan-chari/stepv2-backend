const { Race } = require("../models/race");
const { RacePowerup } = require("../models/racePowerup");
const { rollPowerup: defaultRollPowerup } = require("../commands/rollPowerup");

function getCurrentSteps(participant) {
  if (!participant) return 0;
  if (participant.finishedAt) {
    return participant.finishTotalSteps ?? participant.totalSteps ?? 0;
  }
  return participant.totalSteps ?? 0;
}

function buildSyncRacePowerupState(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const rollPowerup = dependencies.rollPowerup || defaultRollPowerup;

  return async function syncRacePowerupState({ raceId, userId }) {
    const race = await raceModel.findById(raceId);
    if (
      !race ||
      race.status !== "ACTIVE" ||
      !race.powerupsEnabled ||
      !race.powerupStepInterval
    ) {
      return {
        enabled: false,
        newMysteryBoxes: [],
        newQueuedBoxes: 0,
        queuedBoxCount: 0,
      };
    }

    let participant = race.participants.find((entry) => entry.userId === userId);
    if (!participant || participant.status !== "ACCEPTED") {
      return {
        enabled: true,
        newMysteryBoxes: [],
        newQueuedBoxes: 0,
        queuedBoxCount: 0,
      };
    }

    let rollResults = [];
    const currentSteps = getCurrentSteps(participant);
    if (
      participant.nextBoxAtSteps > 0 &&
      currentSteps >= participant.nextBoxAtSteps
    ) {
      rollResults = await rollPowerup({
        raceId: race.id,
        participantId: participant.id,
        userId: participant.userId,
        currentSteps,
        nextBoxAtSteps: participant.nextBoxAtSteps,
        powerupStepInterval: race.powerupStepInterval,
        displayName: participant.user?.displayName,
        powerupSlots: participant.powerupSlots || 3,
      });

      const refreshedRace = await raceModel.findById(raceId);
      participant = refreshedRace?.participants.find(
        (entry) => entry.userId === userId
      );
      if (!participant) {
        return {
          enabled: true,
          newMysteryBoxes: rollResults
            .filter((result) => result.mysteryBox && !result.queued)
            .map((result) => result.mysteryBox),
          newQueuedBoxes: rollResults.filter((result) => result.queued).length,
          queuedBoxCount: 0,
        };
      }
    }

    const occupiedCount = await powerupModel.countOccupiedSlots(participant.id);
    const openSlots = Math.max(0, (participant.powerupSlots || 3) - occupiedCount);
    if (openSlots > 0) {
      const queuedBoxes = await powerupModel.findQueuedByParticipant(participant.id);
      const toPromote = queuedBoxes.slice(0, openSlots);
      for (const box of toPromote) {
        await powerupModel.update(box.id, { status: "MYSTERY_BOX" });
      }
    }

    const queuedBoxCount = await powerupModel.countQueuedByParticipant(
      participant.id
    );

    return {
      enabled: true,
      newMysteryBoxes: rollResults
        .filter((result) => result.mysteryBox && !result.queued)
        .map((result) => result.mysteryBox),
      newQueuedBoxes: rollResults.filter((result) => result.queued).length,
      queuedBoxCount,
    };
  };
}

const syncRacePowerupState = buildSyncRacePowerupState();

module.exports = {
  buildSyncRacePowerupState,
  syncRacePowerupState,
};
