const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const {
  prisma: defaultPrisma,
  runInPrismaTransaction: defaultRunInPrismaTransaction,
} = require("../../../db");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const { appendDomainEvent: defaultAppendDomainEvent } = require("../../domainEvents");
const { refundRaceBuyIn } = require("../services/raceBuyIns");
const {
  assertCreator,
  assertFound,
  assertStatusIn,
  refundHeldBuyIn,
} = require("../../../shared/competition/lifecycle");

class RaceCancelError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "RaceCancelError";
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
const {
  lockFundedExposureUsers,
} = require("../services/fundedExposure");
const { acquireRaceWriteFence } = require("../services/raceWriteFence");

function buildCancelRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const compatibilityEvents = dependencies.eventBus || null;
  const appendDomainEvent = dependencies.appendDomainEvent ||
    (Object.keys(dependencies).length > 0 ? async () => null : defaultAppendDomainEvent);
  const usesDefaultPersistence =
    !dependencies.Race &&
    !dependencies.RaceParticipant &&
    !dependencies.awardCoins;
  const runTransaction =
    dependencies.runInPrismaTransaction || defaultRunInPrismaTransaction;

  async function cancelRaceCore({ userId, raceId }) {
    if (usesDefaultPersistence) {
      await acquireRaceWriteFence(defaultPrisma, raceId);
    }
    const race = assertFound(
      await raceModel.findById(raceId),
      () => new RaceCancelError("Race not found", 404)
    );
    if (race.tournamentId) {
      throw new RaceCancelError(
        "This race is managed by its tournament",
        400,
        "TOURNAMENT_RACE_LOCKED"
      );
    }
    assertCreator(
      race,
      userId,
      () => new RaceCancelError("Only the race creator can cancel the race", 403)
    );
    // Two gate calls to keep the distinct already-completed / already-cancelled
    // errors (COMPLETED checked first, as before).
    assertStatusIn(
      race,
      ["PENDING", "ACTIVE", "CANCELLED"],
      () => new RaceCancelError("Cannot cancel a completed race", 400)
    );
    assertStatusIn(
      race,
      ["PENDING", "ACTIVE"],
      () => new RaceCancelError("Race is already cancelled", 400)
    );

    if (usesDefaultPersistence) {
      const accepted = await participantModel.findAcceptedByRace(raceId);
      if (race.fundedPrize === true) {
        await lockFundedExposureUsers(
          defaultPrisma,
          accepted.map((participant) => participant.userId),
        );
      }
      await defaultPrisma.$queryRaw`
        SELECT id FROM races WHERE id = ${raceId} FOR UPDATE
      `;
      const locked = await defaultPrisma.race.findUnique({
        where: { id: raceId },
        select: { status: true },
      });
      assertStatusIn(
        locked,
        ["PENDING", "ACTIVE"],
        () => new RaceCancelError("Race can no longer be cancelled", 409)
      );
    }

    // ACTIVE races are cancellable, so charged rows may be COMMITTED, not just
    // HELD (findChargedByRace returns both) — widen the refundable window.
    const chargedParticipants = await participantModel.findChargedByRace(raceId);
    for (const participant of chargedParticipants) {
      await refundHeldBuyIn({
        participant,
        awardCoinsFn,
        refundableStatuses: ["HELD", "COMMITTED"],
        refundFn: ({ awardCoinsFn: fn, userId: uid, amount }) =>
          refundRaceBuyIn({ awardCoinsFn: fn, userId: uid, raceId, amount }),
        onRefunded: (p) =>
          participantModel.update(p.id, { buyInStatus: "REFUNDED" }),
      });
    }

    const updated = await raceModel.update(raceId, {
      status: "CANCELLED",
      potCoins: 0,
    });

    const acceptedParticipants = await participantModel.findAcceptedByRace(raceId);
    const participantUserIds = acceptedParticipants
      .map((p) => p.userId)
      .filter((id) => id !== userId);

    const eventPayload = {
      raceId,
      raceName: race.name,
      cancellationId: raceId,
      creatorUserId: userId,
      participantUserIds,
    };

    if (usesDefaultPersistence) {
      await appendDomainEvent(defaultPrisma, {
        eventKey: `RACE_CANCELLED_V1:${raceId}`,
        eventType: "RACE_CANCELLED_V1", schemaVersion: 1,
        aggregateType: "RACE", aggregateId: raceId,
        occurredAt: updated?.updatedAt || new Date(),
        payload: {
          raceId, raceName: race.name, cancellationId: raceId, creatorUserId: userId,
        },
        audience: participantUserIds.map((recipientId) => ({ recipientId, facts: {} })),
      });
    }

    // The race is already CANCELLED; the ACTIVE-only worker would no-op.

    return { updated, eventPayload };
  }

  return async function cancelRace(args) {
    const outcome = usesDefaultPersistence
      ? await runTransaction(() => cancelRaceCore(args), {
          timeout: 15_000,
          maxWait: 5_000,
        })
      : await cancelRaceCore(args);
    if (!usesDefaultPersistence) compatibilityEvents?.emit("RACE_CANCELLED", outcome.eventPayload);
    await invalidateRaceProgress(args.raceId);
    return outcome.updated;
  };
}

const cancelRace = buildCancelRace();

module.exports = { buildCancelRace, cancelRace, RaceCancelError };
