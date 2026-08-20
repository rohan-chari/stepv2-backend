const { ValidationError, NotFoundError, ForbiddenError } = require("../../../shared/errors/AppError");
const { impactTitle } = require("./raceImpactNotices");
const {
  RaceImpactEvent: defaultModel,
  activityProjection,
} = require("../models/raceImpactEvent");
const { prisma: defaultPrisma } = require("../../../db");

function decodeV2Cursor(value) {
  if (value == null || value === "") return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      parsed?.version !== 2 ||
      typeof parsed.id !== "string" ||
      typeof parsed.resolvedAt !== "string"
    ) throw new Error("invalid");
    const resolvedAt = new Date(parsed.resolvedAt);
    if (!Number.isFinite(resolvedAt.getTime())) throw new Error("invalid");
    return { id: parsed.id, resolvedAt };
  } catch {
    throw new ValidationError("Invalid cursor", "INVALID_CURSOR");
  }
}

function encodeV2Cursor(row) {
  return Buffer.from(JSON.stringify({
    version: 2,
    resolvedAt: row.resolvedAt.toISOString(),
    id: row.id,
  })).toString("base64url");
}

function parseBoundedLimit(value, fallback = 50) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new ValidationError("limit must be an integer from 1 to 50", "INVALID_LIMIT");
  }
  return parsed;
}

function ensureAccepted(race) {
  if (!race) throw new NotFoundError("Race not found", "NOT_FOUND");
  if (!Array.isArray(race.participants) || race.participants.length === 0) {
    throw new ForbiddenError("You are not a participant in this race", "FORBIDDEN");
  }
}

function buildGetPrivateImpactFeed(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const model = dependencies.RaceImpactEvent || defaultModel;

  return async function getPrivateImpactFeed({
    raceId,
    userId,
    cursorValue,
    limitValue,
    v2Enabled,
    completedEnabled,
  }) {
    const race = await model.getRaceAccess({ raceId, userId });
    ensureAccepted(race);
    const limit = parseBoundedLimit(limitValue, 50);

    if (race.status === "ACTIVE") {
      if (!v2Enabled) return { events: [], nextCursor: null };
      const cursor = decodeV2Cursor(cursorValue);
      const rows = await model.listActivity({ raceId, userId, cursor, limit });
      const more = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        events: page.map(activityProjection).filter(Boolean),
        nextCursor: more ? encodeV2Cursor(page.at(-1)) : null,
      };
    }

    // Terminal Activity remains authoritative settlement data. It intentionally
    // never mixes the earlier active synced snapshot into this response.
    if (!completedEnabled) {
      throw new NotFoundError("Impact feed is unavailable", "FEATURE_DISABLED");
    }
    let cursor = null;
    if (cursorValue) {
      try {
        const parsed = JSON.parse(Buffer.from(cursorValue, "base64url").toString("utf8"));
        if (!parsed || typeof parsed.id !== "string" || typeof parsed.createdAt !== "string") {
          throw new Error("invalid");
        }
        const createdAt = new Date(parsed.createdAt);
        if (!Number.isFinite(createdAt.getTime())) throw new Error("invalid");
        cursor = { id: parsed.id, createdAt };
      } catch {
        throw new ValidationError("Invalid cursor", "INVALID_CURSOR");
      }
    }
    const rows = await prisma.raceEffectImpact.findMany({
      where: {
        raceId,
        userId,
        ...(cursor ? { OR: [
          { settledAt: { lt: cursor.createdAt } },
          { settledAt: cursor.createdAt, id: { lt: cursor.id } },
        ] } : {}),
      },
      orderBy: [{ settledAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      events: page.map((row) => ({
        id: `impact:${row.id}`,
        eventType: "EFFECT_IMPACT",
        powerupType: row.powerupType,
        description: row.deltaSteps >= 0
          ? `You gained ${row.deltaSteps} steps from ${impactTitle(row.powerupType)}.`
          : `You lost ${Math.abs(row.deltaSteps)} steps to ${impactTitle(row.powerupType)}.`,
        createdAt: row.settledAt,
      })),
      nextCursor: more ? Buffer.from(JSON.stringify({
        id: page.at(-1).id,
        createdAt: page.at(-1).settledAt.toISOString(),
      })).toString("base64url") : null,
    };
  };
}

const getPrivateImpactFeed = buildGetPrivateImpactFeed();

module.exports = {
  decodeV2Cursor,
  encodeV2Cursor,
  parseBoundedLimit,
  buildGetPrivateImpactFeed,
  getPrivateImpactFeed,
};
