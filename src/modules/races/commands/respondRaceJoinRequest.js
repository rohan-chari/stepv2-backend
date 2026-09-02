const { prisma: defaultPrisma } = require("../../../db");
const { withRaceJoinLock: defaultWithRaceJoinLock } = require("../services/raceJoinLock");
const { buildJoinRaceCore } = require("./joinRaceCore");
const { createInboxAlert } = require("../../inbox/services/inbox");
const redisCache = require("../../../shared/cache/redisCache");
const {
  RaceJoinRequestError,
  assertRaceInviteRelationshipAllowed,
  serializeJoinRequest,
} = require("../services/raceJoinRequests");

function normalizeJoinFailure(error) {
  if (error?.code === "ACTIVE_COMPETITION_LIMIT" ||
      error?.code === "FUNDED_EXPOSURE_LIMIT" ||
      error?.code === "FUNDED_EXPOSURE_RETRY") {
    return new RaceJoinRequestError(
      error.message,
      409,
      error.code,
      error.meta || null,
    );
  }
  if (error?.code === "TEAM_FULL" || error?.code === "UPDATE_REQUIRED") {
    return new RaceJoinRequestError(error.message, 400, "INVALID_TEAM");
  }
  if (error?.code === "ALREADY_RESPONDED") {
    return new RaceJoinRequestError(
      "The requester already participates in this race",
      409,
      "ALREADY_PARTICIPATING",
    );
  }
  if (/full/i.test(error?.message || "")) {
    return new RaceJoinRequestError("This race is full", 409, "RACE_FULL");
  }
  return new RaceJoinRequestError(
    error?.message || "This race is no longer joinable",
    error?.statusCode || 400,
    error?.code || "RACE_NOT_JOINABLE",
  );
}

function buildRespondRaceJoinRequest(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const withRaceJoinLock = dependencies.withRaceJoinLock || defaultWithRaceJoinLock;
  const joinRaceCore = dependencies.joinRaceCore || buildJoinRaceCore(dependencies);
  const createAlert = dependencies.createInboxAlert || createInboxAlert;
  const publishInboxWake = dependencies.publishInboxWake ||
    (() => redisCache.publishNotificationWakeup({ kind: "INBOX_DELIVERY" }));

  return async function respondRaceJoinRequest({
    raceId,
    requestId,
    creatorUserId,
    action,
    clientFeatures = null,
    now = new Date(),
  }) {
    if (action !== "ACCEPT" && action !== "DECLINE") {
      throw new RaceJoinRequestError("Invalid action", 400, "INVALID_ACTION");
    }
    const existing = await prisma.raceJoinRequest.findUnique({ where: { id: requestId } });
    if (!existing || existing.raceId !== raceId) {
      throw new RaceJoinRequestError(
        "Join request not found",
        404,
        "JOIN_REQUEST_NOT_FOUND",
      );
    }
    if (existing.creatorUserId !== creatorUserId) {
      throw new RaceJoinRequestError(
        "Only the race creator can respond",
        403,
        "NOT_RACE_CREATOR",
      );
    }
    if (existing.status !== "PENDING") {
      return { joinRequest: serializeJoinRequest(existing) };
    }

    if (action === "DECLINE") {
      const outcome = await prisma.$transaction(async (tx) => {
        const updated = await tx.raceJoinRequest.updateMany({
          where: { id: requestId, status: "PENDING" },
          data: {
            status: "DECLINED",
            respondedAt: now,
            terminalActorUserId: creatorUserId,
            failureCode: null,
          },
        });
        const terminal = await tx.raceJoinRequest.findUnique({ where: { id: requestId } });
        if (updated.count === 1) {
          await createAlert({
            userId: terminal.requesterUserId,
            type: "PRIVATE_RACE_JOIN_RESULT",
            title: "Race request declined",
            body: "The race creator declined your request to join.",
            destination: {
              route: "raceDetail",
              raceId,
              requestId,
              status: "DECLINED",
            },
            sourceKey: `private-race-join-result:${requestId}:DECLINED`,
            now,
            tx,
          });
        }
        return { row: terminal, wakeInbox: updated.count === 1 };
      });
      if (outcome.wakeInbox) await publishInboxWake().catch(() => {});
      return { joinRequest: serializeJoinRequest(outcome.row) };
    }

    const locked = await withRaceJoinLock(raceId, async (tx) => {
      const request = await tx.raceJoinRequest.findUnique({ where: { id: requestId } });
      if (!request || request.raceId !== raceId) {
        return {
          failure: new RaceJoinRequestError(
            "Join request not found",
            404,
            "JOIN_REQUEST_NOT_FOUND",
          ),
        };
      }
      if (request.status !== "PENDING") return { row: request };
      const race = await tx.race.findUnique({
        where: { id: raceId },
        include: { participants: true },
      });
      let joined;
      try {
        if (!race || race.status !== "PENDING") {
          throw new RaceJoinRequestError(
            "This race is no longer accepting approval requests",
            400,
            "RACE_NOT_JOINABLE",
          );
        }
        await assertRaceInviteRelationshipAllowed(
          tx,
          request.creatorUserId,
          request.requesterUserId,
        );
        const requesterFeatures = new Set(clientFeatures || []);
        if (request.team != null) requesterFeatures.add("team_races");
        joined = await joinRaceCore({
          race,
          userId: request.requesterUserId,
          onboarding: false,
          team: request.team,
          clientFeatures: requesterFeatures,
          transactionClient: tx,
          deferPostCommit: true,
        });
      } catch (error) {
        const failure = error instanceof RaceJoinRequestError
          ? error
          : normalizeJoinFailure(error);
        const row = await tx.raceJoinRequest.update({
          where: { id: requestId },
          data: {
            status: "EXPIRED",
            respondedAt: now,
            terminalActorUserId: creatorUserId,
            failureCode: failure.code,
          },
        });
        return { row, failure };
      }
      const row = await tx.raceJoinRequest.update({
        where: { id: requestId },
        data: {
          status: "ACCEPTED",
          respondedAt: now,
          terminalActorUserId: creatorUserId,
          failureCode: null,
        },
      });
      await createAlert({
        userId: request.requesterUserId,
        type: "PRIVATE_RACE_JOIN_RESULT",
        title: "Race request accepted",
        body: "The race creator accepted your request to join.",
        destination: {
          route: "raceDetail",
          raceId,
          requestId,
          status: "ACCEPTED",
        },
        sourceKey: `private-race-join-result:${requestId}:ACCEPTED`,
        now,
        tx,
      });
      return { row, runPostCommit: joined?.runPostCommit || null, wakeInbox: true };
    }, { fundedExposureUserIds: [existing.requesterUserId] });

    if (locked.wakeInbox) await publishInboxWake().catch(() => {});
    if (locked.runPostCommit) await locked.runPostCommit();
    if (locked.failure) throw locked.failure;
    return { joinRequest: serializeJoinRequest(locked.row) };
  };
}

const respondRaceJoinRequest = buildRespondRaceJoinRequest();

module.exports = {
  buildRespondRaceJoinRequest,
  respondRaceJoinRequest,
};
