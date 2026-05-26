const { censor } = require("./profanity");

const DISPLAY_NAME_MIN_LENGTH = 4;
const DISPLAY_NAME_MAX_LENGTH = 30;

// Allowed charset: letters, numbers, underscores only (Instagram/Twitter-style).
const DISPLAY_NAME_CHARSET = /^[A-Za-z0-9_]+$/;

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

  if (censor(trimmed) !== trimmed) {
    return { isValid: false, error: "Display name contains inappropriate language" };
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
};
