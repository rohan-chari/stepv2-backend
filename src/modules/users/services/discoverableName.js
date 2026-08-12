const crypto = require("node:crypto");
const { censor } = require("../../../shared/lib/profanity");
const {
  normalizeToCharset,
  validateDisplayName,
  DISPLAY_NAME_MAX_LENGTH,
} = require("../../../shared/lib/displayNameValidator");

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const COMPONENT_PATTERN = /^[\p{L}\p{M}'’\- ]+$/u;

const FALLBACK_ADJECTIVES = [
  "Swift", "Brisk", "Zippy", "Sunny", "Nimble", "Mighty", "Breezy", "Cosmic",
];
const FALLBACK_NOUNS = [
  "Walker", "Trekker", "Strider", "Pacer", "Capybara", "Otter", "Falcon", "Yeti",
];

function normalizeComponentWhitespace(value) {
  return value.trim().replace(/\s+/gu, " ");
}

function graphemeCount(value) {
  return [...segmenter.segment(value)].length;
}

function validateDiscoverableNameComponent(raw, { required, label }) {
  if (raw === null && !required) return { valid: true, value: null };
  if (typeof raw !== "string") {
    return { valid: false, error: `${label} must be a string${required ? "" : " or null"}` };
  }
  const value = normalizeComponentWhitespace(raw);
  if (!value && !required) return { valid: true, value: null };
  const count = graphemeCount(value);
  if (count < 1 || count > 50) {
    return { valid: false, error: `${label} must be between 1 and 50 characters` };
  }
  if (/\p{C}/u.test(value) || !COMPONENT_PATTERN.test(value)) {
    return {
      valid: false,
      error: `${label} may contain only letters, apostrophes, hyphens, and spaces`,
    };
  }
  if (censor(value) !== value) {
    return { valid: false, error: `${label} contains inappropriate language` };
  }
  return { valid: true, value };
}

function normalizeDiscoverableNameSearch(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function combinedDiscoverableName(firstName, lastName) {
  return [firstName, lastName].filter(Boolean).join(" ");
}

function randomFallbackBase() {
  const adjective = FALLBACK_ADJECTIVES[Math.floor(Math.random() * FALLBACK_ADJECTIVES.length)];
  const noun = FALLBACK_NOUNS[Math.floor(Math.random() * FALLBACK_NOUNS.length)];
  const digits = String(Math.floor(Math.random() * 100)).padStart(2, "0");
  return `${adjective}${noun}${digits}`;
}

async function suggestAvailableDisplayName({ firstName, lastName, userModel, excludeUserId }) {
  const combined = combinedDiscoverableName(firstName, lastName);
  let base = normalizeToCharset(combined).slice(0, DISPLAY_NAME_MAX_LENGTH);
  if (!validateDisplayName(base).isValid) base = randomFallbackBase();

  const candidates = [base];
  for (let i = 0; i < 12; i += 1) {
    const suffix = i < 9
      ? String(Math.floor(Math.random() * 90) + 10)
      : crypto.randomBytes(2).toString("hex");
    candidates.push(`${base.slice(0, DISPLAY_NAME_MAX_LENGTH - suffix.length)}${suffix}`);
  }
  candidates.push(randomFallbackBase());

  for (const candidate of candidates) {
    if (!validateDisplayName(candidate).isValid) continue;
    const existing = await userModel.findByDisplayNameInsensitive(
      candidate,
      excludeUserId
    );
    if (!existing) return candidate;
  }
  return `${randomFallbackBase().slice(0, 26)}${crypto.randomBytes(2).toString("hex")}`;
}

module.exports = {
  validateDiscoverableNameComponent,
  normalizeDiscoverableNameSearch,
  combinedDiscoverableName,
  suggestAvailableDisplayName,
};
