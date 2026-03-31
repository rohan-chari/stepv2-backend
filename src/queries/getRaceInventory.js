const { Race } = require("../models/race");
const { RacePowerup } = require("../models/racePowerup");

async function getRaceInventory(userId, raceId) {
  const race = await Race.findById(raceId);
  if (!race) {
    const error = new Error("Race not found");
    error.statusCode = 404;
    throw error;
  }

  const myParticipant = race.participants.find((p) => p.userId === userId);
  if (!myParticipant) {
    const error = new Error("You are not a participant in this race");
    error.statusCode = 403;
    throw error;
  }

  const held = await RacePowerup.findHeldByParticipant(myParticipant.id);
  const mysteryBoxes = await RacePowerup.findMysteryBoxesByParticipant(myParticipant.id);

  return {
    inventory: held.map((p) => ({
      id: p.id,
      type: p.type,
      rarity: p.rarity,
      earnedAtSteps: p.earnedAtSteps,
      createdAt: p.createdAt,
    })),
    mysteryBoxes: mysteryBoxes.map((p) => ({
      id: p.id,
    })),
  };
}

module.exports = { getRaceInventory };
