const { prisma: defaultPrisma } = require("../../../db");
const {
  RaceJoinRequestError,
  serializeJoinRequest,
  encodeJoinRequestCursor,
  decodeJoinRequestCursor,
} = require("../services/raceJoinRequests");

async function listRaceJoinRequests({
  raceId,
  creatorUserId,
  status = "PENDING",
  cursor: rawCursor,
  limit: rawLimit = 20,
  prisma = defaultPrisma,
}) {
  if (status !== "PENDING") {
    throw new RaceJoinRequestError("Invalid status", 400, "INVALID_STATUS");
  }
  const parsed = Number(rawLimit);
  const limit = Number.isInteger(parsed) ? Math.min(50, Math.max(1, parsed)) : 20;
  const cursor = decodeJoinRequestCursor(rawCursor);
  const race = await prisma.race.findUnique({
    where: { id: raceId },
    select: { creatorId: true },
  });
  if (!race) {
    throw new RaceJoinRequestError("Race not found", 404, "RACE_NOT_FOUND");
  }
  if (race.creatorId !== creatorUserId) {
    throw new RaceJoinRequestError(
      "Only the race creator can view join requests",
      403,
      "NOT_RACE_CREATOR",
    );
  }
  const rows = await prisma.raceJoinRequest.findMany({
    where: {
      raceId,
      status,
      ...(cursor ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    joinRequests: page.map(serializeJoinRequest),
    nextCursor: more ? encodeJoinRequestCursor(page.at(-1)) : null,
  };
}

module.exports = { listRaceJoinRequests };
