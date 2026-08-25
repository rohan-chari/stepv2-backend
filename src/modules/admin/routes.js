const { Router } = require("express");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const { buildRequireAdmin } = require("./requireAdmin");
const { prisma, runInPrismaTransaction } = require("../../db");
const { serializeShopItem, mirrorShopItemToPeer } = require("../cosmetics");
const { sanitizeCompatibility } = require("../cosmetics/accessoryCompatibility");
const {
  isValidAssetVersion,
  powerupAssetUrl,
} = require("../../shared/lib/remoteAssets");

const {
  appSettings: defaultAppSettings,
  PERMANENT_FLAGS,
} = require("../../shared/config/appSettings");
const {
  getAdminStats: defaultGetAdminStats,
} = require("./getAdminStats");
const {
  balanceConfig: defaultBalanceConfig,
} = require("../economy/balanceConfig");
const {
  listSuggestions: defaultListSuggestions,
  listFeedbackThreads: defaultListFeedbackThreads,
} = require("../feedback");
const { serializeBounds } = require("../economy/balanceConfig.defaults");
const derivedCache = require("../../shared/cache/derivedCache");
const cacheKeys = require("../../shared/cache/cacheKeys");
const {
  decodeCursor,
  encodeCursor,
  parseLimit,
  beforeCursor,
  invalidateInboxUnread,
} = require("../inbox/services/inbox");
const { buildNotificationIntentService } = require("../notifications/services/notificationDelivery");

// C1 invalidation (spec §5 Phase B). Every shop_items / powerup_shop_items
// mutation below must drop the derived catalog + manifest copies and broadcast
// to peer workers — otherwise the admin's own write is invisible for up to the
// 60s TTL, on every worker but the one that served the request.
//
// EVERY VARIANT is deleted, not just the caller's: an admin on a TestFlight
// build editing an item must still bust the prod-channel copy.
// Invalidate-only — the new row is never written into Redis here (§3).
async function invalidateShopCaches() {
  await derivedCache.invalidate({
    keys: cacheKeys.shopCatalogVariants(),
    prefix: cacheKeys.PREFIX.SHOP_CATALOG,
  });
  await derivedCache.invalidate({
    keys: cacheKeys.assetsManifestVariants(),
    prefix: cacheKeys.PREFIX.ASSETS_MANIFEST,
  });
}

async function invalidatePowerupShopCaches() {
  await derivedCache.invalidate({
    keys: cacheKeys.powerupCatalogVariants(),
    prefix: cacheKeys.PREFIX.POWERUP_CATALOG,
  });
  await derivedCache.invalidate({
    keys: cacheKeys.assetsManifestVariants(),
    prefix: cacheKeys.PREFIX.ASSETS_MANIFEST,
  });
}

function staffInboxEnabled(req, settings) {
  return req.clientFeatures?.has("inbox_v1") === true && settings.getFlag("apiInboxV1Enabled");
}
function validThreadIdempotencyKey(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function cleanStaffThreadText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length >= 1 && text.length <= 2000 ? text : null;
}
function staffThreadExpiry(now) { return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); }

// Shared validator for the `assetVersion` body field on both shop admin
// surfaces. `undefined` means "not supplied, leave alone"; `null` means
// "detach — the art is bundled again". Anything else must be a hex digest
// prefix, because it is interpolated straight into a public asset filename.
function readAssetVersion(body, key = "assetVersion") {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isValidAssetVersion(value)) {
    const err = new Error(
      "assetVersion must be a hex string of 8-64 characters (sha256 prefix), or null"
    );
    err.statusCode = 400;
    throw err;
  }
  return String(value).toLowerCase();
}

