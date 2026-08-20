const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const { eventBus } = require("../../../shared/events/eventBus");
const {
  prisma: defaultPrisma,
  runInPrismaTransaction: defaultRunInPrismaTransaction,
} = require("../../../db");
const { refundRaceBuyIn } = require("../services/raceBuyIns");
const {
  assertCreator,
  assertFound,
  assertStatusIn,
  refundHeldBuyIn,
} = require("../../../shared/competition/lifecycle");

class RaceKickError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "RaceKickError";
    if (statusCode) this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

const {
  enqueueRaceResolution: defaultEnqueueRaceResolution,
} = require("../services/enqueueRaceResolution");
// C3 (spec §5 Phase D step 9): this write seam is a snapshot DEL hook — the
// shared standings snapshot must not outlive the change we just committed. The
// resolution worker is deliberately NOT in this list: it SETs post-commit.
const {
  invalidateRaceProgress,
} = require("../services/raceProgressSnapshot");
const { lockFundedExposureUsers } = require("../services/fundedExposure");
const { acquireRaceWriteFence } = require("../services/raceWriteFence");

function buildKickRaceParticipant(dependencies = {}) {
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
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const events = dependencies.eventBus || eventBus;
  const db = dependencies.prisma || defaultPrisma;
  const useTransactionalMutation = dependencies.prisma != null ||
    (!dependencies.Race && !dependencies.RaceParticipant && !dependencies.awardCoins);
  const runTransaction = dependencies.runInPrismaTransaction ||
    (dependencies.prisma
      ? (callback, options) => db.$transaction(callback, options)
      : defaultRunInPrismaTransaction);
  const acquireWriteFence = dependencies.acquireRaceWriteFence || acquireRaceWriteFence;
  const lockUsers = dependencies.lockFundedExposureUsers ||
    (dependencies.prisma && !dependencies.prisma.fundedExposureGuard
      ? async () => []
      : lockFundedExposureUsers);

  return async function kickRaceParticipant({ userId, raceId, targetUserId }) {
    const race = assertFound(
      await raceModel.findById(raceId),
      () => new RaceKickError("Race not found", 404)
    );
    if (race.tournamentId) {
      throw new RaceKickError(
        "This race is managed by its tournament",
        400,
        "TOURNAMENT_RACE_LOCKED"
      );
    }
    assertCreator(
      race,
      userId,
      () => new RaceKickError("Only the race creator can remove participants", 403)
    );
    if (targetUserId === userId) {
      throw new RaceKickError("You cannot remove yourself", 400);
    }
    assertStatusIn(
      race,
      ["PENDING", "ACTIVE"],
      () => new RaceKickError("Cannot modify a completed or cancelled race", 400)
    );

    const target = await participantModel.findByRaceAndUser(raceId, targetUserId);
    if (!target) {
      throw new RaceKickError("That user is not in this race", 404);
    }

    const removeTarget = async (tx = null) => {
      let currentTarget = target;
      if (tx) {
        await acquireWriteFence(tx, raceId);
        await lockUsers(tx, [targetUserId]);
        await tx.$queryRaw`
          SELECT id FROM races WHERE id = ${raceId} FOR UPDATE
        `;
        const lockedRace = await tx.race.findUnique({
          where: { id: raceId },
          select: { status: true, creatorId: true },
        });
        if (
          !lockedRace || lockedRace.creatorId !== userId ||
          !["PENDING", "ACTIVE"].includes(lockedRace.status)
        ) {
          throw new RaceKickError("Cannot modify a completed or cancelled race", 409);
        }
        currentTarget = await tx.raceParticipant.findUnique({
          where: { raceId_userId: { raceId, userId: targetUserId } },
        });
        if (!currentTarget) throw new RaceKickError("That user is not in this race", 404);
        if (
          (currentTarget.buyInAmount || 0) > 0 &&
          currentTarget.buyInStatus === "HELD"
        ) {
          await awardCoinsFn({
            userId: currentTarget.userId,
            amount: currentTarget.buyInAmount,
            reason: "race_buy_in_refund",
            refId: `${raceId}:${currentTarget.userId}`,
            tx,
          });
        }
        await tx.raceParticipant.delete({ where: { id: currentTarget.id } });
      } else {
        await refundHeldBuyIn({
          participant: currentTarget,
          awardCoinsFn,
          refundFn: ({ awardCoinsFn: fn, userId: uid, amount }) =>
            refundRaceBuyIn({ awardCoinsFn: fn, userId: uid, raceId, amount }),
        });
        await participantModel.delete(currentTarget.id);
      }
    };

    if (useTransactionalMutation) {
      await runTransaction(removeTarget, { timeout: 15_000, maxWait: 5_000 });
    } else {
      await removeTarget();
    }

    events.emit("RACE_PARTICIPANT_KICKED", {
      raceId,
      kickedUserId: targetUserId,
      creatorUserId: userId,
      raceName: race.name,
    });

    await invalidateRaceProgress(raceId);

    if (race.status === "ACTIVE") {
      await enqueueRaceResolution({
        raceId,
        userId: targetUserId,
        reason: "JOIN_LEAVE_KICK",
        priority: "IMMEDIATE",
      });
    }


    // C2 invalidation (spec §5 Phase C item 6): a membership change alters the

    // chat's access context (who may read it, who appears in it), so the cached

    // lists must never survive it. Same atomic `SET msgver` + `DEL list` as a

    // post, for BOTH kinds, keyed off this change's own timestamp.

    await invalidateRaceMessagesCache(raceId);
    return { success: true };
  };
}

const kickRaceParticipant = buildKickRaceParticipant();


// Best-effort: a cache DEL must never fail a membership change.
async function invalidateRaceMessagesCache(raceId) {
  try {
    const {
      invalidateRace,
    } = require("../../social/services/raceMessagesCache");
    await invalidateRace(raceId);
  } catch {}
}

module.exports = {
  buildKickRaceParticipant,
  kickRaceParticipant,
  RaceKickError,
};
