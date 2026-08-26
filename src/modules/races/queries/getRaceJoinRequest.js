const { prisma: defaultPrisma } = require("../../../db");
const {
  RaceJoinRequestError,
  serializeJoinRequest,
} = require("../services/raceJoinRequests");

async function getRaceJoinRequest({ requestId, requesterUserId, prisma = defaultPrisma }) {
  const row = await prisma.raceJoinRequest.findUnique({ where: { id: requestId } });
  if (!row || row.requesterUserId !== requesterUserId) {
    throw new RaceJoinRequestError(
      "Join request not found",
      404,
      "JOIN_REQUEST_NOT_FOUND",
    );
  }
  return { joinRequest: serializeJoinRequest(row) };
}

module.exports = { getRaceJoinRequest };
