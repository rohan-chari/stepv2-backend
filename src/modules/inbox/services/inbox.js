const { prisma: defaultPrisma } = require("../../../db");
const derivedCache = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DESTINATION_ROUTES = new Set([
  "home", "dailyReward", "friends", "races", "inbox", "profile",
  "raceDetail", "tournamentDetail", "supportThread",
  "raceJoinRequest",
]);

function expiryFrom(now = new Date()) {
  return new Date(now.getTime() + RETENTION_MS);
}

function validateDestination(destination) {
  if (!destination || typeof destination !== "object" || Array.isArray(destination)) {
    throw new TypeError("Inbox destination is invalid");
  }
  if (!DESTINATION_ROUTES.has(destination.route)) {
    throw new TypeError("Inbox destination route is not allowlisted");
  }
  // Prevent arbitrary data becoming an app navigation instruction. Existing
  // route IDs are opaque strings and all other arbitrary JSON is rejected.
  const allowed = new Set([
    "route", "raceId", "tournamentId", "threadId", "requestId", "status",
  ]);
  for (const [key, value] of Object.entries(destination)) {
    if (!allowed.has(key) || (key !== "route" && (typeof value !== "string" || !value))) {
      throw new TypeError("Inbox destination is invalid");
    }
  }
  if (destination.route === "raceDetail" && typeof destination.raceId !== "string") {
    throw new TypeError("Inbox race destination requires raceId");
  }
  if (!["raceDetail", "raceJoinRequest"].includes(destination.route) &&
      "raceId" in destination) {
    throw new TypeError("Inbox destination is invalid");
  }
  if (destination.route === "tournamentDetail" && typeof destination.tournamentId !== "string") {
    throw new TypeError("Inbox tournament destination requires tournamentId");
  }
  if (destination.route !== "tournamentDetail" && "tournamentId" in destination) {
    throw new TypeError("Inbox destination is invalid");
  }
  if (destination.route === "supportThread" && typeof destination.threadId !== "string") {
    throw new TypeError("Inbox support-thread destination requires threadId");
  }
  if (destination.route !== "supportThread" && "threadId" in destination) {
    throw new TypeError("Inbox destination is invalid");
  }
  if (destination.route === "raceJoinRequest" &&
      (typeof destination.raceId !== "string" ||
       typeof destination.requestId !== "string")) {
    throw new TypeError("Inbox race-join-request destination is invalid");
  }
  if (!["raceJoinRequest", "raceDetail"].includes(destination.route) &&
      "requestId" in destination) {
    throw new TypeError("Inbox destination is invalid");
  }
  if ("status" in destination &&
      (destination.route !== "raceDetail" ||
       !["ACCEPTED", "DECLINED"].includes(destination.status))) {
    throw new TypeError("Inbox destination is invalid");
  }
  return destination;
}

// The only creation seam. It writes delivery intent with the visible alert in
// one transaction, so push failures can never erase Inbox history. Callers own
// their deterministic domain sourceKey; duplicate event/outbox retries resolve
// to the original row instead of minting another alert.
async function createInboxAlert({
  userId, type, title, body, destination, sourceKey, now = new Date(),
  payload = null, prisma = defaultPrisma, tx = null,
  expiresAt = null,
}) {
  if (!userId || typeof type !== "string" || !type || typeof title !== "string" ||
      typeof body !== "string" || !body || typeof sourceKey !== "string" || !sourceKey) {
    throw new TypeError("Inbox alert payload is invalid");
  }
  const safeDestination = validateDestination(destination);
  const db = tx || prisma;
  const write = async (client) => {
    const alert = await client.inboxAlert.upsert({
      where: { userId_sourceKey: { userId, sourceKey } },
      update: {},
      create: {
        userId, type, title, body, destination: safeDestination, sourceKey,
        expiresAt: expiryFrom(now),
      },
    });
    await client.inboxDeliveryOutbox.upsert({
      where: { alertId_kind: { alertId: alert.id, kind: "PUSH" } },
      update: expiresAt ? { expiresAt } : {},
      create: {
        alertId: alert.id,
        payload: {
          title,
          body,
          destination: safeDestination,
          ...(payload && typeof payload === "object" ? { payload } : {}),
        },
        // Preserve the producer's transaction time. Scheduled intents are
        // materialized exactly at their boundary; using the database clock
        // here can make a newly-created due row appear to be in the future.
        availableAt: now,
        expiresAt,
      },
    });
    return alert;
  };
  const alert = tx ? await write(db) : await prisma.$transaction(write);
  // An outer transaction must invalidate after COMMIT itself (calling Redis
  // while still inside it would advertise data that could roll back).
  if (!tx) await invalidateInboxUnread(userId);
  return alert;
}

async function invalidateInboxUnread(userId) {
  return invalidateInboxUnreadMany(userId ? [userId] : []);
}

async function invalidateInboxUnreadMany(userIds) {
  const unique = [...new Set((userIds || []).filter(Boolean))];
  if (!unique.length) return;
  await derivedCache.invalidate({
    keys: unique.map((userId) => cacheKeys.homeInboxUnread(userId)),
    prefix: cacheKeys.PREFIX.HOME_INBOX_UNREAD,
  });
}

function decodeCursor(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("Invalid cursor");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed.id !== "string" || typeof parsed.createdAt !== "string" ||
        Number.isNaN(Date.parse(parsed.createdAt))) throw new Error("Invalid cursor");
    return { id: parsed.id, createdAt: new Date(parsed.createdAt) };
  } catch {
    const error = new Error("Invalid cursor");
    error.statusCode = 400;
    error.code = "INVALID_CURSOR";
    throw error;
  }
}

function encodeCursor(row) {
  if (!row) return null;
  return Buffer.from(JSON.stringify({ id: row.id, createdAt: row.createdAt.toISOString() })).toString("base64url");
}

function parseLimit(value, fallback = 25) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    const error = new Error("limit must be an integer from 1 to 50");
    error.statusCode = 400;
    error.code = "INVALID_LIMIT";
    throw error;
  }
  return parsed;
}

function beforeCursor(cursor) {
  if (!cursor) return undefined;
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

module.exports = {
  RETENTION_MS, expiryFrom, createInboxAlert, decodeCursor, encodeCursor,
  parseLimit, beforeCursor, invalidateInboxUnread, invalidateInboxUnreadMany,
};
