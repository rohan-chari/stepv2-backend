const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { Friendship } = require("../models/friendship");
const { eventBus } = require("../events/eventBus");

class RaceInviteError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "RaceInviteError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function buildInviteToRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const friendshipModel = dependencies.Friendship || Friendship;
  const events = dependencies.eventBus || eventBus;

  return async function inviteToRace({ userId, raceId, inviteeIds }) {
    const race = await raceModel.findById(raceId);
    if (!race) {
      throw new RaceInviteError("Race not found", 404);
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
    if (currentCount + inviteeIds.length > 10) {
      throw new RaceInviteError("A race can have at most 10 participants", 400);
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
    }

    const records = inviteeIds.map((inviteeId) => ({
      raceId,
      userId: inviteeId,
      status: "INVITED",
    }));
    await participantModel.createMany(records);

    for (const inviteeId of inviteeIds) {
      events.emit("RACE_INVITE_SENT", {
        raceId,
        raceName: race.name,
        creatorUserId: userId,
        inviteeUserId: inviteeId,
      });
    }

    return raceModel.findById(raceId);
  };
}

const inviteToRace = buildInviteToRace();

module.exports = { buildInviteToRace, inviteToRace, RaceInviteError };
