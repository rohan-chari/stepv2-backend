const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { Steps } = require("../models/steps");
const { completeRace } = require("../commands/completeRace");

async function getRaceProgress(userId, raceId, timeZone) {
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

  if (race.status !== "ACTIVE") {
    const acceptedParticipants = race.participants.filter((p) => p.status === "ACCEPTED");
    return {
      raceId: race.id,
      status: race.status,
      targetSteps: race.targetSteps,
      endsAt: race.endsAt,
      participants: acceptedParticipants.map((p) => ({
        userId: p.userId,
        displayName: p.user.displayName,
        totalSteps: p.totalSteps,
        progress: Math.min(p.totalSteps / race.targetSteps, 1),
        finishedAt: p.finishedAt,
      })),
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const acceptedParticipants = race.participants.filter((p) => p.status === "ACCEPTED");

  const stepTotals = await Promise.all(
    acceptedParticipants.map(async (p) => {
      const startDate = (p.joinedAt || race.startedAt).toISOString().slice(0, 10);
      const steps = await Steps.findByUserIdAndDateRange(p.userId, startDate, today);
      const raw = steps.reduce((sum, s) => sum + s.steps, 0);
      const total = Math.max(0, raw - (p.baselineSteps || 0));
      return { participant: p, totalSteps: total };
    })
  );

  let firstFinisher = null;

  for (const { participant, totalSteps } of stepTotals) {
    await RaceParticipant.updateTotalSteps(participant.id, totalSteps);

    if (totalSteps >= race.targetSteps && !participant.finishedAt) {
      await RaceParticipant.markFinished(participant.id, new Date());
      if (!firstFinisher || totalSteps > firstFinisher.totalSteps) {
        firstFinisher = { userId: participant.userId, totalSteps };
      }
    }
  }

  if (firstFinisher) {
    const allUserIds = acceptedParticipants.map((p) => p.userId);
    await completeRace({
      raceId,
      winnerUserId: firstFinisher.userId,
      participantUserIds: allUserIds,
    });
  }

  const leaderboard = stepTotals
    .map(({ participant, totalSteps }) => ({
      userId: participant.userId,
      displayName: participant.user.displayName,
      totalSteps,
      progress: Math.min(totalSteps / race.targetSteps, 1),
      finishedAt: participant.finishedAt,
    }))
    .sort((a, b) => b.totalSteps - a.totalSteps);

  const updatedRace = await Race.findById(raceId);

  return {
    raceId: race.id,
    status: updatedRace.status,
    targetSteps: race.targetSteps,
    endsAt: race.endsAt,
    participants: leaderboard,
  };
}

module.exports = { getRaceProgress };
