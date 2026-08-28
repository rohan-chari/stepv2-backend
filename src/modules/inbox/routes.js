const { Router } = require("express");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const { appSettings } = require("../../shared/config/appSettings");
const { prisma: defaultPrisma } = require("../../db");
const { AppError, ValidationError } = require("../../shared/errors/AppError");
const { asyncHandler } = require("../../shared/http/asyncHandler");
const {
  decodeCursor,
  encodeCursor,
  parseLimit,
  beforeCursor,
} = require("./services/inbox");
const { getInboxUnreadCounts } = require("./queries/getInboxUnreadCounts");
const { markInboxAlertRead } = require("./commands/markInboxAlertRead");
const { markInboxReadAll: defaultMarkInboxReadAll } = require("./commands/markInboxReadAll");
const { markUnreadAlertsRead } = require("./models/inbox");
const { invalidateInboxUnread } = require("./services/inbox");

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

async function enabled(req, settings = appSettings) {
  return req.clientFeatures?.has("inbox_v1") === true && (await settings.getFlag("apiInboxV1Enabled")) === true;
}
function failure(res, status, error, code) { return res.status(status).json({ error, code }); }

function serializeAlert(row) {
  const deliveryPayload = Array.isArray(row.outbox)
    ? row.outbox.find((entry) => entry?.kind === "PUSH")?.payload?.payload
    : null;
  const base = {
    id: row.id,
    type: row.type,
    ...(typeof deliveryPayload?.subtype === "string" && deliveryPayload.subtype
      ? { subtype: deliveryPayload.subtype }
      : {}),
    title: row.title,
    body: row.body,
    createdAt: row.createdAt,
    readAt: row.readAt,
  };
  const nested = row.destination;
  if (row.type === "PRIVATE_RACE_JOIN_APPROVAL" &&
      nested?.route === "raceJoinRequest") {
    return {
      ...base,
      destination: "RACE_JOIN_REQUEST",
      raceId: nested.raceId,
      requestId: nested.requestId,
      // Additive migration seam for clients already built against the nested
      // navigation object while the production UI consumes the flat intent.
      destinationDetails: nested,
    };
  }
  if (row.type === "PRIVATE_RACE_JOIN_RESULT" &&
      nested?.route === "raceDetail") {
    return {
      ...base,
      destination: "RACE",
      raceId: nested.raceId,
      requestId: nested.requestId,
      status: nested.status,
      destinationDetails: nested,
    };
  }
  return { ...base, destination: nested };
}

function createInboxRouter(dependencies = {}) {
  const router = Router();
  const requireAuth = dependencies.requireAuth || buildRequireAuth(dependencies);
  const prisma = dependencies.prisma || defaultPrisma;
  const settings = dependencies.appSettings || appSettings;
  const markInboxReadAll = dependencies.markInboxReadAll || defaultMarkInboxReadAll;
  router.use(requireAuth);

  router.post("/read-all", asyncHandler(async (req, res) => {
    try {
      if (!(await enabled(req, settings))) {
        return failure(res, 404, "Inbox is unavailable", "FEATURE_DISABLED");
      }
      if (req.body === null ||
          (req.body !== undefined &&
          (typeof req.body !== "object" || Array.isArray(req.body)))) {
        return failure(res, 400, "Invalid request body", "INVALID_BODY");
      }
      const result = await markInboxReadAll({
        userId: req.user.id,
        prisma,
      });
      return res.json(result);
    } catch (error) {
      console.error("Inbox read-all error:", error);
      throw new AppError("Internal server error", "INTERNAL_ERROR", 500);
    }
  }));

  // Capable clients clear only ordinary alerts. Staff-reply prominence is
  // owned by opening the corresponding feedback thread; the legacy read-all
  // endpoint above intentionally retains its shipped all-content behavior.
  router.post("/read-alerts", asyncHandler(async (req, res) => {
    if (!(await enabled(req, settings))) {
      return failure(res, 404, "Inbox is unavailable", "FEATURE_DISABLED");
    }
    if (req.body === null ||
        (req.body !== undefined &&
        (typeof req.body !== "object" || Array.isArray(req.body)))) {
      return failure(res, 400, "Invalid request body", "INVALID_BODY");
    }
    await markUnreadAlertsRead({ userId: req.user.id, now: new Date(), prisma });
    try {
      await invalidateInboxUnread(req.user.id);
    } catch (error) {
      console.error("Inbox read-alerts cache invalidation failed:", error);
    }
    return res.status(204).end();
  }));

  router.get("/alerts", async (req, res) => {
    try {
      if (!(await enabled(req, settings))) return failure(res, 404, "Inbox is unavailable", "FEATURE_DISABLED");
      const limit = parseLimit(req.query.limit);
      const cursor = decodeCursor(req.query.cursor);
      const now = new Date();
      const where = { userId: req.user.id, expiresAt: { gt: now }, ...(beforeCursor(cursor) || {}) };
      const [rows, unreadCounts] = await Promise.all([
        prisma.inboxAlert.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
          // Notification subtype is retained in the durable delivery intent.
          // Expose it additively while preserving every shipped Inbox field.
          include: { outbox: { select: { kind: true, payload: true } } },
        }),
        getInboxUnreadCounts({ userId: req.user.id, now, prisma }),
      ]);
      const more = rows.length > limit;
      const alerts = rows.slice(0, limit);
      res.json({
        alerts: alerts.map(serializeAlert),
        nextCursor: more ? encodeCursor(alerts.at(-1)) : null,
        ...unreadCounts,
      });
    } catch (error) {
      if (error.statusCode === 400) return failure(res, 400, error.message, error.code || "INVALID_REQUEST");
      console.error("Inbox alerts list error:", error);
      return failure(res, 500, "Internal server error", "INTERNAL_ERROR");
    }
  });

  // Express 5's brace syntax lets the same handler return the specified 400
  // for an omitted id (`/alerts/read`) as well as a malformed one. The public
  // canonical route remains `/alerts/:id/read`.
  router.post("/alerts{/:id}/read", asyncHandler(async (req, res) => {
    if (!(await enabled(req, settings))) {
      return failure(res, 404, "Inbox is unavailable", "FEATURE_DISABLED");
    }
    if (typeof req.params.id !== "string" || !UUID_RE.test(req.params.id)) {
      throw new ValidationError("Invalid alert id", "INVALID_ID");
    }

    const unreadCounts = await markInboxAlertRead({
      userId: req.user.id,
      alertId: req.params.id,
      prisma,
    });
    return res.json({ read: true, ...unreadCounts });
  }));
  return router;
}

module.exports = { createInboxRouter, enabled, serializeAlert };
