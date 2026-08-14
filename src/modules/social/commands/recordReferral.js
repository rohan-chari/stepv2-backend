const { prisma } = require("../../../db");
const { User } = require("../../users/models/user");
const { hashAppleSub } = require("../../users/appleSubHash");
const { normalizeReferralCode } = require("../../../shared/lib/referralCode");
const { recordServerActivationEvent } = require("../../analytics/serverActivationEvents");
const {
  buildApplyAutomaticFriendship,
} = require("../services/automaticFriendship");

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
//
// RETURNS `{ attributed, code, source }` — `attributed: false` for every one of
// the silent declines below. Callers use this to decide what the provision
// response should say about `referredByCode`; reporting an ATTEMPTED code as
// attributed would hide the onboarding invite-code step from exactly the users
// whose code was rejected, which is the population that step exists to catch.
// The old callers ignored the return value entirely, so adding one is safe.
const DECLINED = { attributed: false, code: null, source: null };

function buildRecordReferral(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const userModel = dependencies.User || User;
  const hashSub = dependencies.hashAppleSub || hashAppleSub;
  const applyAutomaticFriendship =
    dependencies.applyAutomaticFriendship ||
    buildApplyAutomaticFriendship(dependencies);

  // `source` records WHICH MECHANISM produced this attribution
  // (provision_body | ip_fallback_exact | ip_fallback_net). Optional and
  // defaulted to null so every pre-existing caller and test is unaffected.
  return async function recordReferral({
    newUser,
    referralCode,
    source = null,
    sourceRaceId = null,
  }) {
    try {
      if (!newUser || !newUser.id) return DECLINED;

      const code = normalizeReferralCode(referralCode);
      if (!code) return DECLINED; // no / invalid code → organic signup

      const referrer = await userModel.findByReferralCode(code);
      if (!referrer) return DECLINED; // unknown code → skip silently
      if (referrer.id === newUser.id) return DECLINED; // self-referral guard

      // Review/demo-account exclusion (§8.10): never attribute when either side
      // is a review account, so they stay out of counts and payouts entirely.
      if (referrer.isReviewAccount === true || newUser.isReviewAccount === true) {
        return DECLINED;
      }

      // Provider-neutral stable identity: Apple users have appleId, Google
      // (Android) users have googleSub — hashing whichever is present keeps the
      // one-time attribution abuse-proof for BOTH providers (the exact bug that
      // bit onboarding boxes before — see joinRaceCore.js).
      const providerSub = newUser.appleId || newUser.googleSub || null;
      const refereeSubHash = hashSub(providerSub);
      if (!refereeSubHash) return DECLINED; // no stable identity to gate on → skip

      await db.$transaction(async (tx) => {
        const referral = await tx.referral.create({
          data: {
            referrerId: referrer.id,
            refereeId: newUser.id,
            refereeSubHash,
            code,
            status: "PENDING",
            source,
            sourceRaceId: sourceRaceId || null,
          },
        });
        // Audit-only mirror on the user row (the Referral table is the source
        // of truth for who→whom; this is just for cheap display/debugging).
        await tx.user.update({
          where: { id: newUser.id },
          data: { referredByCode: code },
        });
        if (sourceRaceId) {
          await recordServerActivationEvent({
            db: tx,
            id: `server:race-share-attributed:${referral.id}`,
            userId: referrer.id,
            name: "race_share_referral_attributed",
            context: {
              source_race_id: sourceRaceId,
              deferred_install: "true",
            },
          });
        }
      });

      // Auto-friend remains a separate best-effort write AFTER attribution, so
      // a friendship hiccup never rolls attribution back. A prior decline or
      // removal is durable user intent and suppresses this automatic source.
      try {
        await applyAutomaticFriendship({
          userAId: referrer.id,
          userBId: newUser.id,
          prisma: db,
        });
        await require("../../users/services/authMeCache").invalidatePairSafe(
          referrer.id,
          newUser.id
        );
        await require("../services/friendsTopologyCache").invalidatePairSafe(
          referrer.id,
          newUser.id
        );
      } catch (friendError) {
        console.warn(
          `Referral auto-friend skipped: ${
            friendError && friendError.message ? friendError.message : friendError
          }`
        );
      }

      return { attributed: true, code, source };
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
      // Swallowed P2002 included: the attribution did NOT happen on this
      // account, so the caller must not advertise the code as attributed.
      return DECLINED;
    }
  };
}

const recordReferral = buildRecordReferral();

module.exports = { buildRecordReferral, recordReferral };
