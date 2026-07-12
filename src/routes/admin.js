const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { buildRequireAdmin } = require("../middleware/requireAdmin");
const { prisma } = require("../db");
const { serializeShopItem } = require("../utils/shopCosmetics");
const { mirrorShopItemToPeer } = require("../utils/mirrorShopItem");
const { appSettings: defaultAppSettings } = require("../services/appSettings");
const {
  getAdminStats: defaultGetAdminStats,
} = require("../queries/getAdminStats");

const RENDER_METADATA_NUMBER_KEYS = ["offsetX", "offsetY", "rotation", "scale"];
const RENDER_METADATA_RENDER_LAYERS = new Set(["front", "behind"]);

function sanitizeRenderMetadata(input) {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) {
    const err = new Error("renderMetadata must be an object");
    err.statusCode = 400;
    throw err;
  }
  const out = {};
  for (const key of RENDER_METADATA_NUMBER_KEYS) {
    if (input[key] === undefined || input[key] === null) continue;
    const num = Number(input[key]);
    if (!Number.isFinite(num)) {
      const err = new Error(`renderMetadata.${key} must be a finite number`);
      err.statusCode = 400;
      throw err;
    }
    out[key] = num;
  }
  if (input.animationFrames !== undefined && input.animationFrames !== null) {
    const frames = Number(input.animationFrames);
    if (!Number.isInteger(frames) || frames < 1) {
      const err = new Error("renderMetadata.animationFrames must be a positive integer");
      err.statusCode = 400;
      throw err;
    }
    out.animationFrames = frames;
  }
  if (input.renderLayer !== undefined && input.renderLayer !== null) {
    const layer = String(input.renderLayer);
    if (!RENDER_METADATA_RENDER_LAYERS.has(layer)) {
      const err = new Error("renderMetadata.renderLayer must be 'front' or 'behind'");
      err.statusCode = 400;
      throw err;
    }
    out.renderLayer = layer;
  }
  // Per-animal placement overrides: { perAnimal: { corgi_puppy: { offsetX, … } } }.
  // Each override block allows only the four numeric tuner keys; the base keys
  // remain the capybara placement.
  if (input.perAnimal !== undefined && input.perAnimal !== null) {
    if (typeof input.perAnimal !== "object" || Array.isArray(input.perAnimal)) {
      const err = new Error("renderMetadata.perAnimal must be an object");
      err.statusCode = 400;
      throw err;
    }
    const perAnimal = {};
    for (const [animal, override] of Object.entries(input.perAnimal)) {
      if (override == null) continue;
      if (typeof override !== "object" || Array.isArray(override)) {
        const err = new Error(`renderMetadata.perAnimal.${animal} must be an object`);
        err.statusCode = 400;
        throw err;
      }
      const block = {};
      for (const key of RENDER_METADATA_NUMBER_KEYS) {
        if (override[key] === undefined || override[key] === null) continue;
        const num = Number(override[key]);
        if (!Number.isFinite(num)) {
          const err = new Error(
            `renderMetadata.perAnimal.${animal}.${key} must be a finite number`
          );
          err.statusCode = 400;
          throw err;
        }
        block[key] = num;
      }
      if (Object.keys(block).length > 0) perAnimal[animal] = block;
    }
    if (Object.keys(perAnimal).length > 0) out.perAnimal = perAnimal;
  }
  return out;
}

function persistentRenderMetadata(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  if (Number.isInteger(raw.animationFrames) && raw.animationFrames > 0) {
    out.animationFrames = raw.animationFrames;
  }
  if (RENDER_METADATA_RENDER_LAYERS.has(raw.renderLayer)) {
    out.renderLayer = raw.renderLayer;
  }
  // Preserve per-animal overrides when a save omits them (e.g. tuning the
  // capybara sliders must not wipe the corgi placement, and vice versa the
  // incoming payload spreads over this so an explicit perAnimal wins).
  if (raw.perAnimal && typeof raw.perAnimal === "object" && !Array.isArray(raw.perAnimal)) {
    out.perAnimal = raw.perAnimal;
  }
  return out;
}

function createAdminRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const requireAdmin = buildRequireAdmin(dependencies);

  router.use(requireAuth, requireAdmin);

  const settings = dependencies.appSettings || defaultAppSettings;
  const getAdminStats = dependencies.getAdminStats || defaultGetAdminStats;

  // Runtime feature flags (DB-backed, no deploy needed). Per-environment on
  // purpose: prod and staging flip independently, no peer-DB mirroring.
  router.get("/settings", async (req, res) => {
    try {
      res.json({ settings: await settings.getAllFlags() });
    } catch (error) {
      console.error("Admin settings read error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Body: any subset of the known flags, e.g. { bannerAdsEnabled: false }.
  // Unknown keys 400 so a typo never silently writes a dead setting.
  router.patch("/settings", async (req, res) => {
    try {
      const body = req.body || {};
      const entries = Object.entries(body);
      if (entries.length === 0) {
        return res.status(400).json({ error: "No settings supplied" });
      }
      for (const [key, value] of entries) {
        if (typeof value !== "boolean") {
          return res.status(400).json({ error: `${key} must be a boolean` });
        }
        await settings.setFlag(key, value);
      }
      res.json({ settings: await settings.getAllFlags() });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Admin settings write error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Product-health snapshot for the admin Statistics card (read-only SQL).
  router.get("/stats", async (req, res) => {
    try {
      res.json({ stats: await getAdminStats() });
    } catch (error) {
      console.error("Admin stats error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/shop/items", async (req, res) => {
    try {
      const items = await prisma.shopItem.findMany({
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      });
      res.json({
        items: items.map((item) => ({
          ...serializeShopItem(item),
          active: item.active,
          testOnly: item.testOnly,
        })),
      });
    } catch (error) {
      console.error("Admin shop list error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.patch("/shop/items/:itemId", async (req, res) => {
    try {
      const body = req.body || {};
      const data = {};
      if (body.renderMetadata !== undefined) {
        if (body.renderMetadata === null) {
          data.renderMetadata = null;
        } else {
          const current = await prisma.shopItem.findUnique({
            where: { id: req.params.itemId },
            select: { renderMetadata: true },
          });
          if (!current) {
            return res.status(404).json({ error: "Shop item not found" });
          }
          data.renderMetadata = {
            ...persistentRenderMetadata(current.renderMetadata),
            ...sanitizeRenderMetadata(body.renderMetadata),
          };
        }
      }
      if (body.active !== undefined) {
        if (typeof body.active !== "boolean") {
          return res.status(400).json({ error: "active must be a boolean" });
        }
        data.active = body.active;
      }
      if (body.priceCoins !== undefined) {
        const price = Number(body.priceCoins);
        if (!Number.isInteger(price) || price < 0) {
          return res
            .status(400)
            .json({ error: "priceCoins must be a non-negative integer" });
        }
        data.priceCoins = price;
      }
      if (body.testOnly !== undefined) {
        if (typeof body.testOnly !== "boolean") {
          return res.status(400).json({ error: "testOnly must be a boolean" });
        }
        data.testOnly = body.testOnly;
      }
      if (body.bobble !== undefined) {
        if (typeof body.bobble !== "boolean") {
          return res.status(400).json({ error: "bobble must be a boolean" });
        }
        data.bobble = body.bobble;
      }
      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "No updatable fields supplied" });
      }
      const updated = await prisma.shopItem.update({
        where: { id: req.params.itemId },
        data,
      });
      // Keep prod and staging in lockstep: mirror the full item state to the
      // peer DB (matched by sku). No-ops safely if PEER_DATABASE_URL is unset.
      const mirror = await mirrorShopItemToPeer(updated);
      res.json({
        item: {
          ...serializeShopItem(updated),
          active: updated.active,
          testOnly: updated.testOnly,
        },
        mirror,
      });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      if (error.code === "P2025") {
        return res.status(404).json({ error: "Shop item not found" });
      }
      console.error("Admin update shop item error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createAdminRouter };
