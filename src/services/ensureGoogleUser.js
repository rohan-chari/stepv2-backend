const crypto = require("node:crypto");

const { eventBus } = require("../events/eventBus");
const { User } = require("../models/user");
const { recordReferral } = require("../commands/recordReferral");
const {
  validateDisplayName,
  normalizeToCharset,
} = require("../lib/displayNameValidator");

// Google (Android) account provisioning — the counterpart of ensureAppleUser.js,
// keyed on the verified Google `sub` stored in user.googleSub. Kept as a separate
// self-contained module (rather than refactoring shared helpers out of
// ensureAppleUser) so the shipped Apple provisioning path stays byte-for-byte
// unchanged. Google and Apple identities are NOT linked by email — email is
// nullable/non-unique and unreliable across providers (Apple private relay, etc.),
// so each Google sign-in is an independent identity. See ANDROID.md §G1.

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
  return normalizeToCharset(name).trim();
}

function baseFromProviderName(name) {
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
  candidates.push(randomFunName());
  candidates.push(`${randomFunName()}${randomHex(4)}`);

  for (const candidate of candidates) {
    if (!validateDisplayName(candidate).isValid) continue;
    const taken = await userModel.findByDisplayNameInsensitive(candidate);
    if (!taken) return candidate;
  }
  return `${randomFunName()}${randomHex(4)}`;
}

function buildEnsureGoogleUser(dependencies = {}) {
  const userModel = dependencies.User || User;
  const events = dependencies.eventBus || eventBus;
  const recordReferralFn = dependencies.recordReferral || recordReferral;

  return async function ensureGoogleUser({
    googleSub,
    email,
    name,
    referralCode,
    emitSignInEvent = false,
  }) {
    let user = await userModel.findByGoogleSub(googleSub);

    if (!user) {
      user = await userModel.create({
        googleSub,
        email: email || null,
        name: name || null,
      });

      if (!user.displayName) {
        const base = baseFromProviderName(name) || randomFunName();
        const displayName = await pickUniqueDisplayName({ userModel, base });
        user = await userModel.update(user.id, { displayName });
      }

      // Referral attribution (M1) — create branch ONLY, best-effort/never-throws.
      // Mirrors ensureAppleUser; hashes googleSub so Android referees attribute
      // correctly (the appleId||googleSub provider-sub parity).
      await recordReferralFn({ newUser: user, referralCode });

      events.emit("USER_REGISTERED", {
        userId: user.id,
        googleSub,
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

const ensureGoogleUser = buildEnsureGoogleUser();

module.exports = { buildEnsureGoogleUser, ensureGoogleUser };
