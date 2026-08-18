const { Router } = require("express");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const { appSettings } = require("../../shared/config/appSettings");
const { prisma: defaultPrisma } = require("../../db");
const { decodeCursor, encodeCursor, parseLimit, beforeCursor, invalidateInboxUnread } = require("./services/inbox");

async function enabled(req, settings = appSettings) {
  return req.clientFeatures?.has("inbox_v1") === true && (await settings.getFlag("apiInboxV1Enabled")) === true;
}
function failure(res, status, error, code) { return res.status(status).json({ error, code }); }

function createInboxRouter(dependencies = {}) {
  const router = Router();
  const requireAuth = dependencies.requireAuth || buildRequireAuth(dependencies);
  const prisma = dependencies.prisma || defaultPrisma;
  const settings = dependencies.appSettings || appSettings;
  router.use(requireAuth);

  router.get("/alerts", async (req, res) => {
    try {
      if (!(await enabled(req, settings))) return failure(res, 404, "Inbox is unavailable", "FEATURE_DISABLED");
      const limit = parseLimit(req.query.limit);
      const cursor = decodeCursor(req.query.cursor);
      const now = new Date();
      const where = { userId: req.user.id, expiresAt: { gt: now }, ...(beforeCursor(cursor) || {}) };
      const [rows, unreadCount] = await Promise.all([
        prisma.inboxAlert.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1 }),
        prisma.inboxAlert.count({ where: { userId: req.user.id, expiresAt: { gt: now }, readAt: null } }),
      ]);
      const more = rows.length > limit;
      const alerts = rows.slice(0, limit);
      res.json({
        alerts: alerts.map((row) => ({ id: row.id, type: row.type, title: row.title, body: row.body, destination: row.destination, createdAt: row.createdAt, readAt: row.readAt })),
        nextCursor: more ? encodeCursor(alerts.at(-1)) : null,
        unreadCount,
      });
    } catch (error) {
      if (error.statusCode === 400) return failure(res, 400, error.message, error.code || "INVALID_REQUEST");
      console.error("Inbox alerts list error:", error);
      return failure(res, 500, "Internal server error", "INTERNAL_ERROR");
    }
  });

  router.post("/alerts/:id/read", async (req, res) => {
    try {
      if (!(await enabled(req, settings))) return failure(res, 404, "Inbox is unavailable", "FEATURE_DISABLED");
      if (!req.params.id) return failure(res, 400, "Invalid alert id", "INVALID_ID");
      const result = await prisma.inboxAlert.updateMany({
        where: { id: req.params.id, userId: req.user.id, expiresAt: { gt: new Date() } },
        data: { readAt: new Date() },
      });
      if (result.count !== 1) return failure(res, 404, "Alert not found", "NOT_FOUND");
      await invalidateInboxUnread(req.user.id);
      return res.json({ read: true });
    } catch (error) {
      console.error("Inbox alert read error:", error);
      return failure(res, 500, "Internal server error", "INTERNAL_ERROR");
    }
  });
  return router;
}

module.exports = { createInboxRouter, enabled };
