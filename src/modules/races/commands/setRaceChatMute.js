const { prisma } = require("../../../db");

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
  if (!participant || (await prisma.race.findUnique({ where: { id: raceId }, select: { seededBucketId: true } }))?.seededBucketId && participant.status !== "ACCEPTED") {
    throw new SetRaceChatMuteError("Not a participant in this race", 403);
  }
  const result = await prisma.raceParticipant.update({
    where: { id: participant.id },
    data: { chatMuted: !!muted },
  });
  await require('../services/raceCacheInvalidation').participantDisplayChanged([result], { chatMuted: true });
  return result;
}

async function markRaceChatRead({ userId, raceId }) {
  const participant = await prisma.raceParticipant.findUnique({
    where: { raceId_userId: { raceId, userId } },
  });
  if (!participant || (await prisma.race.findUnique({ where: { id: raceId }, select: { seededBucketId: true } }))?.seededBucketId && participant.status !== "ACCEPTED") {
    throw new SetRaceChatMuteError("Not a participant in this race", 403);
  }
  const result = await prisma.raceParticipant.update({
    where: { id: participant.id },
    data: { lastReadRaceChatAt: new Date() },
  });
  await require('../services/raceCacheInvalidation').participantDisplayChanged([result], { lastReadRaceChatAt: true });
  return result;
}

module.exports = { setRaceChatMute, markRaceChatRead, SetRaceChatMuteError };
