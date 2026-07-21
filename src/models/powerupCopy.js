const { prisma } = require("../db");

// PowerupCopy — the single source of truth for user-facing powerup copy (§9.5).
// One row per user-renderable PowerupType (MYSTERY_BOX excluded).
const PowerupCopy = {
  // The whole catalog. It is tiny (28 rows) and read by an unauthenticated,
  // client-feature-independent endpoint, so there is nothing to filter here.
  async findAll() {
    return prisma.powerupCopy.findMany();
  },

  // Idempotent seed/refresh of one row, keyed by powerupType.
  async upsertOne({
    powerupType,
    name,
    description,
    shortDescription = null,
    upgradeTierLabels = [],
  }) {
    return prisma.powerupCopy.upsert({
      where: { powerupType },
      update: { name, description, shortDescription, upgradeTierLabels },
      create: {
        powerupType,
        name,
        description,
        shortDescription,
        upgradeTierLabels,
      },
    });
  },
};

module.exports = { PowerupCopy };
