const { prisma } = require("../db");
const { User } = require("../models/user");
const { hashAppleSub } = require("../utils/appleSubHash");
const { normalizeReferralCode } = require("../lib/referralCode");

// Best-effort, NEVER-throws attribution writer (M1). Called only from the
// new-user create branch of the provisioners, so:
//   * existing users can't be (re-)attributed, and
//   * a later re-sign-in can't overwrite the original attribution
// (the provisioners run on every sign-in; the create branch runs once).
//
// Writes a single Referral row deduped on the referee's provider-sub hash —
// stable across delete-account + reinstall — so a human is attributed at most
// once, ever. The unique on Referral.refereeSubHash makes a repeat a no-op
// (P2002, swallowed), closing the reinstall re-attribution hole.
//
// Any failure (bad/unknown code, self-referral, race, DB hiccup) is swallowed:
// SIGNUP MUST NEVER FAIL because of a referral code.
function buildRecordReferral(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const userModel = dependencies.User || User;
  const hashSub = dependencies.hashAppleSub || hashAppleSub;

  return async function recordReferral({ newUser, referralCode }) {
    try {
      if (!newUser || !newUser.id) return;

      const code = normalizeReferralCode(referralCode);
      if (!code) return; // no / invalid code → organic signup

      const referrer = await userModel.findByReferralCode(code);
      if (!referrer) return; // unknown code → skip silently
      if (referrer.id === newUser.id) return; // self-referral guard

      // Provider-neutral stable identity: Apple users have appleId, Google
      // (Android) users have googleSub — hashing whichever is present keeps the
      // one-time attribution abuse-proof for BOTH providers (the exact bug that
      // bit onboarding boxes before — see joinRaceCore.js).
      const providerSub = newUser.appleId || newUser.googleSub || null;
      const refereeSubHash = hashSub(providerSub);
      if (!refereeSubHash) return; // no stable identity to gate on → skip

      await db.$transaction(async (tx) => {
        await tx.referral.create({
          data: {
            referrerId: referrer.id,
            refereeId: newUser.id,
            refereeSubHash,
            code,
            status: "PENDING",
          },
        });
        // Audit-only mirror on the user row (the Referral table is the source
        // of truth for who→whom; this is just for cheap display/debugging).
        await tx.user.update({
          where: { id: newUser.id },
          data: { referredByCode: code },
        });
      });
    } catch (error) {
      // P2002 = this human was already attributed under a prior account: exactly
      // the reinstall case we want to no-op. Any other error is swallowed so the
      // (already-created) account still succeeds.
      if (!error || error.code !== "P2002") {
        console.warn(
          `Referral attribution skipped: ${
            error && error.message ? error.message : error
          }`
        );
      }
    }
  };
}

const recordReferral = buildRecordReferral();

module.exports = { buildRecordReferral, recordReferral };
