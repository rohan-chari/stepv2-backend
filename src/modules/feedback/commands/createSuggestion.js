const { prisma: defaultPrisma } = require("../../../db");

const MAX_TEXT_LENGTH = 2000;
const MAX_CATEGORY_LENGTH = 64;
// Provenance headers are stored, never trusted. Bound them so a hostile client
// cannot write an unbounded string into the table via a header.
const MAX_PROVENANCE_LENGTH = 32;
const DAILY_SUBMISSION_LIMIT = 5;
const THREAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

class SuggestionError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "SuggestionError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

// Start of the current UTC day. Deliberately UTC rather than the submitter's
// timezone: this is an abuse limit, not a user-facing daily reward, so it must
// not be resettable by changing the device clock's zone (and it matches how the
// repo derives UTC days elsewhere — see economy/services/adUnlockPolicy).
function startOfUtcDay(now) {
  return new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

function validateText(value) {
  if (typeof value !== "string") {
    throw new SuggestionError("text is required", 400, "INVALID_TEXT");
  }
  const text = value.trim();
  if (text.length === 0) {
    throw new SuggestionError("text is required", 400, "INVALID_TEXT");
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new SuggestionError(
      `text must be ${MAX_TEXT_LENGTH} characters or fewer`,
      400,
      "INVALID_TEXT"
    );
  }
  return text;
}

function validateCategory(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > MAX_CATEGORY_LENGTH) {
    throw new SuggestionError("category is invalid", 400, "INVALID_CATEGORY");
  }
  const category = value.trim();
  return category.length === 0 ? null : category;
}

// Headers are provenance only. An absent, empty, or oversized value stores null
// — a submission is NEVER rejected because of one. A client that sends nothing
// (or a future client that sends something we do not recognise) still gets its
// feedback saved, which is the whole point of the feature.
function sanitizeProvenance(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PROVENANCE_LENGTH) {
    return null;
  }
  return trimmed;
}

async function createSuggestion({
  userId,
  text,
  category,
  appVersion,
  platform,
  prisma = defaultPrisma,
  now = new Date(),
}) {
  const cleanText = validateText(text);
  const cleanCategory = validateCategory(category);

  // Per-user, per-UTC-day count in Postgres rather than middleware, so it holds
  // across workers and restarts (same shape as claimAdCoinReward). Count-then-
  // insert is not atomic; two simultaneous submissions could both pass at the
  // boundary. That is acceptable for an abuse limit on a free-text form — the
  // cost of a rare 6th row is nil.
  const submittedToday = await prisma.suggestion.count({
    where: { userId, createdAt: { gte: startOfUtcDay(now) } },
  });
  if (submittedToday >= DAILY_SUBMISSION_LIMIT) {
    throw new SuggestionError(
      `You can send up to ${DAILY_SUBMISSION_LIMIT} suggestions per day. Try again tomorrow.`,
      429,
      "DAILY_LIMIT_REACHED"
    );
  }

  // A suggestion and its first support-message are one durable unit. Older
  // clients still receive the historical `{ok:true}` response; the thread is
  // additive server state for inbox-capable builds only.
  await prisma.$transaction(async (tx) => {
    const suggestion = await tx.suggestion.create({
      data: {
        userId,
        text: cleanText,
        category: cleanCategory,
        appVersion: sanitizeProvenance(appVersion),
        platform: sanitizeProvenance(platform),
      },
    });
    const expiresAt = new Date(now.getTime() + THREAD_RETENTION_MS);
    const thread = await tx.feedbackThread.create({
      data: { suggestionId: suggestion.id, userId, lastMessageAt: now, expiresAt, staffReadAt: null },
    });
    await tx.feedbackMessage.create({
      data: {
        threadId: thread.id,
        senderKind: "USER",
        text: cleanText,
        // Server-generated, deterministic for the immutable initial message;
        // user follow-ups use a caller idempotency UUID through the thread API.
        idempotencyKey: `initial:${suggestion.id}`,
      },
    });
  });

  return { ok: true };
}

module.exports = {
  createSuggestion,
  SuggestionError,
  MAX_TEXT_LENGTH,
  MAX_CATEGORY_LENGTH,
  DAILY_SUBMISSION_LIMIT,
  THREAD_RETENTION_MS,
};
