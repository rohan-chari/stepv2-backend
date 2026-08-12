const { prisma } = require("../../../db");
const { normalizeReferralCode } = require("../../../shared/lib/referralCode");
const {
  REFEREE_REWARD_COINS,
  REFERRER_REWARD_COINS,
} = require("../referralRewards");

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
// Only public, human-created, non-tournament, non-full PENDING/ACTIVE races the
// inviter is actually racing in qualify. Seeded challenges are excluded: new
// accounts are already auto-enrolled in those, and selecting an ACTIVE Daily
// over the human race that motivated the invite strands frozen install flows on
// the wrong destination. ACTIVE is otherwise preferred.
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
          creatorId: { not: null },
          seedId: null,
          tournamentId: null,
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
          // Read for the ACTIVE-preferred / most-recent sort below. NOT part of
          // the returned inviterRace shape — old clients read a fixed key set.
          startedAt: true,
          maxParticipants: true,
          _count: {
            select: { participants: { where: { status: "ACCEPTED" } } },
          },
        },
        orderBy: [{ startedAt: "desc" }],
      });
      // ACTIVE-before-PENDING is applied HERE, in JS, not in orderBy.
      //
      // This used to be `orderBy: [{ status: "asc" }, …]` with a comment
      // claiming "asc on the mapped enum sorts 'active' before 'pending'".
      // That is false: Postgres orders an enum by its DECLARATION order, not by
      // the mapped label text, and RaceStatus declares PENDING first
      // (schema.prisma). So the old ordering did the exact OPPOSITE of the rule
      // and showed invitees a "starts Thursday" lobby when the inviter had a
      // live race running. Covered by test/integration/onboarding-revamp.test.js.
      const ordered = [...candidates].sort((a, b) => {
        if (a.status !== b.status) return a.status === "ACTIVE" ? -1 : 1;
        const aStarted = a.startedAt ? a.startedAt.getTime() : -Infinity;
        const bStarted = b.startedAt ? b.startedAt.getTime() : -Infinity;
        return bStarted - aStarted;
      });
      for (const race of ordered) {
        const accepted = race._count?.participants ?? 0;
        if (race.maxParticipants != null && accepted >= race.maxParticipants) {
          continue;
        }
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
      // ADDITIVE (batch 2026-07-27, item 12): both sides' figures, so invite
      // copy can state a number that always matches server config. Old clients
      // ignore the extra keys; a client that sees them absent (older backend)
      // must fall back to number-free copy, never to a hardcoded guess.
      referrerCoins: REFERRER_REWARD_COINS,
      refereeCoins: REFEREE_REWARD_COINS,
      inviterRace,
    };
  };
}

const getReferralPreview = buildGetReferralPreview();

module.exports = { buildGetReferralPreview, getReferralPreview };
