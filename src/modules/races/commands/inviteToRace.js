const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { Friendship } = require("../../social");
const { User } = require("../../users");
const { appendDomainEvent: defaultAppendDomainEvent } = require("../../domainEvents");
const { TEAM_RACES_FEATURE } = require("../teamRaces");
const { prisma: defaultPrisma } = require("../../../db");
const { acquireRaceWriteFence } = require("../services/raceWriteFence");
const { lockFundedExposureUsers } = require("../services/fundedExposure");

const INVITE_TTL_HOURS = 72;

class RaceInviteError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "RaceInviteError";
    if (statusCode) this.statusCode = statusCode;
    // Optional machine-readable code (INVITEE_NEEDS_UPDATE). Additive.
    if (code) this.code = code;
  }
}

function buildInviteToRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const friendshipModel = dependencies.Friendship || Friendship;
  const userModel = dependencies.User || User;
  const compatibilityEvents = dependencies.eventBus || null;
  const appendDomainEvent = dependencies.appendDomainEvent ||
    (Object.keys(dependencies).length > 0 ? async () => null : defaultAppendDomainEvent);
  const db = dependencies.prisma || defaultPrisma;
  const acquireWriteFence = dependencies.acquireRaceWriteFence ||
    (Object.keys(dependencies).length === 0 || dependencies.prisma
      ? acquireRaceWriteFence
      : async () => null);
  const useTransactionalMutation =
    Object.keys(dependencies).length === 0 || dependencies.prisma != null;
  const lockUsers = dependencies.lockFundedExposureUsers ||
    (dependencies.prisma && !dependencies.prisma.fundedExposureGuard
      ? async () => []
      : lockFundedExposureUsers);

  return async function inviteToRace({ userId, raceId, inviteeIds }) {
    const race = await raceModel.findById(raceId);
    if (!race) {
      throw new RaceInviteError("Race not found", 404);
    }
    if (race.tournamentId) {
      throw new RaceInviteError(
        "This race is managed by its tournament",
        400,
        "TOURNAMENT_RACE_LOCKED"
      );
    }
    if (race.creatorId !== userId) {
      throw new RaceInviteError("Only the race creator can send invites", 403);
    }
    if (race.status !== "PENDING" && race.status !== "ACTIVE") {
      throw new RaceInviteError("Cannot invite to a completed or cancelled race", 400);
    }
    if (!inviteeIds || inviteeIds.length === 0) {
      throw new RaceInviteError("At least one invitee is required", 400);
    }

    const currentParticipants = await participantModel.findByRace(raceId);
    const currentCount = currentParticipants.length;
    // null => unlimited; only a finite cap limits how many can be invited.
    // Team races (TR-207): over-inviting is ALLOWED — invite 6 friends to a
    // 2v2; the per-side cap is enforced at accept time (TEAM_FULL), and
    // unaccepted invites are dropped at start.
    const maxParticipants = race.maxParticipants;
    if (
      !race.isTeamRace &&
      maxParticipants != null &&
      currentCount + inviteeIds.length > maxParticipants
    ) {
      throw new RaceInviteError(
        `A race can have at most ${maxParticipants} participants`,
        400
      );
    }

    const existingUserIds = new Set(currentParticipants.map((p) => p.userId));

    for (const inviteeId of inviteeIds) {
      if (inviteeId === userId) {
        throw new RaceInviteError("Cannot invite yourself", 400);
      }
      if (existingUserIds.has(inviteeId)) {
        throw new RaceInviteError(`User is already a participant`, 400);
      }

      const friendship = await friendshipModel.findBetweenUsers(userId, inviteeId);
      if (!friendship || friendship.status !== "ACCEPTED") {
        throw new RaceInviteError("You can only invite accepted friends", 403);
      }

      // TR-706/707: invite-time block — a friend whose LAST-SEEN client never
      // declared team_races can't accept a team-race invite, so fail fast with
      // a message that names them. No recorded features (dormant account) =>
      // ineligible (pessimistic default). Individual races skip this entirely.
      if (race.isTeamRace) {
        const invitee = await userModel.findById(inviteeId);
        const features = (invitee && invitee.clientFeatures) || [];
        if (!features.includes(TEAM_RACES_FEATURE)) {
          const friendName =
            (invitee && invitee.displayName) || "That friend";
          throw new RaceInviteError(
            `${friendName} needs to update the app to join team races`,
            400,
            "INVITEE_NEEDS_UPDATE"
          );
        }
      }
    }

    const expiresAt = new Date(
      Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000
    );
    const records = inviteeIds.map((inviteeId) => ({
      raceId,
      userId: inviteeId,
      status: "INVITED",
      inviteExpiresAt: expiresAt,
    }));
    if (useTransactionalMutation) {
      await db.$transaction(async (tx) => {
        await acquireWriteFence(tx, raceId);
        try {
          await lockUsers(tx, inviteeIds);
        } catch (error) {
          if (error?.code === "FUNDED_EXPOSURE_RETRY") {
            throw new RaceInviteError(
              "An invitee account changed while sending invites. Please retry.",
              409,
              "MEMBERSHIP_RETRY",
            );
          }
          throw error;
        }
        await tx.$queryRawUnsafe(
          `SELECT id FROM races WHERE id = $1 FOR UPDATE`,
          raceId,
        );
        const lockedRace = await tx.race.findUnique({
          where: { id: raceId },
          select: {
            id: true,
            creatorId: true,
            status: true,
            tournamentId: true,
            isTeamRace: true,
            maxParticipants: true,
          },
        });
        if (!lockedRace) throw new RaceInviteError("Race not found", 404);
        if (lockedRace.tournamentId) {
          throw new RaceInviteError(
            "This race is managed by its tournament",
            400,
            "TOURNAMENT_RACE_LOCKED",
          );
        }
        if (lockedRace.creatorId !== userId) {
          throw new RaceInviteError("Only the race creator can send invites", 403);
        }
        if (!["PENDING", "ACTIVE"].includes(lockedRace.status)) {
          throw new RaceInviteError("Cannot invite to a completed or cancelled race", 400);
        }
        const lockedParticipants = await tx.raceParticipant.findMany({
          where: { raceId },
          select: { userId: true },
        });
        const lockedUserIds = new Set(lockedParticipants.map((row) => row.userId));
        if (inviteeIds.some((inviteeId) => lockedUserIds.has(inviteeId))) {
          throw new RaceInviteError("User is already a participant", 400);
        }
        if (
          !lockedRace.isTeamRace &&
          lockedRace.maxParticipants != null &&
          lockedParticipants.length + inviteeIds.length > lockedRace.maxParticipants
        ) {
          throw new RaceInviteError(
            `A race can have at most ${lockedRace.maxParticipants} participants`,
            400,
          );
        }
        await tx.raceParticipant.createMany({ data: records, skipDuplicates: true });
        const createdInvites = await tx.raceParticipant.findMany({
          where: { raceId, userId: { in: inviteeIds }, status: "INVITED" },
          select: { id: true, userId: true },
        });
        const byUser = new Map(createdInvites.map((row) => [row.userId, row.id]));
        for (const inviteeUserId of inviteeIds) {
          const inviteId = byUser.get(inviteeUserId);
          await appendDomainEvent(tx, {
            eventKey: `RACE_INVITE_SENT_V1:${inviteId}`,
            eventType: "RACE_INVITE_SENT_V1", schemaVersion: 1,
            aggregateType: "RACE", aggregateId: raceId,
            occurredAt: new Date(),
            payload: { raceId, raceName: race.name, creatorUserId: userId, inviteId },
            audience: [{ recipientId: inviteeUserId, facts: {} }],
          });
        }
      });
    } else {
      await participantModel.createMany(records);
      // Narrow injected unit-test compatibility. Production always uses the
      // transaction above and never relies on this process-local callback.
      for (const inviteeUserId of inviteeIds) compatibilityEvents?.emit("RACE_INVITE_SENT", {
        raceId, raceName: race.name, creatorUserId: userId, inviteeUserId,
      });
    }

    return raceModel.findById(raceId);
  };
}

const inviteToRace = buildInviteToRace();

module.exports = { buildInviteToRace, inviteToRace, RaceInviteError };
