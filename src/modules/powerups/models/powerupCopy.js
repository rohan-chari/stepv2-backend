const { prisma } = require("../../../db");

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
    const row = await prisma.powerupCopy.upsert({
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
    // C1 invalidation (spec §5 Phase B). This runs at deploy-time seeding
    // rather than from an HTTP route, so the 60s TTL would cover it anyway —
    // but a seeded copy change that lingers a minute on one worker and not
    // another is exactly the incoherence C1 exists to remove.
    const derivedCache = require("../../../shared/cache/derivedCache");
    const cacheKeys = require("../../../shared/cache/cacheKeys");
    await derivedCache.invalidate({
      keys: cacheKeys.powerupCatalogVariants(),
      prefix: cacheKeys.PREFIX.POWERUP_CATALOG,
    });
    return row;
  },
};

module.exports = { PowerupCopy };
