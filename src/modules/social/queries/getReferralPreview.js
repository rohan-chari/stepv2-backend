const { prisma } = require("../../../db");
const { normalizeReferralCode } = require("../../../shared/lib/referralCode");
const { REFEREE_REWARD_COINS } = require("../referralRewards");

// Public, UNAUTHENTICATED preview of a referral code, used by the web landing
// page (GET /r/BARA-xxxx) and the app's tailored-welcome screen
// (GET /referrals/:code). Returns ONLY display-safe fields — never the
// referrer's id or any coin internals beyond the advertised referee reward.
// Returns null when the code resolves to nothing (caller renders 404), exactly
// like getSharedRacePreview.
//
// inviterRace (additive, 2026-07-12): the inviter's best currently-joinable
// race, so a referred install can be offered a one-tap "race your friend now"
// after signup instead of generic onboarding. Display-safe on purpose — the
// race id of a PUBLIC race is already exposed by the public-races browse list.
// Only public, non-full, PENDING/ACTIVE races the inviter is actually racing
// in qualify (ACTIVE preferred, so the invitee lands on a live leaderboard).
// Old clients ignore the extra key.
function buildGetReferralPreview(dependencies = {}) {
  const db = dependencies.prisma || prisma;

  return async function getReferralPreview({ code }) {
    const normalized = normalizeReferralCode(code);
    if (!normalized) return null;

    const referrer = await db.user.findUnique({
      where: { referralCode: normalized },
      select: { id: true, displayName: true, profilePhotoUrl: true },
    });
    if (!referrer) return null;

    let inviterRace = null;
    try {
      const candidates = await db.race.findMany({
        where: {
          isPublic: true,
          status: { in: ["ACTIVE", "PENDING"] },
          participants: {
            some: { userId: referrer.id, status: "ACCEPTED" },
          },
        },
        select: {
          id: true,
          name: true,
          status: true,
          endsAt: true,
          maxParticipants: true,
          _count: {
            select: { participants: { where: { status: "ACCEPTED" } } },
          },
        },
        orderBy: [{ status: "asc" }, { startedAt: "desc" }],
      });
      for (const race of candidates) {
        const accepted = race._count?.participants ?? 0;
        if (race.maxParticipants != null && accepted >= race.maxParticipants) {
          continue;
        }
        // "asc" on the mapped enum sorts 'active' before 'pending', so the
        // first non-full candidate is the ACTIVE-preferred pick.
        inviterRace = {
          id: race.id,
          name: race.name,
          status: race.status,
          endsAt: race.endsAt,
          participantCount: accepted,
        };
        break;
      }
    } catch (error) {
      // Preview must keep working even if the race lookup hiccups.
      console.warn(
        `Referral preview race lookup skipped: ${
          error && error.message ? error.message : error
        }`
      );
    }

    return {
      inviterName: referrer.displayName ?? null,
      inviterAvatar: referrer.profilePhotoUrl ?? null,
      // What the NEW user earns for finishing their first qualifying race.
      rewardCoins: REFEREE_REWARD_COINS,
      inviterRace,
    };
  };
}

const getReferralPreview = buildGetReferralPreview();

module.exports = { buildGetReferralPreview, getReferralPreview };
