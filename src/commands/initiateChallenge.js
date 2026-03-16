const { Friendship } = require("../models/friendship");
const { Challenge } = require("../models/challenge");
const { ChallengeInstance } = require("../models/challengeInstance");
const { eventBus } = require("../events/eventBus");

class ChallengeInitiationError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "ChallengeInitiationError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function getMondayOfWeek(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day + 6) % 7;
  d.setDate(d.getDate() - diff);
  return d.toISOString().slice(0, 10);
}

async function initiateChallenge({ userId, friendUserId }) {
  // Validate friendship
  const friendship = await Friendship.findBetweenUsers(userId, friendUserId);
  if (!friendship || friendship.status !== "ACCEPTED") {
    throw new ChallengeInitiationError(
      "You can only challenge accepted friends",
      403
    );
  }

  // Check active challenge week
  const challenge = await Challenge.findCurrentWeek();
  if (!challenge) {
    throw new ChallengeInitiationError(
      "No active challenge for the current week"
    );
  }

  const weekOf = getMondayOfWeek();

  // Check for duplicate pair this week
  const existing = await ChallengeInstance.findByPairAndWeek(
    userId,
    friendUserId,
    weekOf
  );
  if (existing) {
    throw new ChallengeInitiationError(
      "A challenge already exists between these users this week"
    );
  }

  const instance = await ChallengeInstance.create({
    challengeId: challenge.id,
    weekOf,
    userAId: userId,
    userBId: friendUserId,
  });

  eventBus.emit("CHALLENGE_INITIATED", {
    instanceId: instance.id,
    userId,
    friendUserId,
    challengeId: challenge.id,
  });

  return instance;
}

module.exports = { initiateChallenge, ChallengeInitiationError };
