const { prisma } = require("../../../db");
const { User } = require("../../users/models/user");
const { hashAppleSub } = require("../../users/appleSubHash");
const { normalizeReferralCode } = require("../../../shared/lib/referralCode");

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

      // Review/demo-account exclusion (§8.10): never attribute when either side
      // is a review account, so they stay out of counts and payouts entirely.
      if (referrer.isReviewAccount === true || newUser.isReviewAccount === true) {
        return;
      }

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

      // Auto-friend the pair (product decision 2026-07-12): accepting the
      // invite IS the friend request — the invitee should not have to find and
      // add the inviter manually. Separate best-effort write AFTER the
      // attribution tx so a friendship hiccup never rolls back attribution.
      // The referee is a brand-new account, so no reverse row can exist; the
      // @@unique([requesterId, addresseeId]) makes a retry a no-op (P2002).
      try {
        await db.friendship.create({
          data: {
            requesterId: referrer.id,
            addresseeId: newUser.id,
            status: "ACCEPTED",
          },
        });
      } catch (friendError) {
        if (!friendError || friendError.code !== "P2002") {
          console.warn(
            `Referral auto-friend skipped: ${
              friendError && friendError.message
                ? friendError.message
                : friendError
            }`
          );
        }
      }
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
