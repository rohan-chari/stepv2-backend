const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { User } = require("../models/user");
const { awardCoins } = require("./awardCoins");
const { eventBus } = require("../events/eventBus");
const { prisma: defaultPrisma } = require("../db");
const { hashAppleSub } = require("../utils/appleSubHash");
const {
  ensureUserCanAfford,
  refundRaceBuyIn,
  reserveRaceBuyIn,
} = require("../services/raceBuyIns");

// How many bonus mystery boxes the "join your first race" onboarding grants.
const ONBOARDING_BONUS_BOXES = 3;
const DEFAULT_POWERUP_SLOTS = 3;

// Thrown for any race-join failure (full, already joined, no longer joinable,
// can't afford the buy-in). Carries an HTTP statusCode the route layer maps
// straight onto the response.
class RaceJoinError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "RaceJoinError";
    if (statusCode) this.statusCode = statusCode;
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
function buildJoinRaceCore(dependencies = {}) {
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const userModel = dependencies.User || User;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const events = dependencies.eventBus || eventBus;
  const db = dependencies.prisma || defaultPrisma;
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
  // row with type/rarity null, status MYSTERY_BOX, plus a matching
  // POWERUP_EARNED racePowerupEvent — see src/commands/rollPowerup.js).
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

          await tx.racePowerupEvent.create({
            data: {
              raceId: race.id,
              actorUserId: joiningUserId,
              eventType: "POWERUP_EARNED",
              powerupType: "MYSTERY_BOX",
              description: "Welcome gift — a mystery box!",
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
  return async function joinRaceCore({ race, userId, onboarding }) {
    const raceId = race.id;

    // Public races are joinable while PENDING or ACTIVE — seeded public races
    // are created ACTIVE, and joining a time-based race mid-flight is valid (you
    // just start accumulating steps). Only COMPLETED/CANCELLED is closed.
    if (race.status !== "PENDING" && race.status !== "ACTIVE") {
      throw new RaceJoinError(
        "This race is no longer accepting new participants",
        400
      );
    }

    const existing = await participantModel.findByRaceAndUser(raceId, userId);
    if (existing) {
      throw new RaceJoinError("You are already in this race", 400);
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

    const buyInAmount = race.buyInAmount || 0;
    if (buyInAmount > 0) {
      await ensureUserCanAfford({
        userModel,
        userId,
        amount: buyInAmount,
        ErrorClass: RaceJoinError,
      });

      await reserveRaceBuyIn({
        awardCoinsFn,
        userId,
        raceId,
        amount: buyInAmount,
      });
    }

    let participant;
    try {
      participant = await participantModel.create({
        raceId,
        userId,
        status: "ACCEPTED",
        buyInAmount,
        buyInStatus: buyInAmount > 0 ? "HELD" : "NONE",
      });
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

    return participant;
  };
}

module.exports = { buildJoinRaceCore, RaceJoinError };
