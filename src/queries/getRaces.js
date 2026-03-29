const { Race } = require("../models/race");

async function getRaces(userId) {
  const races = await Race.findForUser(userId);

  const active = [];
  const pending = [];
  const completed = [];

  for (const race of races) {
    const myParticipant = race.participants.find((p) => p.userId === userId);
    const acceptedCount = race.participants.filter((p) => p.status === "ACCEPTED").length;

    const summary = {
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
      participantCount: acceptedCount,
      myStatus: myParticipant?.status || null,
      isCreator: race.creatorId === userId,
      createdAt: race.createdAt,
    };

    if (race.status === "ACTIVE") {
      active.push(summary);
    } else if (race.status === "PENDING") {
      pending.push(summary);
    } else if (race.status === "COMPLETED") {
      completed.push(summary);
    }
  }

  return { active, pending, completed };
}

module.exports = { getRaces };
