const { Router } = require("express");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const { buildRequireAdmin } = require("./requireAdmin");
const { prisma } = require("../../db");
const { serializeShopItem, mirrorShopItemToPeer } = require("../cosmetics");
const { appSettings: defaultAppSettings } = require("../../shared/config/appSettings");
const {
  getAdminStats: defaultGetAdminStats,
} = require("./getAdminStats");
const {
  balanceConfig: defaultBalanceConfig,
} = require("../economy/balanceConfig");
const { serializeBounds } = require("../economy/balanceConfig.defaults");

// Allowed values for the numeric stepSampleBucketMinutes setting (§3.2).
const STEP_SAMPLE_BUCKET_MINUTES = new Set([5, 10, 15, 30, 60]);

const RENDER_METADATA_NUMBER_KEYS = ["offsetX", "offsetY", "rotation", "scale"];
const RENDER_METADATA_RENDER_LAYERS = new Set(["front", "behind"]);

// Mirror of prisma's AccessorySlot enum for request validation.
const ACCESSORY_SLOTS = new Set(["HEAD", "FACE", "NECK", "BACK", "FEET", "CHARACTER"]);

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
  if (input.perFoot !== undefined && input.perFoot !== null) {
    if (typeof input.perFoot !== "boolean") {
      const err = new Error("renderMetadata.perFoot must be a boolean");
      err.statusCode = 400;
      throw err;
    }
    out.perFoot = input.perFoot;
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
  if (typeof raw.perFoot === "boolean") {
    out.perFoot = raw.perFoot;
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
  const balance = dependencies.balanceConfig || defaultBalanceConfig;

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
  // Boolean flags require a boolean; the numeric stepSampleBucketMinutes flag
  // (Five-Minute Step Samples §3.2) requires one of {5,10,15,30,60}. Unknown keys
  // 400 (via setFlag) so a typo never silently writes a dead setting.
  router.patch("/settings", async (req, res) => {
    try {
      const body = req.body || {};
      const entries = Object.entries(body);
      if (entries.length === 0) {
        return res.status(400).json({ error: "No settings supplied" });
      }
      for (const [key, value] of entries) {
        if (key === "stepSampleBucketMinutes") {
          if (!Number.isInteger(value) || !STEP_SAMPLE_BUCKET_MINUTES.has(value)) {
            return res.status(400).json({
              error: "stepSampleBucketMinutes must be one of 5, 10, 15, 30, 60",
            });
          }
          await settings.setFlag(key, value);
          continue;
        }
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

  // Create a cosmetic shop item. This is the ONLY birth channel for new
  // cosmetics now that data/cosmetics.json is gone — the row is created here
  // and mirrored to the peer DB (matched by sku) so prod and staging get the
  // item together, then placement is tuned via the Accessory Tuner PATCH below.
  router.post("/shop/items", async (req, res) => {
    try {
      const body = req.body || {};
      const requireString = (key) => {
        const value = body[key];
        if (typeof value !== "string" || value.trim() === "") {
          const err = new Error(`${key} must be a non-empty string`);
          err.statusCode = 400;
          throw err;
        }
        return value.trim();
      };
      const optionalBoolean = (key, fallback) => {
        const value = body[key];
        if (value === undefined || value === null) return fallback;
        if (typeof value !== "boolean") {
          const err = new Error(`${key} must be a boolean`);
          err.statusCode = 400;
          throw err;
        }
        return value;
      };

      const sku = requireString("sku");
      const name = requireString("name");
      const assetKey = requireString("assetKey");
      const slot = body.slot;
      if (!ACCESSORY_SLOTS.has(slot)) {
        return res.status(400).json({
          error: `slot must be one of ${[...ACCESSORY_SLOTS].join(", ")}`,
        });
      }
      const priceCoins = Number(body.priceCoins);
      if (!Number.isInteger(priceCoins) || priceCoins < 0) {
        return res
          .status(400)
          .json({ error: "priceCoins must be a non-negative integer" });
      }
      if (
        body.description !== undefined &&
        body.description !== null &&
        typeof body.description !== "string"
      ) {
        return res.status(400).json({ error: "description must be a string" });
      }
      let sortOrder = 0;
      if (body.sortOrder !== undefined && body.sortOrder !== null) {
        sortOrder = Number(body.sortOrder);
        if (!Number.isInteger(sortOrder)) {
          return res.status(400).json({ error: "sortOrder must be an integer" });
        }
      }

      const created = await prisma.shopItem.create({
        data: {
          sku,
          name,
          description: body.description ?? null,
          slot,
          priceCoins,
          assetKey,
          renderMetadata:
            body.renderMetadata === undefined || body.renderMetadata === null
              ? null
              : sanitizeRenderMetadata(body.renderMetadata),
          active: optionalBoolean("active", true),
          // Default testOnly:true — a brand-new item's PNG isn't bundled in
          // frozen binaries yet; flip to false only after the carrying App
          // Store build has rolled out.
          testOnly: optionalBoolean("testOnly", true),
          earnOnly: optionalBoolean("earnOnly", false),
          bobble: optionalBoolean("bobble", false),
          sortOrder,
        },
      });

      // Keep prod and staging in lockstep from birth: mirror the new item to
      // the peer DB. No-ops safely if PEER_DATABASE_URL is unset.
      const mirror = await mirrorShopItemToPeer(created);
      res.status(201).json({
        item: {
          ...serializeShopItem(created),
          active: created.active,
          testOnly: created.testOnly,
          earnOnly: created.earnOnly,
        },
        mirror,
      });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      if (error.code === "P2002") {
        return res
          .status(409)
          .json({ error: "A shop item with that sku already exists" });
      }
      console.error("Admin create shop item error:", error);
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

  // === POWERUP SHOP CATALOG (§5.1) ===
  //
  // The admin surface for coin-purchasable powerup prices/flags. This exists so
  // prices are tuned HERE and only here — `prisma/seed.js` deliberately no
  // longer reasserts priceCoins/active on deploy, which is what silently
  // reverted the Leech price 300 -> 150.
  //
  // `name` / `description` are intentionally NOT editable: the PowerupCopy table
  // owns user-facing copy, and two writable sources of a string is the same
  // class of bug this build removes.
  router.get("/powerup-shop/items", async (req, res) => {
    try {
      const items = await prisma.powerupShopItem.findMany({
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      });
      res.json({
        items: items.map((item) => ({
          id: item.id,
          sku: item.sku,
          name: item.name,
          powerupType: item.powerupType,
          priceCoins: item.priceCoins,
          active: item.active,
          testOnly: item.testOnly,
          sortOrder: item.sortOrder,
        })),
      });
    } catch (error) {
      console.error("Admin powerup shop list error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.patch("/powerup-shop/items/:itemId", async (req, res) => {
    try {
      const body = req.body || {};
      const data = {};

      if (body.priceCoins !== undefined) {
        if (!Number.isInteger(body.priceCoins) || body.priceCoins < 0) {
          return res
            .status(400)
            .json({ error: "priceCoins must be a non-negative integer" });
        }
        data.priceCoins = body.priceCoins;
      }
      for (const key of ["active", "testOnly"]) {
        if (body[key] === undefined) continue;
        if (typeof body[key] !== "boolean") {
          return res.status(400).json({ error: `${key} must be a boolean` });
        }
        data[key] = body[key];
      }
      if (body.sortOrder !== undefined) {
        if (!Number.isInteger(body.sortOrder)) {
          return res.status(400).json({ error: "sortOrder must be an integer" });
        }
        data.sortOrder = body.sortOrder;
      }
      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "No updatable fields supplied" });
      }

      const updated = await prisma.powerupShopItem.update({
        where: { id: req.params.itemId },
        data,
      });
      res.json({
        item: {
          id: updated.id,
          sku: updated.sku,
          name: updated.name,
          powerupType: updated.powerupType,
          priceCoins: updated.priceCoins,
          active: updated.active,
          testOnly: updated.testOnly,
          sortOrder: updated.sortOrder,
        },
      });
    } catch (error) {
      if (error.code === "P2025") {
        return res.status(404).json({ error: "Powerup shop item not found" });
      }
      console.error("Admin update powerup shop item error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // === BALANCE CONFIG (§5.2) ===

  router.get("/balance-config", async (req, res) => {
    try {
      const row = await balance.getActiveRow();
      // No row yet (fresh env / pre-seed) still answers with the code defaults
      // rather than 404, so the editor opens on something coherent. version:null
      // tells the client "nothing saved yet".
      const config = row
        ? balance.mergeOverDefaults(row.config)
        : balance.mergeOverDefaults(null);
      res.json({
        version: row ? row.version : null,
        config,
        note: row ? row.note : null,
        createdBy: row ? row.createdBy : null,
        boundOverride: row ? row.boundOverride : false,
        createdAt: row ? row.createdAt : null,
        // Served so the UI can warn as the admin types, before it submits.
        bounds: serializeBounds(),
      });
    } catch (error) {
      console.error("Admin balance config read error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/balance-config/versions", async (req, res) => {
    try {
      const limit = Number.parseInt(req.query.limit, 10);
      const versions = await balance.listVersions(
        Number.isInteger(limit) ? limit : 50
      );
      res.json({ versions });
    } catch (error) {
      console.error("Admin balance config versions error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.put("/balance-config", async (req, res) => {
    const body = req.body || {};
    if (body.config === undefined) {
      return res.status(400).json({ error: "config is required" });
    }
    if (body.expectedVersion !== undefined && body.expectedVersion !== null) {
      if (!Number.isInteger(body.expectedVersion)) {
        return res
          .status(400)
          .json({ error: "expectedVersion must be an integer or null" });
      }
    }
    try {
      const saved = await balance.saveConfig({
        config: body.config,
        note: typeof body.note === "string" ? body.note : null,
        createdBy: req.user?.id ?? null,
        // `null` is meaningful (== "I expect no config to exist yet"), so only
        // an absent key skips the optimistic-concurrency check.
        expectedVersion:
          body.expectedVersion === undefined ? undefined : body.expectedVersion,
        acknowledgeBoundWarnings: body.acknowledgeBoundWarnings === true,
      });
      res.status(201).json({
        version: saved.version,
        config: balance.mergeOverDefaults(saved.config),
        warnings: [],
      });
    } catch (error) {
      if (error.statusCode) {
        const { statusCode, ...payload } = error;
        return res.status(statusCode).json({
          error: payload.error || error.message,
          ...(payload.errors ? { errors: payload.errors } : {}),
          ...(payload.warnings ? { warnings: payload.warnings } : {}),
          ...(payload.currentVersion !== undefined
            ? { currentVersion: payload.currentVersion }
            : {}),
          ...(payload.config !== undefined ? { config: payload.config } : {}),
        });
      }
      console.error("Admin balance config write error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/balance-config/rollback", async (req, res) => {
    const body = req.body || {};
    if (!Number.isInteger(body.version)) {
      return res.status(400).json({ error: "version must be an integer" });
    }
    try {
      const saved = await balance.rollbackTo({
        version: body.version,
        expectedVersion:
          body.expectedVersion === undefined ? undefined : body.expectedVersion,
        createdBy: req.user?.id ?? null,
      });
      res.json({ version: saved.version });
    } catch (error) {
      if (error.statusCode) {
        const { statusCode, ...payload } = error;
        return res.status(statusCode).json({
          error: payload.error || error.message,
          ...(payload.currentVersion !== undefined
            ? { currentVersion: payload.currentVersion }
            : {}),
          ...(payload.config !== undefined ? { config: payload.config } : {}),
        });
      }
      console.error("Admin balance config rollback error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createAdminRouter };
