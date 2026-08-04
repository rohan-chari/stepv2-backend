const { Router } = require("express");
const { prisma: defaultPrisma } = require("../db");
const {
  testOnlyFilter,
  extractReleaseChannel,
} = require("../shared/middleware/releaseChannel");
const {
  buildAssetUrl,
  categoryForSlot,
  powerupAssetUrl,
} = require("../shared/lib/remoteAssets");

// GET /assets/manifest — the client's registry of CDN-served art.
//
// WHY a manifest and not just per-item `assetUrl` on the catalogs: the shop
// catalogs don't carry every item whose art a client must draw. `earnOnly`
// cosmetics never appear there, drop-pool-only powerups are `active:false`, and
// other players' equipped gear arrives through nine different social
// serializers. One registry keyed by assetKey / powerup type resolves all of
// them without threading URLs everywhere.
//
// UNAUTHENTICATED by design: the PNGs it points at are public static files, and
// the client wants the registry warm before (and independent of) a session. It
// exposes nothing an admin hasn't already published as a public asset.
//
// Release-channel aware: `testOnly` rows are visible only to TestFlight builds,
// exactly like the catalogs. Cache-Control: no-cache — this is the ONE mutable
// document in the whole scheme (the assets themselves are immutable), so it
// must never be served stale from an edge cache.
function createAssetsRouter(dependencies = {}) {
  const router = Router();
  const prisma = dependencies.prisma || defaultPrisma;

  router.get("/manifest", extractReleaseChannel, async (req, res) => {
    try {
      const channelFilter = testOnlyFilter(req.releaseChannel);
      const [cosmetics, powerups] = await Promise.all([
        prisma.shopItem.findMany({
          where: { assetVersion: { not: null }, ...channelFilter },
          select: {
            slot: true,
            assetKey: true,
            assetVersion: true,
            renderMetadata: true,
          },
        }),
        prisma.powerupShopItem.findMany({
          where: { assetVersion: { not: null }, ...channelFilter },
          select: { powerupType: true, assetVersion: true },
        }),
      ]);

      const accessories = {};
      const characters = {};
      for (const item of cosmetics) {
        const category = categoryForSlot(item.slot);
        const url = buildAssetUrl(category, item.assetKey, item.assetVersion);
        // A malformed stored version yields no URL — skip rather than publish a
        // link that 404s.
        if (!url) continue;
        if (category === "characters") {
          const meta =
            item.renderMetadata && typeof item.renderMetadata === "object"
              ? item.renderMetadata
              : {};
          characters[item.assetKey] = {
            url,
            // Walk-sheet geometry travels WITH the art: a character sheet is
            // useless without its frame count, and baselineOffset replaces the
            // value that used to be hardcoded per animal in the app.
            ...(Number.isInteger(meta.animationFrames) && meta.animationFrames > 0
              ? { animationFrames: meta.animationFrames }
              : {}),
            ...(Number.isFinite(meta.baselineOffset)
              ? { baselineOffset: meta.baselineOffset }
              : {}),
          };
        } else {
          accessories[item.assetKey] = { url };
        }
      }

      const powerupEntries = {};
      for (const item of powerups) {
        const url = powerupAssetUrl(item.powerupType, item.assetVersion);
        if (!url) continue;
        powerupEntries[item.powerupType] = { url };
      }

      res.set("Cache-Control", "no-cache");
      res.json({
        accessories,
        characters,
        powerups: powerupEntries,
      });
    } catch (error) {
      console.error("Asset manifest error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createAssetsRouter };
