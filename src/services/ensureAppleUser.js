const crypto = require("node:crypto");

const { eventBus } = require("../events/eventBus");
const { User } = require("../models/user");
const {
  validateDisplayName,
  normalizeToCharset,
} = require("../lib/displayNameValidator");

const DISPLAY_NAME_MIN_LENGTH = 4;
const FUN_PREFIXES = [
  "Walker",
  "Trekker",
  "Strider",
  "Rambler",
  "Wanderer",
  "Pacer",
  "Hiker",
  "Capybara",
];

function randomHex(len) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
}

function sanitize(name) {
  if (typeof name !== "string") return "";
  // Display names must match the allowed charset (letters, numbers, underscore).
  // Transliterate accents and drop any other character (incl. whitespace) so a
  // derived Apple name like "José García" becomes "JoseGarcia".
  return normalizeToCharset(name).trim();
}

function baseFromAppleName(name) {
  const clean = sanitize(name);
  if (!clean) return null;
  if (clean.length >= DISPLAY_NAME_MIN_LENGTH) return clean;
  return clean + randomHex(DISPLAY_NAME_MIN_LENGTH - clean.length);
}

function randomFunName() {
  const prefix = FUN_PREFIXES[Math.floor(Math.random() * FUN_PREFIXES.length)];
  return `${prefix}${randomHex(4)}`;
}

async function pickUniqueDisplayName({ userModel, base }) {
  const candidates = [base];
  for (let i = 0; i < 5; i++) {
    candidates.push(`${base}${randomHex(2 + i)}`);
  }
  // Always end with guaranteed-valid generated fallbacks so onboarding never
  // fails even if the Apple-derived base is profane or otherwise invalid.
  candidates.push(randomFunName());
  candidates.push(`${randomFunName()}${randomHex(4)}`);

  for (const candidate of candidates) {
    // A derived candidate could fail the stricter rules (e.g. profane Apple
    // name). Skip invalid candidates; the generated fallbacks always pass.
    if (!validateDisplayName(candidate).isValid) continue;
    const taken = await userModel.findByDisplayNameInsensitive(candidate);
    if (!taken) return candidate;
  }
  return `${randomFunName()}${randomHex(4)}`;
}

function buildEnsureAppleUser(dependencies = {}) {
  const userModel = dependencies.User || User;
  const events = dependencies.eventBus || eventBus;

  return async function ensureAppleUser({
    appleId,
    email,
    name,
    emitSignInEvent = false,
  }) {
    let user = await userModel.findByAppleId(appleId);

    if (!user) {
      user = await userModel.create({
        appleId,
        email: email || null,
        name: name || null,
      });

      if (!user.displayName) {
        const base = baseFromAppleName(name) || randomFunName();
        const displayName = await pickUniqueDisplayName({ userModel, base });
        user = await userModel.update(user.id, { displayName });
      }

      events.emit("USER_REGISTERED", {
        userId: user.id,
        appleId,
      });
    } else {
      const fieldsToUpdate = {};

      if (email && email !== user.email) {
        fieldsToUpdate.email = email;
      }

      if (name && name !== user.name) {
        fieldsToUpdate.name = name;
      }

      if (Object.keys(fieldsToUpdate).length > 0) {
        user = await userModel.update(user.id, fieldsToUpdate);
      }
    }

    if (emitSignInEvent) {
      events.emit("USER_SIGNED_IN", { userId: user.id });
    }

    return user;
  };
}

const ensureAppleUser = buildEnsureAppleUser();

module.exports = { buildEnsureAppleUser, ensureAppleUser };
