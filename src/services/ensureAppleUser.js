const crypto = require("node:crypto");

const { eventBus } = require("../events/eventBus");
const { User } = require("../models/user");
const { recordReferral } = require("../commands/recordReferral");
const { validateDisplayName } = require("../lib/displayNameValidator");

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

function buildEnsureAppleUser(dependencies = {}) {
  const userModel = dependencies.User || User;
  const events = dependencies.eventBus || eventBus;
  const recordReferralFn = dependencies.recordReferral || recordReferral;

  return async function ensureAppleUser({
    appleId,
    email,
    name,
    referralCode,
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
        const displayName = await pickUniqueDisplayName({
          userModel,
          base: randomFunName(),
        });
        user = await userModel.update(user.id, { displayName });
      }

      // Referral attribution (M1) — create branch ONLY, best-effort/never-throws.
      // A code present here came in the provision body (captured pre-sign-in);
      // codes resolved after sign-in attach via POST /referrals/redeem instead.
      await recordReferralFn({ newUser: user, referralCode });

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
