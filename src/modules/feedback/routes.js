const { Router } = require("express");
const { prisma: defaultPrisma } = require("../../db");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const {
  createSuggestion: defaultCreateSuggestion,
} = require("./commands/createSuggestion");
const { appSettings } = require("../../shared/config/appSettings");
const {
  decodeCursor, encodeCursor, parseLimit, beforeCursor, invalidateInboxUnread,
} = require("../inbox/services/inbox");

function inboxEnabled(req, settings) {
  return req.clientFeatures?.has("inbox_v1") === true && settings.getFlag("apiInboxV1Enabled");
}
function threadFailure(res, status, error, code) {
  return res.status(status).json({ error, code });
}
function validIdempotencyKey(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function cleanThreadText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length >= 1 && text.length <= 2000 ? text : null;
}
function threadExpiry(now) { return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); }

function createFeedbackRouter(dependencies = {}) {
  const router = Router();
  const prisma = dependencies.prisma || defaultPrisma;
  const requireAuth = dependencies.requireAuth || buildRequireAuth(dependencies);
  const createSuggestion =
    dependencies.createSuggestion || defaultCreateSuggestion;
  const settings = dependencies.appSettings || appSettings;

  router.use(requireAuth);

  // POST /feedback/suggestions -> 201 { ok: true }
  // 400 invalid/missing/over-long text, 429 past 5 per user per UTC day.
  router.post("/suggestions", async (req, res) => {
    try {
      const body = req.body || {};
      const result = await createSuggestion({
        userId: req.user.id,
        text: body.text,
        category: body.category,
        // Provenance only — read from headers, never required, never a reason
        // to reject. See sanitizeProvenance.
        appVersion: req.headers["x-app-version"],
        platform: req.headers["x-platform"],
        prisma,
      });
      return res.status(201).json(result);
    } catch (error) {
      if (error.statusCode === 400 || error.statusCode === 429) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Suggestion submit error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/threads", async (req, res) => {
    try {
      if (!(await inboxEnabled(req, settings))) return threadFailure(res, 404, "Inbox is unavailable", "FEATURE_DISABLED");
      const limit = parseLimit(req.query.limit);
      const cursor = decodeCursor(req.query.cursor);
      const where = {
        userId: req.user.id,
        expiresAt: { gt: new Date() },
        ...(cursor ? { OR: [
          { lastMessageAt: { lt: cursor.createdAt } },
          { lastMessageAt: cursor.createdAt, id: { lt: cursor.id } },
        ] } : {}),
      };
      const rows = await prisma.feedbackThread.findMany({
        where, take: limit + 1, orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
        include: { messages: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } },
      });
      const more = rows.length > limit;
      const threads = rows.slice(0, limit);
      return res.json({
        threads: threads.map((row) => ({
          id: row.id, preview: row.messages[0]?.text || "", lastMessageAt: row.lastMessageAt,
          unread: row.userReadAt == null,
        })),
        nextCursor: more ? encodeCursor({ id: threads.at(-1).id, createdAt: threads.at(-1).lastMessageAt }) : null,
      });
    } catch (error) {
      if (error.statusCode === 400) return threadFailure(res, 400, error.message, error.code || "INVALID_REQUEST");
      console.error("Feedback thread list error:", error);
      return threadFailure(res, 500, "Internal server error", "INTERNAL_ERROR");
    }
  });

  router.get("/threads/:id", async (req, res) => {
    try {
      if (!(await inboxEnabled(req, settings))) return threadFailure(res, 404, "Inbox is unavailable", "FEATURE_DISABLED");
      const limit = parseLimit(req.query.limit);
      const before = decodeCursor(req.query.before);
      const thread = await prisma.feedbackThread.findFirst({
        where: { id: req.params.id, userId: req.user.id, expiresAt: { gt: new Date() } },
      });
      if (!thread) return threadFailure(res, 404, "Thread not found", "NOT_FOUND");
      const rows = await prisma.feedbackMessage.findMany({
        where: { threadId: thread.id, ...(beforeCursor(before) || {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
      });
      const more = rows.length > limit;
      const page = rows.slice(0, limit);
      await prisma.feedbackThread.update({ where: { id: thread.id }, data: { userReadAt: new Date() } });
      await invalidateInboxUnread(req.user.id);
      return res.json({
        thread: { id: thread.id, expiresAt: thread.expiresAt },
        messages: [...page].reverse().map((message) => ({ id: message.id, senderKind: message.senderKind, text: message.text, createdAt: message.createdAt })),
        nextBefore: more ? encodeCursor(page.at(-1)) : null,
      });
    } catch (error) {
      if (error.statusCode === 400) return threadFailure(res, 400, error.message, error.code || "INVALID_REQUEST");
      console.error("Feedback thread detail error:", error);
      return threadFailure(res, 500, "Internal server error", "INTERNAL_ERROR");
    }
  });

  router.post("/threads/:id/messages", async (req, res) => {
    try {
      if (!(await inboxEnabled(req, settings))) return threadFailure(res, 404, "Inbox is unavailable", "FEATURE_DISABLED");
      const text = cleanThreadText(req.body?.text);
      const idempotencyKey = req.body?.idempotencyKey;
      if (!text || !validIdempotencyKey(idempotencyKey)) return threadFailure(res, 400, "Invalid message payload", "INVALID_BODY");
      const now = new Date();
      const thread = await prisma.feedbackThread.findFirst({ where: { id: req.params.id, userId: req.user.id, expiresAt: { gt: now } } });
      if (!thread) return threadFailure(res, 404, "Thread not found", "NOT_FOUND");
      const existing = await prisma.feedbackMessage.findUnique({ where: { threadId_idempotencyKey: { threadId: thread.id, idempotencyKey } } });
      if (existing) return res.status(200).json({ message: { id: existing.id, senderKind: existing.senderKind, text: existing.text, createdAt: existing.createdAt } });
      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const recent = await prisma.feedbackMessage.count({ where: { senderKind: "USER", createdAt: { gte: hourAgo }, thread: { userId: req.user.id } } });
      if (recent >= 10) return threadFailure(res, 429, "Too many support messages", "RATE_LIMITED");
      const message = await prisma.$transaction(async (tx) => {
        const created = await tx.feedbackMessage.create({ data: { threadId: thread.id, senderKind: "USER", text, idempotencyKey } });
        await tx.feedbackThread.update({ where: { id: thread.id }, data: { lastMessageAt: now, expiresAt: threadExpiry(now), userReadAt: now, staffReadAt: null } });
        return created;
      });
      return res.status(201).json({ message: { id: message.id, senderKind: message.senderKind, text: message.text, createdAt: message.createdAt } });
    } catch (error) {
      console.error("Feedback thread write error:", error);
      return threadFailure(res, 500, "Internal server error", "INTERNAL_ERROR");
    }
  });

  return router;
}

module.exports = { createFeedbackRouter };
