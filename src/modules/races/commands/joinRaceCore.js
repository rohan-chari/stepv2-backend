const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { User } = require("../../users");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const { eventBus } = require("../../../shared/events/eventBus");
const { prisma: defaultPrisma } = require("../../../db");
const { hashAppleSub } = require("../../users");
const {
  buildAtomicHoldFn,
  ensureUserCanAfford,
  refundRaceBuyIn,
  reserveRaceBuyIn,
} = require("../services/raceBuyIns");
const {
  isTeamSideFull,
  pickAutoAssignTeam,
  clientSupportsTeamRaces,
} = require("../teamRaces");

// How many bonus mystery boxes the "join your first race" onboarding grants.
const ONBOARDING_BONUS_BOXES = 3;
const DEFAULT_POWERUP_SLOTS = 3;

// Thrown for any race-join failure (full, already joined, no longer joinable,
// can't afford the buy-in). Carries an HTTP statusCode the route layer maps
// straight onto the response.
class RaceJoinError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "RaceJoinError";
    if (statusCode) this.statusCode = statusCode;
    // Optional machine-readable code (TEAM_FULL, RACE_ALREADY_STARTED,
    // UPDATE_REQUIRED). Additive — routes serialize it alongside `error`.
    if (code) this.code = code;
  }
}

// The join steps shared by every entry point (public browse-join, share-link
// join, and any future one): given an ALREADY-RESOLVED, fresh race row, run the
// status/duplicate/capacity/buy-in checks, create the ACCEPTED participant, emit
// the join event, and grant onboarding boxes when eligible.
//
// What it deliberately does NOT do — these are the caller's responsibility,
// because they differ per entry point:
//   * resolving the race (by id vs by share token) and the 404,
//   * acquiring the per-race join lock (the caller knows the race id),
//   * the `isPublic` gate (browse-join enforces it; share-link join bypasses it
//     because possession of the unguessable token IS the invitation).
//
// Extracted verbatim from joinPublicRace so the existing public-join behavior
// (and its full unit-test suite) is preserved byte-for-byte; share-link join
// reuses the exact same money/capacity/box logic rather than duplicating it.
const {
  enqueueRaceResolution: defaultEnqueueRaceResolution,
} = require("../services/enqueueRaceResolution");
// C3 (spec §5 Phase D step 9): this write seam is a snapshot DEL hook — the
// shared standings snapshot must not outlive the change we just committed. The
// resolution worker is deliberately NOT in this list: it SETs post-commit.
const {
  invalidateRaceProgress,
} = require("../services/raceProgressSnapshot");
const {
  acquireGlobalEnrollmentLock,
  enrollIfGlobalEventActive,
} = require("../../steps/services/globalEventEnrollment");
const {
  invalidateHomeActiveGlobalEvent,
} = require("../../steps/services/globalStepEventEntitlement");

