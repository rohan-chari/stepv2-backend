const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { RacePowerup } = require("../../powerups/models/racePowerup");

const EMPTY_DISABLED = Object.freeze({
  enabled: false,
  newMysteryBoxes: [],
  newQueuedBoxes: 0,
  queuedBoxCount: 0,
});

function buildRepairRacePowerupInventory(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const powerupModel = dependencies.RacePowerup || RacePowerup;

  return async function repairRacePowerupInventory({
    raceId,
    userId,
    race: providedRace,
    participant: providedParticipant,
    refresh = false,
  } = {}) {
    let race = providedRace;
    let participant = providedParticipant;

    if (refresh || !race || !participant) {
      if (typeof raceModel.findPowerupRepairContext === "function") {
        const context = await raceModel.findPowerupRepairContext(raceId, userId);
        race = context;
        participant = context?.participants?.[0] || null;
      }
    }

    if (
      !race ||
      race.status !== "ACTIVE" ||
      race.powerupsEnabled !== true ||
      !(race.powerupStepInterval > 0)
    ) {
      return { ...EMPTY_DISABLED };
    }

    if (!participant || participant.status !== "ACCEPTED") {
      return {
        enabled: true,
        newMysteryBoxes: [],
        newQueuedBoxes: 0,
        queuedBoxCount: 0,
      };
    }

    const bonus = participant.bonusSteps || 0;
    const maxBonus = participant.maxBonusSteps || 0;
    if (bonus > maxBonus) {
      await participantModel.updateMaxBonusSteps(participant.id, bonus);
    }

    const occupiedCount = await powerupModel.countOccupiedSlots(participant.id);
    const openSlots = Math.max(
      0,
      (participant.powerupSlots || 3) - occupiedCount
    );
    if (openSlots > 0) {
      const queued = await powerupModel.findQueuedByParticipant(participant.id);
      for (const box of queued.slice(0, openSlots)) {
        await powerupModel.update(box.id, { status: "MYSTERY_BOX" });
      }
    }

    const queuedBoxCount = await powerupModel.countQueuedByParticipant(
      participant.id
    );
    return {
      enabled: true,
      newMysteryBoxes: [],
      newQueuedBoxes: 0,
      queuedBoxCount,
    };
  };
}

const repairRacePowerupInventory = buildRepairRacePowerupInventory();

module.exports = {
  buildRepairRacePowerupInventory,
  repairRacePowerupInventory,
};