// `baselineOffset` (CDN art build) is the CHARACTER walk-sheet's vertical
// anchor — the value that used to be hardcoded per animal in the app's
// kAnimalSprites map. It lives here so a remote character ships its own
// baseline instead of needing an App Store release. Unlike the four tuner
// sliders it is NOT resent on every save, so persistentRenderMetadata below
// must preserve it (the sanitizer-wipe trap).
const RENDER_METADATA_NUMBER_KEYS = [
  "offsetX",
  "offsetY",
  "rotation",
  "scale",
  "baselineOffset",
];
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
  // Preserve the character baseline across placement-only saves: the Accessory
  // Tuner sends offsets/rotation/scale, not baselineOffset, so without this a
  // single slider drag would wipe a remote character's vertical anchor.
  if (Number.isFinite(raw.baselineOffset)) {
    out.baselineOffset = raw.baselineOffset;
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
  const db = dependencies.prisma || prisma;
  const transaction = dependencies.transaction ||
    (dependencies.prisma ? (work) => db.$transaction(work) : runInPrismaTransaction);
  const notificationIntentService = dependencies.notificationIntentService ||
    buildNotificationIntentService({ prisma: db });
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const requireAdmin = buildRequireAdmin(dependencies);

  router.use(requireAuth, requireAdmin);

  const settings = dependencies.appSettings || defaultAppSettings;
  const getAdminStats = dependencies.getAdminStats || defaultGetAdminStats;
  const balance = dependencies.balanceConfig || defaultBalanceConfig;
  const listSuggestions =
    dependencies.listSuggestions || defaultListSuggestions;
  const listFeedbackThreads =
    dependencies.listFeedbackThreads || defaultListFeedbackThreads;

  // Batch 2026-08-08 item 7 — in-app suggestion box, admin read side.
  // Newest first, keyset-paged: ?limit=50&before=<ISO createdAt>. `nextBefore`
  // is the cursor for the following page, or null when the list is exhausted.
  // PII: `text` is user free-writing, so this router's admin gate (applied
  // above via router.use) is the only thing standing between it and the world.
  router.get("/feedback/suggestions", async (req, res) => {
    try {
      const page = await listSuggestions({
        limit: req.query.limit,
        before: req.query.before,
        prisma,
      });
      res.json(page);
    } catch (error) {
      if (error.statusCode === 400) {
        return res.status(400).json({ error: error.message });
      }
      console.error("Admin feedback list error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Inbox v1 staff surface. This exposes thread content plus the submitter's
  // minimal current display name — never email, device, or staff identity.
  router.get("/feedback/threads", async (req, res) => {
    try {
      if (!(await staffInboxEnabled(req, settings))) {
        return res.status(404).json({ error: "Inbox is unavailable", code: "FEATURE_DISABLED" });
      }
      const page = await listFeedbackThreads({
        limit: req.query.limit,
        cursor: req.query.cursor,
        prisma: db,
      });
      return res.json(page);
    } catch (error) {
      if (error.statusCode === 400) return res.status(400).json({ error: error.message, code: error.code || "INVALID_REQUEST" });
      console.error("Admin feedback thread list error:", error);
      return res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
    }
  });

  router.get("/feedback/threads/:id", async (req, res) => {
    try {
      if (!(await staffInboxEnabled(req, settings))) {
        return res.status(404).json({ error: "Inbox is unavailable", code: "FEATURE_DISABLED" });
      }
      const limit = parseLimit(req.query.limit);
      const before = decodeCursor(req.query.before);
      const thread = await prisma.feedbackThread.findFirst({ where: { id: req.params.id, expiresAt: { gt: new Date() } } });
      if (!thread) return res.status(404).json({ error: "Thread not found", code: "NOT_FOUND" });
      const rows = await prisma.feedbackMessage.findMany({
        where: { threadId: thread.id, ...(beforeCursor(before) || {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
      });
      const more = rows.length > limit;
      const page = rows.slice(0, limit);
      await prisma.feedbackThread.update({ where: { id: thread.id }, data: { staffReadAt: new Date() } });
      return res.json({
        thread: { id: thread.id, expiresAt: thread.expiresAt },
        messages: [...page].reverse().map((message) => ({ id: message.id, senderKind: message.senderKind, text: message.text, createdAt: message.createdAt })),
        nextBefore: more ? encodeCursor(page.at(-1)) : null,
      });
    } catch (error) {
      if (error.statusCode === 400) return res.status(400).json({ error: error.message, code: error.code || "INVALID_REQUEST" });
      console.error("Admin feedback thread detail error:", error);
      return res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
    }
  });

  router.post("/feedback/threads/:id/messages", async (req, res) => {
    try {
      if (!(await staffInboxEnabled(req, settings))) {
        return res.status(404).json({ error: "Inbox is unavailable", code: "FEATURE_DISABLED" });
      }
      const text = cleanStaffThreadText(req.body?.text);
      const idempotencyKey = req.body?.idempotencyKey;
      if (!text || !validThreadIdempotencyKey(idempotencyKey)) {
        return res.status(400).json({ error: "Invalid message payload", code: "INVALID_BODY" });
      }
      const now = new Date();
      const thread = await prisma.feedbackThread.findFirst({ where: { id: req.params.id, expiresAt: { gt: now } } });
      if (!thread) return res.status(404).json({ error: "Thread not found", code: "NOT_FOUND" });
      const existing = await prisma.feedbackMessage.findUnique({ where: { threadId_idempotencyKey: { threadId: thread.id, idempotencyKey } } });
      if (existing) return res.status(200).json({ message: { id: existing.id, senderKind: existing.senderKind, text: existing.text, createdAt: existing.createdAt } });
      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const recent = await prisma.feedbackMessage.count({ where: { senderKind: "STAFF", createdAt: { gte: hourAgo } } });
      if (recent >= 60) return res.status(429).json({ error: "Too many support replies", code: "RATE_LIMITED" });
      const message = await transaction(async (tx) => {
        const created = await tx.feedbackMessage.create({ data: { threadId: thread.id, senderKind: "STAFF", text, idempotencyKey } });
        await tx.feedbackThread.update({ where: { id: thread.id }, data: { lastMessageAt: now, expiresAt: staffThreadExpiry(now), staffReadAt: now, userReadAt: null } });
        await notificationIntentService.submit({
          recipientUserId: thread.userId,
          type: "SUPPORT_REPLY",
          title: "BARA SUPPORT",
          body: text,
          payload: {
            type: "SUPPORT_REPLY",
            route: "support_thread",
            params: { threadId: thread.id },
          },
          deliveryKey: `support-reply:${created.id}`,
          availableAt: now,
        }, { tx, now });
        return created;
      });
      await notificationIntentService.wake({ recipientUserId: thread.userId }).catch(() => null);
      await invalidateInboxUnread(thread.userId);
      return res.status(201).json({ message: { id: message.id, senderKind: message.senderKind, text: message.text, createdAt: message.createdAt } });
    } catch (error) {
      console.error("Admin feedback reply error:", error);
      return res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
    }
  });

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
  // Boolean flags require a boolean; numeric flags validate their own bounded
  // rollout domains. Unknown keys 400 (via setFlag) so a typo never silently
  // writes a dead setting.
  router.patch("/settings", async (req, res) => {
    try {
      const body = req.body || {};
      const entries = Object.entries(body);
      if (entries.length === 0) {
        return res.status(400).json({ error: "No settings supplied" });
      }
      for (const [key, value] of entries) {
        if (Object.prototype.hasOwnProperty.call(PERMANENT_FLAGS, key)) {
          return res.status(400).json({ error: `Unknown setting: ${key}` });
        }
        if (
          key === "homeServiceBannerEnabled" ||
          key === "homeServiceBannerMessage" ||
          key === "homeServiceBannerContestSlug"
        ) {
          return res.status(400).json({
            error: "Use PATCH /admin/settings/home-service-banner for banner settings",
          });
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

  // Atomic pair: an enabled banner is meaningless without an explicitly
  // validated plain-text message. This endpoint intentionally owns both keys;
  // generic PATCH /settings remains boolean-only for its historical contract.
  router.patch("/settings/home-service-banner", async (req, res) => {
    try {
      const allowed = new Set(["enabled", "message", "contestSlug"]);
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).some((key) => !allowed.has(key))) {
        return res.status(400).json({ error: "invalid banner settings body" });
      }
      const { enabled, message } = req.body;
      const suppliedContestSlug = Object.prototype.hasOwnProperty.call(req.body, "contestSlug");
      const [storedSlug, storedEnabled] = await Promise.all([
        db.appSetting.findUnique({ where: { key: "homeServiceBannerContestSlug" } }),
        db.appSetting.findUnique({ where: { key: "homeServiceBannerEnabled" } }),
      ]);
      const existingFlags = {
        homeServiceBannerContestSlug: typeof storedSlug?.value === "string" ? storedSlug.value : "",
        homeServiceBannerEnabled: storedEnabled?.value === true,
      };
      const contestSlug = suppliedContestSlug
        ? req.body.contestSlug
        : (enabled ? existingFlags.homeServiceBannerContestSlug || "" : "");
      if (typeof enabled !== "boolean" || typeof message !== "string") {
        return res.status(400).json({ error: "enabled and message are required" });
      }
      const cleanMessage = message.trim();
      const cleanSlug = typeof contestSlug === "string" ? contestSlug.trim() : null;
      if (
        (enabled && (cleanMessage.length < 1 || cleanMessage.length > 240)) ||
        (!enabled && (cleanMessage.length > 0 || cleanSlug)) ||
        cleanSlug == null ||
        (cleanSlug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cleanSlug))
      ) {
        return res.status(400).json({
          error: enabled
            ? "message must be 1 to 240 characters when enabled"
            : "message must be empty when disabled",
        });
      }
      const auditedSlug = cleanSlug || (!enabled ? existingFlags.homeServiceBannerContestSlug || "" : "");
      if (auditedSlug) {
        await transaction(async (tx) => {
          const locked = await tx.$queryRaw`
            SELECT id FROM giveaway_contests WHERE slug = ${auditedSlug} FOR UPDATE
          `;
          if (!locked.length) {
            const error = new Error("contestSlug must identify a published contest");
            error.statusCode = 400;
            throw error;
          }
          const contest = await tx.giveawayContest.findUnique({ where: { slug: auditedSlug } });
          if (enabled && (contest.lifecycleStatus !== "PUBLISHED" || cleanMessage !== contest.bannerMessage)) {
            const error = new Error(contest.lifecycleStatus !== "PUBLISHED"
              ? "contestSlug must identify a published contest"
              : "message must match the contest's frozen banner message");
            error.statusCode = 400;
            throw error;
          }
          for (const [key, value] of [
            ["homeServiceBannerEnabled", enabled],
            ["homeServiceBannerMessage", enabled ? cleanMessage : ""],
            ["homeServiceBannerContestSlug", enabled ? cleanSlug : ""],
          ]) {
            await tx.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
          }
          await tx.giveawayAuditEvent.create({ data: {
            contestId: contest.id,
            actorId: req.user.id,
            method: "PATCH:home-service-banner",
            action: enabled ? "BANNER_ACTIVATED" : "BANNER_DISABLED",
            requestBody: { enabled, contestSlug: auditedSlug },
            oldState: contest.lifecycleStatus,
            newState: contest.lifecycleStatus,
          } });
        });
        settings.bustCache?.();
        await derivedCache.invalidate({ keys: [cacheKeys.appSettingsKey], prefix: cacheKeys.PREFIX.APP_SETTINGS });
      } else {
        await settings.setFlagsAtomically([
          ["homeServiceBannerEnabled", enabled],
          ["homeServiceBannerMessage", enabled ? cleanMessage : ""],
          ["homeServiceBannerContestSlug", enabled ? cleanSlug : ""],
        ]);
      }
      // Preserve the established settings mutation envelope so the admin
      // client needs no endpoint-specific response parser.
      res.json({ settings: await settings.getAllFlags() });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Home service banner settings error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Product-health snapshot for the admin Statistics card (read-only SQL).
  //
  // `?sections=economy,ads` (batch 2026-08-09 item 10) adds opt-in aggregate
  // blocks. ABSENT means exactly today's payload and exactly today's query set,
  // which is what keeps the shipped admin build — and any collapsed section in
  // the new one — from paying for aggregates it will not render. Unknown names
  // are ignored inside getAdminStats rather than rejected here, so a newer
  // client asking for a section this backend predates degrades to a missing key.
  router.get("/stats", async (req, res) => {
    try {
      const sections = req.query?.sections;
      res.json({
        stats: await getAdminStats(
          sections ? { sections, window: req.query?.window } : {}
        ),
      });
    } catch (error) {
      if (error.statusCode === 400 && error.code) {
        return res.status(400).json({ error: error.message, code: error.code });
      }
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
          remoteOnly: item.remoteOnly,
          compatibility: item.compatibility ?? null,
          assetVersion: item.assetVersion ?? null,
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
          compatibility:
            body.compatibility === undefined ? null : sanitizeCompatibility(body.compatibility),
          active: optionalBoolean("active", true),
          // Default testOnly:true — a brand-new item's PNG isn't bundled in
          // frozen binaries yet; flip to false only after the carrying App
          // Store build has rolled out.
          testOnly: optionalBoolean("testOnly", true),
          earnOnly: optionalBoolean("earnOnly", false),
          bobble: optionalBoolean("bobble", false),
          sortOrder,
          // CDN-served art. Omit (or send null) and the item is bundled-art,
          // exactly as every item created before this feature.
          assetVersion: readAssetVersion(body) ?? null,
          remoteOnly: optionalBoolean("remoteOnly", false),
        },
      });

      await invalidateShopCaches();

      // Keep prod and staging in lockstep from birth: mirror the new item to
      // the peer DB. No-ops safely if PEER_DATABASE_URL is unset.
      const mirror = await mirrorShopItemToPeer(created);
      res.status(201).json({
        item: {
          ...serializeShopItem(created),
          active: created.active,
          testOnly: created.testOnly,
          earnOnly: created.earnOnly,
          remoteOnly: created.remoteOnly,
          compatibility: created.compatibility ?? null,
          // Admin surfaces always state assetVersion explicitly (the public
          // serializer omits it when the art is bundled) so the editor can tell
          // "bundled" from "field missing".
          assetVersion: created.assetVersion ?? null,
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
      if (body.assetVersion !== undefined) {
        // null detaches (back to bundled art); a valid hex prefix repoints the
        // item at a newly deployed PNG.
        data.assetVersion = readAssetVersion(body);
      }
      if (body.remoteOnly !== undefined) {
        if (typeof body.remoteOnly !== "boolean") {
          return res.status(400).json({ error: "remoteOnly must be a boolean" });
        }
        data.remoteOnly = body.remoteOnly;
      }
      if (body.compatibility !== undefined) {
        data.compatibility = sanitizeCompatibility(body.compatibility);
      }
      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "No updatable fields supplied" });
      }
      const updated = await prisma.shopItem.update({
        where: { id: req.params.itemId },
        data,
      });
      await invalidateShopCaches();

      // Keep prod and staging in lockstep: mirror the full item state to the
      // peer DB (matched by sku). No-ops safely if PEER_DATABASE_URL is unset.
      const mirror = await mirrorShopItemToPeer(updated);
      res.json({
        item: {
          ...serializeShopItem(updated),
          active: updated.active,
          testOnly: updated.testOnly,
          remoteOnly: updated.remoteOnly,
          compatibility: updated.compatibility ?? null,
          assetVersion: updated.assetVersion ?? null,
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
          assetVersion: item.assetVersion ?? null,
          assetUrl: powerupAssetUrl(item.powerupType, item.assetVersion),
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
      if (body.assetVersion !== undefined) {
        // CDN-served powerup icon; null detaches back to the bundled icon.
        data.assetVersion = readAssetVersion(body);
      }
      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "No updatable fields supplied" });
      }

      const updated = await prisma.powerupShopItem.update({
        where: { id: req.params.itemId },
        data,
      });
      await invalidatePowerupShopCaches();
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
          assetVersion: updated.assetVersion ?? null,
          assetUrl: powerupAssetUrl(updated.powerupType, updated.assetVersion),
        },
      });
    } catch (error) {
      // Validation errors (e.g. a malformed assetVersion) carry statusCode.
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
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