function buildJoinRaceCore(dependencies = {}) {
  // C0 (spec §5a item 4): after this command's own small writes, mark the race
  // dirty so the race-keyed worker re-converges its standings. Best-effort and
  // stubbed out for injected fakes so unit tests stay DB-free.
  const enqueueRaceResolution = Object.prototype.hasOwnProperty.call(
    dependencies,
    "enqueueRaceResolution"
  )
    ? dependencies.enqueueRaceResolution
    : Object.keys(dependencies).length > 0
      ? async () => null
      : defaultEnqueueRaceResolution;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const userModel = dependencies.User || User;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  // Holds use the balance-guarded atomic debit (ensureUserCanAfford is only a
  // fast-fail pre-check); an injected awardCoins fake still takes both roles.
  const holdCoinsFn =
    dependencies.awardCoins ||
    buildAtomicHoldFn({ ErrorClass: RaceJoinError, code: "INSUFFICIENT_COINS" });
  const events = dependencies.eventBus || eventBus;
  const db = dependencies.prisma || defaultPrisma;
  // Unit seams commonly inject only a participant model; never open a real
  // default-prisma transaction underneath those fakes. Production uses the
  // default persistence pair and takes the atomic late-join path.
  const usesDefaultPersistence = !dependencies.RaceParticipant && !dependencies.prisma;
  const hashSub = dependencies.hashAppleSub || hashAppleSub;

  // Best-effort, server-enforced one-time grant of bonus mystery boxes for the
  // "join your first race" onboarding. Eligibility is re-checked here (never
  // trusts the client flag): the race must have powerups enabled, and the
  // joining user's provider sub must not already appear in the OnboardingBoxGrant
  // ledger. The ledger key (a hash of the provider sub) is stable across
  // delete-account + reinstall + re-sign-in, so the bonus cannot be farmed.
  //
  // Failures here never break the join: the participant already exists; we only
  // log and move on. Mirrors rollPowerup's MYSTERY_BOX creation (a RacePowerup
  // row with type/rarity null and status MYSTERY_BOX), but welcome gifts are
  // deliberately not race-feed activity.
  async function maybeGrantOnboardingBoxes({ participant, race, joiningUserId }) {
    // Events to emit AFTER the grant transaction commits, so subscribers see
    // settled DB state (mirrors rollPowerup's deferred-emit pattern).
    const earnedEvents = [];
    try {
      if (!race || race.powerupsEnabled !== true) {
        return earnedEvents; // Boxes are useless on a non-powerup race.
      }

      const user = await userModel.findById(joiningUserId);
      // Provider-neutral stable identity: Apple users have appleId, Google
      // (Android) users have googleSub — each user has exactly one. Hashing
      // whichever is present keeps the one-time grant abuse-proof for BOTH
      // providers. Without this, a Google user (null appleId) hashes to null
      // and is silently skipped, getting no welcome boxes. The ledger is never
      // backfilled — rows are only minted through the insert-first transaction
      // below — so existing Apple users are never re-granted. See ANDROID.md §G1.
      const providerSub = (user && (user.appleId || user.googleSub)) || null;
      const appleSubHash = hashSub(providerSub);
      if (!appleSubHash) {
        return earnedEvents; // No stable identity to gate on — skip.
      }

      const slots =
        (participant && participant.powerupSlots) || DEFAULT_POWERUP_SLOTS;
      const boxesToGrant = Math.min(ONBOARDING_BONUS_BOXES, slots);
      if (boxesToGrant <= 0) {
        return earnedEvents;
      }

      await db.$transaction(async (tx) => {
        // Insert the ledger row first. The PK is the appleSubHash, so a
        // concurrent/duplicate attempt (incl. a prior grant from a deleted
        // account that reused this Apple sub) collides on the unique key and
        // aborts the whole transaction — no boxes, exactly-once forever.
        await tx.onboardingBoxGrant.create({ data: { appleSubHash } });

        for (let i = 0; i < boxesToGrant; i++) {
          const powerup = await tx.racePowerup.create({
            data: {
              raceId: race.id,
              participantId: participant.id,
              userId: joiningUserId,
              type: null,
              rarity: null,
              status: "MYSTERY_BOX",
              // Distinct values satisfy the @@unique([participantId,
              // earnedAtSteps]) constraint for a brand-new participant.
              earnedAtSteps: i,
            },
          });

          earnedEvents.push({
            raceId: race.id,
            userId: joiningUserId,
            powerupId: powerup.id,
          });
        }

        await tx.user.update({
          where: { id: joiningUserId },
          data: { firstRaceOnboardingSeen: true },
        });
      });
      // C5 (spec §5 Phase E2): `firstRaceOnboardingSeen` is an IMMEDIATE field —
      // the onboarding flow reads `/auth/me` back step-to-step. This raw
      // `tx.user.update` bypasses the `User.update` chokepoint, so it needs its
      // own hook. Swallowed: the join has already committed.
      try {
        await require("../../users/services/authMeCache").invalidateSafe(joiningUserId);
      } catch {}
    } catch (error) {
      // P2002 = unique violation on the ledger PK: already granted, ever. Any
      // other error is swallowed so the (already-created) join still succeeds.
      if (!error || error.code !== "P2002") {
        console.warn(
          `Onboarding box grant skipped: ${error && error.message ? error.message : error}`
        );
      }
      // If the grant transaction rolled back, no rows were created, so do not
      // emit any deferred POWERUP_EARNED events.
      return [];
    }
    return earnedEvents;
  }

  // Runs the join against an already-resolved, fresh `race`. Must be invoked
  // inside the caller's per-race join lock.
  //
  // Team races (TR-200s): `team` (TEAM_A|TEAM_B) is REQUIRED, the caller's
  // client must declare the team_races feature (TR-703), joining is only
  // possible while PENDING (TR-204), and the chosen side must have a free slot
  // (TR-202). Individual races ignore `team` entirely.
  return async function joinRaceCore({
    race,
    userId,
    onboarding,
    team = null,
    clientFeatures = null,
    transactionClient = null,
    deferPostCommit = false,
  }) {
    const raceId = race.id;

    // Public races are joinable while PENDING or ACTIVE — seeded public races
    // are created ACTIVE, and joining a time-based race mid-flight is valid (you
    // just start accumulating steps). Only COMPLETED/CANCELLED is closed.
    if (race.status !== "PENDING" && race.status !== "ACTIVE") {
      throw new RaceJoinError(
        "This race is no longer accepting new participants",
        400,
        "RACE_NOT_ACCEPTING"
      );
    }

    let joinTeam = null;
    if (race.isTeamRace) {
      // TR-703: defense-in-depth — an old client can never enter a team race.
      if (!clientSupportsTeamRaces(clientFeatures)) {
        throw new RaceJoinError(
          "Update the app to join team races",
          400,
          "UPDATE_REQUIRED"
        );
      }
      // TR-204: team races lock at start, on every join channel.
      if (race.status !== "PENDING") {
        throw new RaceJoinError(
          "This race has already started",
          409,
          "RACE_ALREADY_STARTED"
        );
      }
      if (team !== "TEAM_A" && team !== "TEAM_B") {
        // Issue 3a: no explicit side (old homepage join sends none) ->
        // auto-assign the smaller side (tie -> TEAM_A); both sides full ->
        // TEAM_FULL.
        const auto = pickAutoAssignTeam(race);
        if (!auto) {
          throw new RaceJoinError("That team is full", 409, "TEAM_FULL");
        }
        joinTeam = auto;
      } else {
        // TR-202: a side at its cap rejects joins to that side; the joiner may
        // still pick the other side.
        if (isTeamSideFull(race, team)) {
          throw new RaceJoinError("That team is full", 409, "TEAM_FULL");
        }
        joinTeam = team;
      }
    }

    const existing = await participantModel.findByRaceAndUser(raceId, userId);
    if (existing) {
      throw new RaceJoinError(
        "You are already in this race",
        400,
        "ALREADY_RESPONDED"
      );
    }

    const acceptedCount =
      typeof participantModel.countAccepted === "function"
        ? await participantModel.countAccepted(raceId)
        : race.participants.filter((p) => p.status === "ACCEPTED").length;
    // null => unlimited; only a finite cap can make a race "full".
    const maxParticipants = race.maxParticipants;
    if (maxParticipants != null && acceptedCount >= maxParticipants) {
      throw new RaceJoinError("This race is full", 400);
    }

    // App-funded races never charge to enter. Belt-and-braces: a funded race
    // already carries buyInAmount 0, and the row's fundedPrize flag (not the
    // feature flag) is what makes that permanent.
    const buyInAmount = race.fundedPrize === true ? 0 : race.buyInAmount || 0;
    if (buyInAmount > 0) {
      await ensureUserCanAfford({
        userModel,
        userId,
        amount: buyInAmount,
        ErrorClass: RaceJoinError,
        code: "INSUFFICIENT_COINS",
      });

      await reserveRaceBuyIn({
        awardCoinsFn: holdCoinsFn,
        userId,
        raceId,
        amount: buyInAmount,
      });
    }

    const createParticipant = async (client) => {
      if (race.status === "ACTIVE" && client) {
        await acquireGlobalEnrollmentLock(client);
      }
      const created = client
        ? await client.raceParticipant.create({
            data: {
              raceId,
              userId,
              status: "ACCEPTED",
              buyInAmount,
              buyInStatus: buyInAmount > 0 ? "HELD" : "NONE",
              team: joinTeam,
            },
            include: {
              user: {
                select: { id: true, displayName: true, profilePhotoUrl: true },
              },
            },
          })
        : await participantModel.create({
            raceId, userId, status: "ACCEPTED", buyInAmount,
            buyInStatus: buyInAmount > 0 ? "HELD" : "NONE", team: joinTeam,
          });
      if (race.status === "ACTIVE" && client) {
        await enrollIfGlobalEventActive(client, { raceId, userIds: [userId], at: new Date() });
      }
      return created;
    };
    let participant;
    try {
      participant = transactionClient
        ? await createParticipant(transactionClient)
        : race.status === "ACTIVE" && usesDefaultPersistence && typeof db.$transaction === "function"
          ? await db.$transaction((tx) => createParticipant(tx))
          : await createParticipant(null);
    } catch (error) {
      if (buyInAmount > 0) {
        try {
          await refundRaceBuyIn({
            awardCoinsFn,
            userId,
            raceId,
            amount: buyInAmount,
          });
        } catch {}
      }
      throw error;
    }

    const runPostCommit = async () => {
      events.emit("RACE_PUBLIC_JOINED", {
        raceId,
        userId,
        creatorUserId: race.creatorId,
        raceName: race.name,
      });

      // Onboarding first-race bonus boxes. Eligibility is enforced inside the
      // helper regardless of the flag; falsy `onboarding` => no bonus (current
      // behavior preserved for old clients that omit it).
      if (onboarding === true) {
        const grantedEvents = await maybeGrantOnboardingBoxes({
          participant,
          race,
          joiningUserId: userId,
        });
        for (const payload of grantedEvents) {
          events.emit("POWERUP_EARNED", payload);
        }
      }

      await invalidateRaceProgress(raceId);

      if (race.status === "ACTIVE" && usesDefaultPersistence) {
        await invalidateHomeActiveGlobalEvent([userId]);
      }

      await enqueueRaceResolution({
        raceId,
        userId,
        reason: "JOIN_LEAVE_KICK",
        priority: "IMMEDIATE",
      });

      // C2 invalidation (spec §5 Phase C item 6): a membership change alters
      // the chat's access context. This remains post-commit and best-effort.
      await invalidateRaceMessagesCache(raceId);
    };

    if (deferPostCommit) return { participant, runPostCommit };
    await runPostCommit();
    return participant;
  };
}


// Best-effort: a cache DEL must never fail a membership change.
async function invalidateRaceMessagesCache(raceId) {
  try {
    const {
      invalidateRace,
    } = require("../../social/services/raceMessagesCache");
    await invalidateRace(raceId);
  } catch {}
}

module.exports = { buildJoinRaceCore, RaceJoinError };
