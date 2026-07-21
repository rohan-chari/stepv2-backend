const crypto = require("node:crypto");

const { eventBus } = require("../../../shared/events/eventBus");
const { User } = require("../models/user");
const { recordReferral } = require("../../social/commands/recordReferral");
const { autoEnrollNewUser } = require("../../races/commands/autoEnrollNewUser");
const { validateDisplayName } = require("../../../shared/lib/displayNameValidator");

// Google (Android) account provisioning — the counterpart of ensureAppleUser.js,
// keyed on the verified Google `sub` stored in user.googleSub. Kept as a separate
// self-contained module (rather than refactoring shared helpers out of
// ensureAppleUser) so the shipped Apple provisioning path stays byte-for-byte
// unchanged. Google and Apple identities are NOT linked by email — email is
// nullable/non-unique and unreliable across providers (Apple private relay, etc.),
// so each Google sign-in is an independent identity. See ANDROID.md §G1.

// Display names are never derived from the Apple/Google real name (privacy —
// the provider name stays in user.name only). New users always start with a
// generated fun name and can rename later via PUT /auth/me/display-name.
const FUN_ADJECTIVES = [
  "Swift",
  "Brisk",
  "Zippy",
  "Peppy",
  "Sunny",
  "Breezy",
  "Nimble",
  "Mighty",
  "Dashing",
  "Bouncy",
  "Zesty",
  "Snappy",
  "Chipper",
  "Merry",
  "Plucky",
  "Spry",
  "Rapid",
  "Lively",
  "Turbo",
  "Cosmic",
];
const FUN_NOUNS = [
  "Walker",
  "Trekker",
  "Strider",
  "Rambler",
  "Wanderer",
  "Pacer",
  "Hiker",
  "Capybara",
  "Corgi",
  "Gazelle",
  "Cheetah",
  "Roadrunner",
  "Penguin",
  "Otter",
  "Wombat",
  "Koala",
  "Falcon",
  "Ibex",
  "Puma",
  "Yeti",
];

function randomHex(len) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
}

function randomFunName() {
  const adjective =
    FUN_ADJECTIVES[Math.floor(Math.random() * FUN_ADJECTIVES.length)];
  const noun = FUN_NOUNS[Math.floor(Math.random() * FUN_NOUNS.length)];
  const digits = String(Math.floor(Math.random() * 100)).padStart(2, "0");
  return `${adjective}${noun}${digits}`;
}

async function pickUniqueDisplayName({ userModel, base }) {
  const candidates = [base];
  for (let i = 0; i < 5; i++) {
    candidates.push(`${base}${randomHex(2 + i)}`);
  }
  candidates.push(randomFunName());
  candidates.push(`${randomFunName()}${randomHex(4)}`);

  for (const candidate of candidates) {
    // Safety net: skip anything the validator rejects so onboarding never fails.
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
  const autoEnrollNewUserFn =
    dependencies.autoEnrollNewUser || autoEnrollNewUser;

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
        const displayName = await pickUniqueDisplayName({
          userModel,
          base: randomFunName(),
        });
        user = await userModel.update(user.id, { displayName });
      }

      // Referral attribution (M1) — create branch ONLY, best-effort/never-throws.
      // Mirrors ensureAppleUser; hashes googleSub so Android referees attribute
      // correctly (the appleId||googleSub provider-sub parity).
      await recordReferralFn({ newUser: user, referralCode });

      // Starter-race enrollment — best-effort/never-throws: every new account
      // starts inside the current seeded challenge (see autoEnrollNewUser.js).
      await autoEnrollNewUserFn({ user });

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
