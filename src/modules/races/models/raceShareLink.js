const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");

function hashShareToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function buildRaceShareLinkModel(prisma = defaultPrisma) {
  return {
    async create({ raceId, sharedByUserId, sharedByDisplayName, rawToken, expiresAt }) {
      return prisma.raceShareLink.create({
        data: {
          raceId,
          sharedByUserId,
          sharedByDisplayName,
          tokenHash: hashShareToken(rawToken),
          expiresAt,
        },
      });
    },

    async findByRawToken(rawToken) {
      return prisma.raceShareLink.findUnique({
        where: { tokenHash: hashShareToken(rawToken) },
      });
    },
  };
}

const RaceShareLink = buildRaceShareLinkModel();

module.exports = { RaceShareLink, buildRaceShareLinkModel, hashShareToken };
