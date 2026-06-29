const { prisma } = require("../db");
const { User } = require("../models/user");
const { hashAppleSub } = require("../utils/appleSubHash");
const { normalizeReferralCode } = require("../lib/referralCode");

// Attach a referrer to an ALREADY-signed-in user (M1, late path). Used when the
// code wasn't in the provision body — i.e. an iOS UIPasteControl tap or manual
// entry that resolved AFTER account creation. Converges on the exact same
// Referral write as the create-branch path, deduped on the referee's provider-
// sub hash, so a code arriving via both paths can't double-attribute.
//
// Guards (returns a structured {attributed, reason} — never throws on user
// error): valid code, stable identity, not already attributed (one per human
// ever), known code, not self-referral, and — critically — ONLY before the
// user's first COMPLETED race, so attribution can't be claimed after they've
// already engaged (anti-gaming).
function buildRedeemReferralCode(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const userModel = dependencies.User || User;
  const hashSub = dependencies.hashAppleSub || hashAppleSub;

  return async function redeemReferralCode({ user, referralCode }) {
    if (!user || !user.id) return { attributed: false, reason: "no_user" };

    const code = normalizeReferralCode(referralCode);
    if (!code) return { attributed: false, reason: "invalid_code" };

    const providerSub = user.appleId || user.googleSub || null;
    const refereeSubHash = hashSub(providerSub);
    if (!refereeSubHash) return { attributed: false, reason: "no_identity" };

    // One attribution per human, ever (survives reinstall) — refereeSubHash key.
    const already = await db.referral.findUnique({ where: { refereeSubHash } });
    if (already) return { attributed: false, reason: "already_attributed" };

    const referrer = await userModel.findByReferralCode(code);
    if (!referrer) return { attributed: false, reason: "unknown_code" };
    if (referrer.id === user.id) {
      return { attributed: false, reason: "self_referral" };
    }

    // Late attribution is disallowed once they've already finished a race.
    const completedRaces = await db.raceParticipant.count({
      where: { userId: user.id, race: { status: "COMPLETED" } },
    });
    if (completedRaces > 0) {
      return { attributed: false, reason: "already_raced" };
    }

    try {
      await db.$transaction(async (tx) => {
        await tx.referral.create({
          data: {
            referrerId: referrer.id,
            refereeId: user.id,
            refereeSubHash,
            code,
            status: "PENDING",
          },
        });
        await tx.user.update({
          where: { id: user.id },
          data: { referredByCode: code },
        });
      });
      return { attributed: true };
    } catch (error) {
      // Lost a race to a concurrent attribution (refereeSubHash/refereeId unique).
      if (error && error.code === "P2002") {
        return { attributed: false, reason: "already_attributed" };
      }
      throw error;
    }
  };
}

const redeemReferralCode = buildRedeemReferralCode();

module.exports = { buildRedeemReferralCode, redeemReferralCode };
