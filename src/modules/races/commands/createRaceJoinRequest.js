const { prisma: defaultPrisma } = require("../../../db");
const { hashShareToken } = require("../models/raceShareLink");
const { createInboxAlert } = require("../../inbox/services/inbox");
const {
  RaceJoinRequestError,
  assertRaceInviteRelationshipAllowed,
  serializeJoinRequest,
} = require("../services/raceJoinRequests");

const DECLINE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function buildCreateRaceJoinRequest(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const createAlert = dependencies.createInboxAlert || createInboxAlert;

  return async function createRaceJoinRequest({
    rawToken,
    requesterUserId,
    team = null,
    now = new Date(),
  }) {
    const outcome = await prisma.$transaction(async (tx) => {
      const link = await tx.raceShareLink.findUnique({
        where: { tokenHash: hashShareToken(rawToken) },
      });
      if (!link) {
        throw new RaceJoinRequestError("Race not found", 404, "RACE_NOT_FOUND");
      }
      if (link.revokedAt != null ||
          (link.expiresAt != null && link.expiresAt <= now)) {
        throw new RaceJoinRequestError(
          "Share link expired",
          410,
          "SHARE_LINK_EXPIRED",
        );
      }
      await tx.$queryRaw`SELECT id FROM races WHERE id = ${link.raceId} FOR UPDATE`;
      const race = await tx.race.findUnique({
        where: { id: link.raceId },
        include: { participants: true, creator: { select: { id: true } } },
      });
      if (!race) {
        throw new RaceJoinRequestError("Race not found", 404, "RACE_NOT_FOUND");
      }
      await assertRaceInviteRelationshipAllowed(
        tx,
        race.creatorId,
        requesterUserId,
      );
      if (race.status !== "PENDING") {
        throw new RaceJoinRequestError(
          "This race is not accepting approval requests",
          400,
          "RACE_NOT_JOINABLE",
        );
      }
      const existingParticipant = race.participants.find(
        (participant) => participant.userId === requesterUserId,
      );
      if (existingParticipant) {
        throw new RaceJoinRequestError(
          "You already participate in or were invited to this race",
          409,
          "ALREADY_PARTICIPATING",
        );
      }
      const acceptedCount = race.participants.filter(
        (participant) => participant.status === "ACCEPTED",
      ).length;
      if (race.maxParticipants != null && acceptedCount >= race.maxParticipants) {
        throw new RaceJoinRequestError("This race is full", 409, "RACE_FULL");
      }
      let requestedTeam = null;
      if (race.isTeamRace) {
        if (team !== "TEAM_A" && team !== "TEAM_B") {
          throw new RaceJoinRequestError("Choose a valid team", 400, "INVALID_TEAM");
        }
        const sideCount = race.participants.filter(
          (participant) => participant.status === "ACCEPTED" && participant.team === team,
        ).length;
        if (race.teamSize != null && sideCount >= race.teamSize) {
          throw new RaceJoinRequestError("That team is full", 400, "INVALID_TEAM");
        }
        requestedTeam = team;
      } else if (team != null) {
        throw new RaceJoinRequestError("This race has no teams", 400, "INVALID_TEAM");
      }

      const pending = await tx.raceJoinRequest.findFirst({
        where: { raceId: race.id, requesterUserId, status: "PENDING" },
      });
      if (pending) return { row: pending, created: false };
      const lastDecline = await tx.raceJoinRequest.findFirst({
        where: {
          raceId: race.id,
          requesterUserId,
          status: "DECLINED",
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      if (lastDecline &&
          now.getTime() - lastDecline.createdAt.getTime() < DECLINE_COOLDOWN_MS) {
        throw new RaceJoinRequestError(
          "Wait before requesting to join again",
          409,
          "JOIN_REQUEST_COOLDOWN",
        );
      }
      const [requester, creator] = await Promise.all([
        tx.user.findUnique({ where: { id: requesterUserId }, select: { displayName: true } }),
        tx.user.findUnique({ where: { id: race.creatorId }, select: { displayName: true } }),
      ]);
      if (!creator || !race.creatorId) {
        throw new RaceJoinRequestError("Race not found", 404, "RACE_NOT_FOUND");
      }
      const row = await tx.raceJoinRequest.create({
        data: {
          raceId: race.id,
          shareLinkId: link.id,
          sharedByUserId: link.sharedByUserId,
          sharedByDisplayName: link.sharedByDisplayName,
          requesterUserId,
          requesterDisplayName: requester?.displayName ?? null,
          creatorUserId: race.creatorId,
          team: requestedTeam,
        },
      });
      const sharerName = link.sharedByDisplayName || "A racer";
      const requesterName = requester?.displayName || "a friend";
      await createAlert({
        userId: race.creatorId,
        type: "PRIVATE_RACE_JOIN_APPROVAL",
        title: "Private race join request",
        body: `${sharerName} invited ${requesterName} to ${race.name}`,
        destination: {
          route: "raceJoinRequest",
          raceId: race.id,
          requestId: row.id,
        },
        sourceKey: `private-race-join-request:${row.id}`,
        now,
        tx,
      });
      return { row, created: true };
    });
    return { joinRequest: serializeJoinRequest(outcome.row), created: outcome.created };
  };
}

const createRaceJoinRequest = buildCreateRaceJoinRequest();

module.exports = {
  DECLINE_COOLDOWN_MS,
  buildCreateRaceJoinRequest,
  createRaceJoinRequest,
};
