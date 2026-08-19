const crypto = require("node:crypto");

const { eventBus } = require("../../../shared/events/eventBus");
const { User } = require("../models/user");
const { recordReferral } = require("../../social/commands/recordReferral");
const {
  resolveSignupAttribution,
  logAttributionResolved,
} = require("./resolveSignupAttribution");
const { autoEnrollNewUser } = require("../../races/commands/autoEnrollNewUser");
const { validateDisplayName } = require("../../../shared/lib/displayNameValidator");

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
  const autoEnrollNewUserFn =
    dependencies.autoEnrollNewUser || autoEnrollNewUser;

  return async function ensureAppleUser({
    appleId,
    email,
    name,
    referralCode,
    referralSourceRaceId = null,
    // Async thunk resolving a referral code when the body carried none (the
    // IP-correlated link_opens fallback — see findLinkOpenReferralCode.js).
    // Invoked ONLY on the create branch so an existing user re-signing in can
    // never be fallback-attributed. Best-effort: a failure means organic signup.
    fallbackReferralCode,
    nameSetupOnboardingRequired,
    metricsV2SignupEligible = false,
    metricsV2SignupEpochId = null,
    emitSignInEvent = false,
  }) {
    let user = await userModel.findByAppleId(appleId);

    if (!user) {
      user = await userModel.create({
        appleId,
        email: email || null,
        name: name || null,
        ...(nameSetupOnboardingRequired === true
          ? { nameSetupOnboardingRequired: true }
          : {}),
        ...(metricsV2SignupEligible === true && metricsV2SignupEpochId
          ? { metricsV2SignupEligible: true, metricsV2SignupEpochId }
          : {}),
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
      // With no body code, fall back to the IP-correlated link_opens match —
      // the iOS clipboard handoff silently fails often enough that the body
      // code alone loses real referrals (emersonz incident, 2026-08-07).
      const attribution = await resolveSignupAttribution({
        referralCode,
        referralSourceRaceId,
        fallbackReferralCode,
        signupId: user.id,
      });
      const outcome = await recordReferralFn({
        newUser: user,
        referralCode: attribution.code,
        source: attribution.source,
        sourceRaceId: attribution.sourceRaceId,
      });
      // FRESHNESS: `user` was built BEFORE recordReferral ran its
      // `user.update({referredByCode})`, so without this merge a
      // just-attributed signup serializes `referredByCode: null` and the
      // client shows the onboarding invite-code step to a user who was in fact
      // attributed. Merge ONLY on a confirmed attribution — recordReferral
      // declines silently on unknown code, review account, self-referral and a
      // swallowed P2002, and echoing a declined code here would hide the step
      // from precisely the users it exists to catch.
      if (outcome && outcome.attributed === true && outcome.code) {
        user = { ...user, referredByCode: outcome.code };
        logAttributionResolved({
          source: outcome.source,
          code: outcome.code,
          userId: user.id,
        });
      }

      // Starter-race enrollment — best-effort/never-throws: every new account
      // starts inside the current seeded challenge (see autoEnrollNewUser.js).
      await autoEnrollNewUserFn({ user });

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
