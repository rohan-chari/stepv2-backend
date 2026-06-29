const { prisma } = require("../db");
const { normalizeReferralCode } = require("../lib/referralCode");
const { REFEREE_REWARD_COINS } = require("../config/referralRewards");

// Public, UNAUTHENTICATED preview of a referral code, used by the web landing
// page (GET /r/BARA-xxxx) and the app's tailored-welcome screen
// (GET /referrals/:code). Returns ONLY display-safe fields — never the
// referrer's id or any coin internals beyond the advertised referee reward.
// Returns null when the code resolves to nothing (caller renders 404), exactly
// like getSharedRacePreview.
function buildGetReferralPreview(dependencies = {}) {
  const db = dependencies.prisma || prisma;

  return async function getReferralPreview({ code }) {
    const normalized = normalizeReferralCode(code);
    if (!normalized) return null;

    const referrer = await db.user.findUnique({
      where: { referralCode: normalized },
      select: { displayName: true, profilePhotoUrl: true },
    });
    if (!referrer) return null;

    return {
      inviterName: referrer.displayName ?? null,
      inviterAvatar: referrer.profilePhotoUrl ?? null,
      // What the NEW user earns for finishing their first qualifying race.
      rewardCoins: REFEREE_REWARD_COINS,
    };
  };
}

const getReferralPreview = buildGetReferralPreview();

module.exports = { buildGetReferralPreview, getReferralPreview };
