const { Race } = require("../models/race");

async function getRaceDetails(userId, raceId) {
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

  return {
    id: race.id,
    name: race.name,
    targetSteps: race.targetSteps,
    status: race.status,
    maxDurationDays: race.maxDurationDays,
    startedAt: race.startedAt,
    endsAt: race.endsAt,
    completedAt: race.completedAt,
    creator: race.creator,
    winner: race.winner,
    isCreator: race.creatorId === userId,
    myStatus: myParticipant.status,
    participants: race.participants.map((p) => ({
      id: p.id,
      userId: p.userId,
      displayName: p.user.displayName,
      status: p.status,
      totalSteps: p.totalSteps,
      finishedAt: p.finishedAt,
      joinedAt: p.joinedAt,
    })),
    createdAt: race.createdAt,
  };
}

module.exports = { getRaceDetails };
