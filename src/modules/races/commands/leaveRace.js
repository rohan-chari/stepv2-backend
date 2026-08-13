const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const { prisma: defaultPrisma } = require("../../../db");
const { eventBus } = require("../../../shared/events/eventBus");
const { refundRaceBuyIn } = require("../services/raceBuyIns");
const { forfeitRace: defaultForfeitRace } = require("./forfeitRace");
const { buildRaceMoneyView } = require("../racePrizePool");
const {
  assertFound,
  assertStatusIn,
  refundHeldBuyIn,
} = require("../../../shared/competition/lifecycle");

// TR-205: leaving a PENDING team race is free — the HELD buy-in is released and
// the participant row is deleted, so a later re-join is a fresh join (either
// side). TR-208: the creator can never leave their own lobby (their exits are
// cancel/delete while PENDING or forfeit while ACTIVE). Team races only: the
// individual-race lobby has never had a leave affordance, and adding one would
// change shipped-client behavior.
class RaceLeaveError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "RaceLeaveError";
    if (statusCode) this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

// C3 (spec §5 Phase D step 9): this write seam is a snapshot DEL hook — the
// shared standings snapshot must not outlive the change we just committed. The
// resolution worker is deliberately NOT in this list: it SETs post-commit.
const {
  invalidateRaceProgress,
} = require("../services/raceProgressSnapshot");

function buildLeaveRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const events = dependencies.eventBus || eventBus;
  const forfeitRace = dependencies.forfeitRace || defaultForfeitRace;
  const db = dependencies.prisma || defaultPrisma;
  // Injected command doubles deliberately omit Prisma. Do not silently route
  // those tests through the process-wide database connection.
  const useTransactionalMutation =
    Object.keys(dependencies).length === 0 || dependencies.prisma != null;

  return async function leaveRace({ userId, raceId, supportsRaceLeave = false }) {
    const race = assertFound(
      await raceModel.findById(raceId),
      () => new RaceLeaveError("Race not found", 404, "RACE_NOT_FOUND")
    );
    if (race.tournamentId) {
      throw new RaceLeaveError(
        "This race is managed by its tournament",
        400,
        "TOURNAMENT_RACE_LOCKED"
      );
    }
    // Broaden ONLY for a client that knows this protocol and a race that was
    // explicitly stamped for it. Every old caller stays on the historic
    // pending-team-only path below, including its exact ACTIVE 409 behaviour.
    const expanded =
      supportsRaceLeave === true && race.exitActionsEnabled === true;
    if (race.creatorId === userId) {
      throw new RaceLeaveError(
        "The race creator can't leave. Cancel the race instead",
        400,
        "RACE_CREATOR_CANNOT_LEAVE"
      );
    }
    if (expanded && race.status === "ACTIVE") {
      try {
        await forfeitRace({
          userId,
          raceId,
          allowIndividual: true,
          requireExitPolicy: true,
        });
        const updatedRace = await raceModel.findById(raceId);
        const acceptedCount = (updatedRace?.participants || []).filter(
          (p) => p.status === "ACCEPTED"
        ).length;
        return {
          success: true,
          action: "FORFEITED",
          prizePool: buildRaceMoneyView({
            race: updatedRace,
            acceptedCount,
          }).prizePool,
        };
      } catch (error) {
        if (error.name === "RaceForfeitError") {
          throw new RaceLeaveError(error.message, error.statusCode, error.code);
        }
        throw error;
      }
    }
    if (!expanded && !race.isTeamRace) {
      throw new RaceLeaveError("This race does not support leaving", 400);
    }
    if (!expanded && race.status === "ACTIVE") {
      throw new RaceLeaveError(
        "The race has already started. You can forfeit instead",
        409,
        "RACE_ALREADY_STARTED"
      );
    }
    assertStatusIn(
      race,
      ["PENDING"],
      () => new RaceLeaveError("This race is no longer running", 400, "RACE_NOT_LEAVABLE")
    );

    let participant = await participantModel.findByRaceAndUser(raceId, userId);
    if (!participant) {
      throw new RaceLeaveError("You are not in this race", 403, "NOT_A_PARTICIPANT");
    }

    // Serialize the pending-state check, any held-buy-in release, and row
    // deletion under the race lifecycle lock. This prevents a concurrent start
    // from turning a valid lobby leave into an active-row deletion/refund.
    if (useTransactionalMutation && typeof db.$transaction === "function") {
      participant = await db.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT id FROM races WHERE id = $1 FOR UPDATE`,
          raceId
        );
        const lockedRace = await tx.race.findUnique({
          where: { id: raceId },
          select: { status: true },
        });
        if (!lockedRace || lockedRace.status !== "PENDING") {
          throw new RaceLeaveError("This race is no longer running", 400, "RACE_NOT_LEAVABLE");
        }
        const current = await tx.raceParticipant.findUnique({
          where: { raceId_userId: { raceId, userId } },
        });
        if (!current || current.status !== "ACCEPTED") {
          throw new RaceLeaveError("You are not in this race", 403, "NOT_A_PARTICIPANT");
        }
        if (
          (current.buyInAmount || 0) > 0 &&
          current.buyInStatus === "HELD"
        ) {
          await awardCoinsFn({
            userId,
            amount: current.buyInAmount,
            reason: "race_buy_in_refund",
            refId: `${raceId}:${userId}`,
            tx,
          });
        }
        await tx.raceParticipant.delete({ where: { id: current.id } });
        return current;
      });
    } else {
      // Injectable unit-test models without a transaction preserve the legacy
      // seam; the real command always takes the serialized path above.
      await refundHeldBuyIn({
        participant,
        awardCoinsFn,
        refundFn: ({ awardCoinsFn: fn, userId: uid, amount }) =>
          refundRaceBuyIn({ awardCoinsFn: fn, userId: uid, raceId, amount }),
      });
      await participantModel.delete(participant.id);
    }

    events.emit("RACE_PARTICIPANT_LEFT", {
      raceId,
      userId,
      creatorUserId: race.creatorId,
      raceName: race.name,
    });

    await invalidateRaceProgress(raceId);

    // This branch is PENDING-only. Active exits delegate to forfeitRace above,
    // which owns the one necessary enqueue.


    // C2 invalidation (spec §5 Phase C item 6): a membership change alters the

    // chat's access context (who may read it, who appears in it), so the cached

    // lists must never survive it. Same atomic `SET msgver` + `DEL list` as a

    // post, for BOTH kinds, keyed off this change's own timestamp.

    await invalidateRaceMessagesCache(raceId);
    if (!expanded) return { success: true };
    const updatedRace = await raceModel.findById(raceId);
    const acceptedCount = (updatedRace?.participants || []).filter(
      (p) => p.status === "ACCEPTED"
    ).length;
    return {
      success: true,
      action: "LEFT",
      prizePool: buildRaceMoneyView({ race: updatedRace, acceptedCount }).prizePool,
    };
  };
}

const leaveRace = buildLeaveRace();


// Best-effort: a cache DEL must never fail a membership change.
async function invalidateRaceMessagesCache(raceId) {
  try {
    const {
      invalidateRace,
    } = require("../../social/services/raceMessagesCache");
    await invalidateRace(raceId);
  } catch {}
}

module.exports = { buildLeaveRace, leaveRace, RaceLeaveError };
