const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { buildRequireAdmin } = require("../middleware/requireAdmin");
const {
  ensureWeeklyChallengeForDate: defaultEnsureWeeklyChallengeForDate,
  resolveWeeklyChallengeForDate: defaultResolveWeeklyChallengeForDate,
  resetWeeklyChallengeForDate: defaultResetWeeklyChallengeForDate,
  getWeeklyChallengeAdminState: defaultGetWeeklyChallengeAdminState,
} = require("../services/weeklyChallengeState");
const { prisma } = require("../db");
const { serializeShopItem } = require("../utils/shopCosmetics");

const RENDER_METADATA_KEYS = ["offsetX", "offsetY", "rotation", "scale"];

function sanitizeRenderMetadata(input) {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) {
    const err = new Error("renderMetadata must be an object");
    err.statusCode = 400;
    throw err;
  }
  const out = {};
  for (const key of RENDER_METADATA_KEYS) {
    if (input[key] === undefined || input[key] === null) continue;
    const num = Number(input[key]);
    if (!Number.isFinite(num)) {
      const err = new Error(`renderMetadata.${key} must be a finite number`);
      err.statusCode = 400;
      throw err;
    }
    out[key] = num;
  }
  return out;
}

function createAdminRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const requireAdmin = buildRequireAdmin(dependencies);
  const ensureWeeklyChallengeForDate =
    dependencies.ensureWeeklyChallengeForDate ||
    defaultEnsureWeeklyChallengeForDate;
  const resolveWeeklyChallengeForDate =
    dependencies.resolveWeeklyChallengeForDate ||
    defaultResolveWeeklyChallengeForDate;
  const resetWeeklyChallengeForDate =
    dependencies.resetWeeklyChallengeForDate ||
    defaultResetWeeklyChallengeForDate;
  const getWeeklyChallengeAdminState =
    dependencies.getWeeklyChallengeAdminState ||
    defaultGetWeeklyChallengeAdminState;

  router.use(requireAuth, requireAdmin);

  router.get("/weekly-challenge", async (req, res) => {
    try {
      const state = await getWeeklyChallengeAdminState();
      res.json(state);
    } catch (error) {
      console.error("Admin weekly challenge state error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/weekly-challenge/ensure-current", async (req, res) => {
    try {
      const result = await ensureWeeklyChallengeForDate();
      res.json(result);
    } catch (error) {
      console.error("Admin ensure weekly challenge error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/weekly-challenge/resolve-current", async (req, res) => {
    try {
      const result = await resolveWeeklyChallengeForDate();
      res.json(result);
    } catch (error) {
      const status = error.statusCode || 500;
      const message =
        status === 500 ? "Internal server error" : error.message;
      console.error("Admin resolve weekly challenge error:", error);
      res.status(status).json({ error: message });
    }
  });

  router.post("/weekly-challenge/reset-current", async (req, res) => {
    try {
      const result = await resetWeeklyChallengeForDate();
      res.json(result);
    } catch (error) {
      const status = error.statusCode || 500;
      const message =
        status === 500 ? "Internal server error" : error.message;
      console.error("Admin reset weekly challenge error:", error);
      res.status(status).json({ error: message });
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
        data.renderMetadata = sanitizeRenderMetadata(body.renderMetadata);
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
      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "No updatable fields supplied" });
      }
      const updated = await prisma.shopItem.update({
        where: { id: req.params.itemId },
        data,
      });
      res.json({ item: { ...serializeShopItem(updated), active: updated.active } });
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
