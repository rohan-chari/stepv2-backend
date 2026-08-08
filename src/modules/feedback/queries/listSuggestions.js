const { prisma: defaultPrisma } = require("../../../db");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

class SuggestionQueryError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "SuggestionQueryError";
    this.statusCode = statusCode;
  }
}

function parseLimit(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_LIMIT;
  const limit = Number.parseInt(raw, 10);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new SuggestionQueryError("limit must be a positive integer");
  }
  return Math.min(limit, MAX_LIMIT);
}

function parseBefore(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const before = new Date(raw);
  if (Number.isNaN(before.getTime())) {
    throw new SuggestionQueryError("before must be an ISO timestamp");
  }
  return before;
}

// Admin-only read. Newest first, keyset-paged on createdAt (backed by the
// suggestions_created_at_idx index) rather than OFFSET, so paging stays cheap
// as the table grows. Ties on an identical createdAt across a page boundary are
// theoretically skippable; createdAt is millisecond precision and this is a
// human-read triage list, so that is accepted rather than carrying a composite
// cursor.
async function listSuggestions({
  limit: rawLimit,
  before: rawBefore,
  prisma = defaultPrisma,
} = {}) {
  const limit = parseLimit(rawLimit);
  const before = parseBefore(rawBefore);

  const rows = await prisma.suggestion.findMany({
    where: before ? { createdAt: { lt: before } } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      userId: true,
      text: true,
      category: true,
      appVersion: true,
      platform: true,
      createdAt: true,
      user: { select: { displayName: true } },
    },
  });

  const suggestions = rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    displayName: row.user?.displayName ?? null,
    text: row.text,
    category: row.category,
    appVersion: row.appVersion,
    platform: row.platform,
    createdAt: row.createdAt.toISOString(),
  }));

  return {
    suggestions,
    // Only a FULL page can have more behind it. A short page ends the list, so
    // the client stops paging instead of issuing one more empty request.
    nextBefore:
      suggestions.length === limit && suggestions.length > 0
        ? suggestions[suggestions.length - 1].createdAt
        : null,
  };
}

module.exports = {
  listSuggestions,
  SuggestionQueryError,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
