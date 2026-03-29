const { prisma } = require("../db");

const RaceParticipant = {
  async findByRaceAndUser(raceId, userId) {
    return prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId, userId } },
    });
  },

  async create({ raceId, userId, status }) {
    return prisma.raceParticipant.create({
      data: { raceId, userId, status },
      include: {
        user: { select: { id: true, displayName: true } },
      },
    });
  },

  async createMany(records) {
    return prisma.raceParticipant.createMany({
      data: records,
      skipDuplicates: true,
    });
  },

  async update(id, fields) {
    return prisma.raceParticipant.update({
      where: { id },
      data: fields,
      include: {
        user: { select: { id: true, displayName: true } },
      },
    });
  },

  async findByRace(raceId) {
    return prisma.raceParticipant.findMany({
      where: { raceId },
      include: {
        user: { select: { id: true, displayName: true } },
      },
      orderBy: { joinedAt: "asc" },
    });
  },

  async findAcceptedByRace(raceId) {
    return prisma.raceParticipant.findMany({
      where: { raceId, status: "ACCEPTED" },
      include: {
        user: { select: { id: true, displayName: true } },
      },
      orderBy: { joinedAt: "asc" },
    });
  },

  async countAccepted(raceId) {
    return prisma.raceParticipant.count({
      where: { raceId, status: "ACCEPTED" },
    });
  },

  async updateTotalSteps(id, totalSteps) {
    return prisma.raceParticipant.update({
      where: { id },
      data: { totalSteps },
    });
  },

  async markFinished(id, finishedAt) {
    return prisma.raceParticipant.update({
      where: { id },
      data: { finishedAt, status: "ACCEPTED" },
    });
  },
};

module.exports = { RaceParticipant };
