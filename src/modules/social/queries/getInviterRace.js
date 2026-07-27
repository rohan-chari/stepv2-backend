const { prisma } = require("../../../db");

// AUTHED referral-first landing (onboarding revamp §6.3). Given the CALLER,
// resolve who referred them and which of that inviter's races the new user
// should be dropped onto instead of the generic Daily intro.
//
// Contract notes that are load-bearing for the client:
//   * Every miss — no Referral row, a deleted referrer, no joinable race — is
//     `{ race: null, inviter: null }` with a 200. It is NOT an error, so the
//     client never has to distinguish "no inviter race" from "request failed";
//     both fall through to OnboardingDailyIntroStep.
//   * A race the caller has ALREADY joined is still returned, flagged
//     `alreadyJoined: true`, so the UI can say "you're both in this one".
//
// Selection rule: the inviter is an ACCEPTED participant, status ACTIVE or
// PENDING, not a tournament matchup, not at capacity. ACTIVE beats PENDING,
// then most recent startedAt.
function buildGetInviterRace(dependencies = {}) {
  const db = dependencies.prisma || prisma;

  return async function getInviterRace({ userId }) {
    const empty = { race: null, inviter: null };
    if (!userId) return empty;

    const referral = await db.referral.findUnique({
      where: { refereeId: userId },
      select: { referrerId: true },
    });
    // referrerId is nullable (SetNull when the referrer deletes their account).
    if (!referral || !referral.referrerId) return empty;

    const inviter = await db.user.findUnique({
      where: { id: referral.referrerId },
      select: { id: true, displayName: true, profilePhotoUrl: true },
    });
    if (!inviter) return empty;

    const candidates = await db.race.findMany({
      where: {
        status: { in: ["ACTIVE", "PENDING"] },
        // Tournament matchup races are managed solely by the bracket engine and
        // are filtered out of every other race listing; they are not joinable.
        tournamentId: null,
        participants: { some: { userId: inviter.id, status: "ACCEPTED" } },
      },
      select: {
        id: true,
        name: true,
        status: true,
        endsAt: true,
        startedAt: true,
        maxParticipants: true,
        participants: {
          where: { status: "ACCEPTED" },
          select: { userId: true },
        },
      },
      orderBy: [{ startedAt: "desc" }],
    });

    // ACTIVE-before-PENDING is done HERE, not in orderBy. `status: "asc"` sorts
    // by the Postgres enum's DECLARATION order (pending, active, completed,
    // cancelled) — not alphabetically by the mapped label — so ordering on it
    // would put PENDING first, which is the opposite of the rule. Verified by
    // the ordering test in test/integration/onboarding-revamp.test.js.
    const ordered = [...candidates].sort((a, b) => {
      if (a.status !== b.status) return a.status === "ACTIVE" ? -1 : 1;
      const aStarted = a.startedAt ? a.startedAt.getTime() : -Infinity;
      const bStarted = b.startedAt ? b.startedAt.getTime() : -Infinity;
      return bStarted - aStarted;
    });

    let picked = null;
    for (const race of ordered) {
      const accepted = race.participants.length;
      const alreadyJoined = race.participants.some(
        (participant) => participant.userId === userId
      );
      // At capacity is only disqualifying for a race the caller is NOT already
      // in — if they are in it, capacity is irrelevant and "you're both in this
      // one" is still the right thing to show.
      if (
        !alreadyJoined &&
        race.maxParticipants != null &&
        accepted >= race.maxParticipants
      ) {
        continue;
      }
      picked = {
        id: race.id,
        name: race.name,
        status: race.status,
        endsAt: race.endsAt ? race.endsAt.toISOString() : null,
        participantCount: accepted,
        alreadyJoined,
        startedAt: race.startedAt,
      };
      break;
    }

    if (!picked) return empty;

    const { startedAt, ...race } = picked;

    // Display-only step count ("she's 2,400 steps in"). Deliberately a plain
    // in-window sample sum, NOT the scored race total: this is a one-line
    // teaser on an onboarding screen, and pulling the full scoring pipeline
    // (powerups, effects, tz bucketing) in for it would be a heavy query on the
    // signup path. Degrades to 0 on any miss.
    let steps = 0;
    if (startedAt) {
      try {
        const aggregate = await db.stepSample.aggregate({
          _sum: { steps: true },
          where: { userId: inviter.id, periodStart: { gte: startedAt } },
        });
        steps = aggregate?._sum?.steps ?? 0;
      } catch (error) {
        console.warn(
          `Inviter race step lookup skipped: ${
            error && error.message ? error.message : error
          }`
        );
      }
    }

    return {
      race,
      inviter: {
        id: inviter.id,
        displayName: inviter.displayName ?? null,
        profilePhotoUrl: inviter.profilePhotoUrl ?? null,
        steps,
      },
    };
  };
}

const getInviterRace = buildGetInviterRace();

module.exports = { buildGetInviterRace, getInviterRace };
