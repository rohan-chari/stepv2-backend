const { prisma } = require("../../../db");
const {
  acquireRaceWriteFence,
  lockCompetitionRows,
} = require("./raceWriteFence");
const { lockFundedExposureUsers } = require("./fundedExposure");
const { recordServerActivationEvent } = require("../../analytics/serverActivationEvents");
const {
  enqueueRaceResolution,
} = require("./enqueueRaceResolution");
const {
  acquireGlobalEnrollmentLock,
  enrollIfGlobalEventActive,
} = require("../../steps/services/globalEventEnrollment");
const {
  invalidateHomeActiveGlobalEvent,
} = require("../../steps/services/globalStepEventEntitlement");

class RaceStartTransactionAbort extends Error {
  constructor(result) {
    super("race start transaction not applied");
    this.result = result;
  }
}

// Durable start claim. Baselines are collected before this short transaction;
// the accepted-id snapshot is rechecked under the C0 writer fence before any
// state changes. A changed field returns `participantChanged` and leaves the
// race wholly PENDING for a fresh idempotent retry.
async function commitRaceStart({
  raceId,
  actorUserId,
  startedAt,
  endsAt,
  potCoins,
  participantUpdates,
  beforeRaceStartedRecord,
  // Custom race windows §5.3a: the duration RE-DERIVED from the actual
  // (endsAt - startedAt) when a custom end is honored, written in the same CAS
  // write as the status flip so priced duration can never diverge from elapsed
  // duration. null (every legacy start) leaves the column untouched.
  maxDurationDays = null,
  // The team payout multiplier re-derived from that same duration. It MUST
  // move with maxDurationDays — settlement reads this column back verbatim, so
  // a re-priced duration carrying a stale multiplier pays a long-race buff on a
  // short race. null for individual races and every legacy start.
  teamPoolMultBps = null,
  teamPayoutVersion = null,
  teamWinnerRewardCoins = null,
}) {
  try {
    const result = await prisma.$transaction(async (tx) => {
    // Universal membership/lifecycle order: race C0 first, then the global
    // enrollment lock. acquireRaceWriteFence creates the guard row when this
    // race has never been queued, so enqueue can safely follow both locks.
    await acquireRaceWriteFence(tx, raceId);
    await acquireGlobalEnrollmentLock(tx);
    await enqueueRaceResolution({
      raceId,
      userId: actorUserId,
      reason: "RACE_START",
      priority: "IMMEDIATE",
      now: startedAt,
    }, tx);
    const discovered = await tx.raceParticipant.findMany({
      where: { raceId, status: "ACCEPTED" },
      select: { userId: true },
    });
    await lockFundedExposureUsers(
      tx,
      discovered.map((participant) => participant.userId),
    );
    await lockCompetitionRows(tx, { raceIds: [raceId] });
    const race = await tx.race.findUnique({
      where: { id: raceId },
      select: { status: true, creationSource: true, startPolicy: true, createdAt: true },
    });
    if (!race || race.status !== "PENDING") {
      throw new RaceStartTransactionAbort({ started: false });
    }

    const accepted = await tx.raceParticipant.findMany({
      where: { raceId, status: "ACCEPTED" },
      select: { id: true, userId: true },
      orderBy: { userId: "asc" },
    });
    const expected = [...participantUpdates].sort((a, b) =>
      a.userId.localeCompare(b.userId)
    );
    if (
      accepted.length !== expected.length ||
      accepted.some(
        (row, index) =>
          row.id !== expected[index].id || row.userId !== expected[index].userId
      )
    ) {
      throw new RaceStartTransactionAbort({ started: false, participantChanged: true });
    }

    const flip = await tx.race.updateMany({
      where: { id: raceId, status: "PENDING" },
      data: {
        status: "ACTIVE",
        startedAt,
        endsAt,
        potCoins,
        ...(maxDurationDays != null ? { maxDurationDays } : {}),
        ...(teamPoolMultBps != null ? { teamPoolMultBps } : {}),
        ...(teamPayoutVersion != null ? { teamPayoutVersion } : {}),
        ...(teamWinnerRewardCoins != null ? { teamWinnerRewardCoins } : {}),
      },
    });
    if (flip.count !== 1) throw new RaceStartTransactionAbort({ started: false });

    for (const participant of expected) {
      await tx.raceParticipant.update({
        where: { id: participant.id },
        data: participant.fields,
      });
    }
    // The race is now ACTIVE in this same transaction, so a start that lands
    // inside a global window durably enrolls all accepted racers before any
    // push/event can observe it.
    await enrollIfGlobalEventActive(tx, {
      raceId,
      userIds: expected.map((participant) => participant.userId),
      // `startedAt` may be a scheduled anchor in the past when a delayed cron
      // promotes a PENDING race. Membership begins at this committed transition,
      // so use wall-clock time for the currently-active event predicate.
      at: new Date(),
    });
    if (beforeRaceStartedRecord) {
      await beforeRaceStartedRecord({ tx, raceId, participantUpdates: expected });
    }
    await tx.racePowerupEvent.create({
      data: {
        raceId,
        actorUserId,
        eventType: "RACE_STARTED",
        description: "Race started!",
      },
    });
    if (
      race.creationSource === "QUICK_CREATE" &&
      race.startPolicy === "ON_MINIMUM_PARTICIPANTS"
    ) {
      await recordServerActivationEvent({
        db: tx,
        id: `server:quick-start:${raceId}`,
        userId: actorUserId,
        name: "quick_race_auto_started",
        context: {
          race_id: raceId,
          seconds_from_creation: String(
            Math.max(0, Math.floor((startedAt.getTime() - race.createdAt.getTime()) / 1000))
          ),
        },
        occurredAt: startedAt,
      });
    }
    return { started: true };
    });
    if (result.started) {
      await invalidateHomeActiveGlobalEvent(
        participantUpdates.map((participant) => participant.userId)
      );
    }
    return result;
  } catch (error) {
    if (error instanceof RaceStartTransactionAbort) return error.result;
    throw error;
  }
}

module.exports = { commitRaceStart };
