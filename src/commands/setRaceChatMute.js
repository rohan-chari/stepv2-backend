const { prisma } = require("../db");

class SetRaceChatMuteError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "SetRaceChatMuteError";
    this.statusCode = statusCode;
  }
}

async function setRaceChatMute({ userId, raceId, muted }) {
  const participant = await prisma.raceParticipant.findUnique({
    where: { raceId_userId: { raceId, userId } },
  });
  if (!participant) {
    throw new SetRaceChatMuteError("Not a participant in this race", 403);
  }
  return prisma.raceParticipant.update({
    where: { id: participant.id },
    data: { chatMuted: !!muted },
  });
}

async function markRaceChatRead({ userId, raceId }) {
  const participant = await prisma.raceParticipant.findUnique({
    where: { raceId_userId: { raceId, userId } },
  });
  if (!participant) {
    throw new SetRaceChatMuteError("Not a participant in this race", 403);
  }
  return prisma.raceParticipant.update({
    where: { id: participant.id },
    data: { lastReadRaceChatAt: new Date() },
  });
}

module.exports = { setRaceChatMute, markRaceChatRead, SetRaceChatMuteError };
