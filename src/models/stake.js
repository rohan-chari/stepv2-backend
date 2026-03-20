const { prisma } = require("../db");

const Stake = {
  async findById(id) {
    return prisma.stake.findUnique({ where: { id } });
  },

  async findActive({ relationshipType } = {}) {
    const where = { active: true };
    if (relationshipType) {
      where.relationshipTags = { has: relationshipType };
    }
    return prisma.stake.findMany({ where, orderBy: { name: "asc" } });
  },
};

module.exports = { Stake };
