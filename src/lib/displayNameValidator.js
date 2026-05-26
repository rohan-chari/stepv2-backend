const { censor } = require("./profanity");

const DISPLAY_NAME_MIN_LENGTH = 4;
const DISPLAY_NAME_MAX_LENGTH = 30;

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
function stripInternalSpaces(name) {
  if (typeof name !== "string") return name;
  return name.replace(/\s+/g, "");
}

module.exports = {
  validateDisplayName,
  stripInternalSpaces,
  DISPLAY_NAME_MIN_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
};
