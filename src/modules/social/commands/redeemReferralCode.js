const { prisma } = require("../../../db");
const { User } = require("../../users");
const { hashAppleSub } = require("../../users");
const { normalizeReferralCode } = require("../../../shared/lib/referralCode");
const {
  buildApplyAutomaticFriendship,
} = require("../services/automaticFriendship");

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
  const applyAutomaticFriendship =
    dependencies.applyAutomaticFriendship ||
    buildApplyAutomaticFriendship(dependencies);

  return async function redeemReferralCode({ user, referralCode }) {
    if (!user || !user.id) return { attributed: false, reason: "no_user" };

    const code = normalizeReferralCode(referralCode);
    if (!code) return { attributed: false, reason: "invalid_code" };

    const providerSub = user.appleId || user.googleSub || null;
    const refereeSubHash = hashSub(providerSub);
    if (!refereeSubHash) return { attributed: false, reason: "no_identity" };

    // One attribution per human, ever (survives reinstall) — refereeSubHash key.
    //
    // ONE EXCEPTION — explicit intent beats a tier-2 IP GUESS. A wrong
    // `ip_fallback_net` match would otherwise be permanent: refereeSubHash is
    // unique and this very guard answers `already_attributed` off it, so the
    // genuine inviter would be lost forever and the onboarding step would tell
    // the user "You're already connected to your inviter!" about a stranger.
    // A user typing a code is far stronger evidence than a shared /24.
    //
    // Deliberately narrow, and safe ONLY because `source` is stamped:
    //   * `ip_fallback_net` only — provision_body and ip_fallback_exact are
    //     trustworthy, and a NULL source (pre-tracking) is unknown, so none of
    //     them may be replaced;
    //   * PENDING only — a QUALIFIED/REWARDED referral has already moved coins,
    //     and re-pointing it would corrupt the payout ledger.
    // Note this reads the STAMP on the existing row, not the current env: rows
    // minted while tier 2 was enabled stay pre-emptible after it is switched
    // off, which is exactly when a bad match tends to be noticed.
    const already = await db.referral.findUnique({ where: { refereeSubHash } });
    const preemptible =
      !!already &&
      already.status === "PENDING" &&
      already.source === "ip_fallback_net";
    if (already && !preemptible) {
      return { attributed: false, reason: "already_attributed" };
    }

    const referrer = await userModel.findByReferralCode(code);
    if (!referrer) return { attributed: false, reason: "unknown_code" };
    if (referrer.id === user.id) {
      return { attributed: false, reason: "self_referral" };
    }

    // Late attribution is disallowed once they've finished a race they CHOSE
    // to join. Seeded races (seedId != null) don't count: signup auto-enrolls
    // every account into seeded dailies that settle within ~24h through no
    // action of the user's, which used to slam this door before a genuinely
    // invited friend ever saw the "enter invite code" screen (emersonz
    // incident, 2026-08-07). The anti-gaming intent — no claiming a code after
    // real self-driven engagement — is preserved by the seedId:null count.
    const completedRaces = await db.raceParticipant.count({
      where: { userId: user.id, race: { status: "COMPLETED", seedId: null } },
    });
    if (completedRaces > 0) {
      return { attributed: false, reason: "already_raced" };
    }

    try {
      await db.$transaction(async (tx) => {
        if (preemptible) {
          // deleteMany (not delete) with the guard conditions repeated: it is a
          // compare-and-swap that cannot throw P2025 if a concurrent redeem or
          // a reward settlement already moved the row. When it removes nothing,
          // the create below hits the refereeSubHash unique and we answer
          // `already_attributed` — the correct outcome for that race.
          await tx.referral.deleteMany({
            where: {
              id: already.id,
              status: "PENDING",
              source: "ip_fallback_net",
            },
          });
        }
        await tx.referral.create({
          data: {
            referrerId: referrer.id,
            refereeId: user.id,
            refereeSubHash,
            code,
            status: "PENDING",
            source: "redeem",
          },
        });
        await tx.user.update({
          where: { id: user.id },
          data: { referredByCode: code },
        });
      });

      // Best-effort AFTER the attribution transaction. The shared automatic
      // seam honors durable decline/removal suppression and existing accepted
      // rows while still upgrading an unsuppressed pending request.
      try {
        await applyAutomaticFriendship({
          userAId: referrer.id,
          userBId: user.id,
          prisma: db,
        });
        await require("../../users/services/authMeCache").invalidatePairSafe(
          referrer.id,
          user.id
        );
      } catch (friendError) {
        console.warn(
          `Referral auto-friend skipped: ${
            friendError && friendError.message ? friendError.message : friendError
          }`
        );
      }

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
