const { censor } = require("./profanity");

const DISPLAY_NAME_MIN_LENGTH = 4;
const DISPLAY_NAME_MAX_LENGTH = 30;

// Allowed charset: letters, numbers, underscores only (Instagram/Twitter-style).
const DISPLAY_NAME_CHARSET = /^[A-Za-z0-9_]+$/;

// Deliberately reviewed, compact English deny-list. We do not use fuzzy edit
// distance: the public-name gate must catch direct/separator/common-leet
// evasions without turning innocent near-matches into account lockouts.
const PROFANE_TOKENS = [
  "fuck", "shit", "bitch", "cunt", "asshole", "dick", "pussy", "whore",
  "slut", "nigger", "faggot",
];
const PROFANITY_ALLOWLIST = new Set([
  "assistant", "assistance", "classic", "classical", "passage", "bassoon",
  "scunthorpe",
]);
const PROFANITY_SAFE_FRAGMENTS = ["scunthorpe", "dickens", "dickinson"];

function profanityComparable(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[@4]/g, "a")
    .replace(/[!1|]/g, "i")
    .replace(/3/g, "e")
    .replace(/[05$]/g, "s")
    .replace(/7/g, "t")
    .replace(/v/g, "u")
    .replace(/[^a-z]/g, "");
}

function containsDisplayNameProfanity(raw) {
  let comparable = profanityComparable(raw);
  if (!comparable || PROFANITY_ALLOWLIST.has(comparable)) return false;
  for (const fragment of PROFANITY_SAFE_FRAGMENTS) {
    comparable = comparable.replaceAll(fragment, "");
  }
  return PROFANE_TOKENS.some((token) => comparable.includes(token));
}

function safePublicDisplayName(raw) {
  if (raw == null) return null;
  if (typeof raw !== "string" || containsDisplayNameProfanity(raw)) {
    return "Name unavailable";
  }
  return raw;
}

// Durable race/activity rows historically embedded the then-current display
// name in prose. Structured response sanitization cannot see those names, so
// readers pass the small, event-scoped set of named principals through this
// helper. Stealth takes precedence over profanity remediation because `???` is
// the stronger privacy promise.
function sanitizeDisplayNameSnapshots(
  text,
  principalIds,
  displayNameByUserId,
  stealthedUserIds = new Set(),
) {
  if (typeof text !== "string") return text;
  let sanitized = text;
  for (const userId of principalIds || []) {
    const rawName = displayNameByUserId?.get(userId);
    if (!rawName || !sanitized.includes(rawName)) continue;
    const replacement = stealthedUserIds.has(userId)
      ? "???"
      : safePublicDisplayName(rawName);
    if (replacement !== rawName) {
      sanitized = sanitized.replaceAll(rawName, replacement);
    }
  }
  return sanitized;
}

const PUBLIC_NAME_KEYS = new Set([
  "displayName",
  "displayNameSnapshot",
  "senderName",
  "actorName",
  "creatorDisplayName",
  "winnerDisplayName",
  "inviterName",
]);

function sanitizePublicUserPresentation(value) {
  if (Array.isArray(value)) return value.map(sanitizePublicUserPresentation);
  if (!value || typeof value !== "object" || value instanceof Date || Buffer.isBuffer(value)) {
    return value;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = PUBLIC_NAME_KEYS.has(key)
      ? safePublicDisplayName(child)
      : sanitizePublicUserPresentation(child);
  }
  return result;
}

// Validates a display name against the locked rules. Returns
// { isValid, error?, normalized? }. Order of checks matters: callers rely on
// the most specific message winning (spaces before length, etc.).
function validateDisplayName(raw) {
  if (typeof raw !== "string") {
    return { isValid: false, error: "Display name must be a non-empty string or null" };
  }

  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { isValid: false, error: "Display name must be a non-empty string or null" };
  }

  if (/\s/.test(trimmed)) {
    return { isValid: false, error: "Display name cannot contain spaces" };
  }

  if (!DISPLAY_NAME_CHARSET.test(trimmed)) {
    return {
      isValid: false,
      error: "Display name can only contain letters, numbers, and underscores",
    };
  }

  if (trimmed.length < DISPLAY_NAME_MIN_LENGTH) {
    return {
      isValid: false,
      error: `Display name must be at least ${DISPLAY_NAME_MIN_LENGTH} characters`,
    };
  }

  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    return {
      isValid: false,
      error: `Display name must be no more than ${DISPLAY_NAME_MAX_LENGTH} characters`,
    };
  }

  if (containsDisplayNameProfanity(trimmed) || censor(trimmed) !== trimmed) {
    return {
      isValid: false,
      // Preserve the long-standing validator contract for non-HTTP callers;
      // public write/availability endpoints map the machine code to the new
      // product copy below their transport boundary.
      error: "Display name contains inappropriate language",
      code: "DISPLAY_NAME_PROFANE",
    };
  }

  return { isValid: true, normalized: trimmed };
}

// Migration helper: removes all internal whitespace from a name.
// Superseded by normalizeToCharset for the charset migration; kept exported
// in case other code still depends on it.
function stripInternalSpaces(name) {
  if (typeof name !== "string") return name;
  return name.replace(/\s+/g, "");
}

// Migration helper: coerce a name into the allowed charset. First transliterate
// accents to ASCII (e.g. "José" -> "Jose"), then drop any character that is not
// a letter, number, or underscore (e.g. "Mary-Jane" -> "MaryJane", emoji gone).
function normalizeToCharset(name) {
  if (typeof name !== "string") return name;
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9_]/g, "");
}

module.exports = {
  validateDisplayName,
  stripInternalSpaces,
  normalizeToCharset,
  DISPLAY_NAME_MIN_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  containsDisplayNameProfanity,
  safePublicDisplayName,
  sanitizeDisplayNameSnapshots,
  sanitizePublicUserPresentation,
};
