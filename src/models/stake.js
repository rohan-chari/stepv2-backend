const { prisma } = require("../db");

const Stake = {
  async findById(id) {
    return prisma.stake.findUnique({ where: { id } });
  },

  async findActive({ relationshipType } = {}) {
    const stakes = await prisma.stake.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
    });

    if (!relationshipType) return stakes;

    // Sort: matching relationship tags first, then the rest
    return stakes.sort((a, b) => {
      const aMatch = a.relationshipTags.includes(relationshipType);
      const bMatch = b.relationshipTags.includes(relationshipType);
      if (aMatch && !bMatch) return -1;
      if (!aMatch && bMatch) return 1;
      return 0;
    });
  },
};

module.exports = { Stake };
