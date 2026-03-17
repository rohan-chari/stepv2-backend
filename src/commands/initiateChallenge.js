const { Friendship } = require("../models/friendship");
const { ChallengeInstance } = require("../models/challengeInstance");
const { eventBus } = require("../events/eventBus");
const {
  ensureWeeklyChallengeForDate,
} = require("../services/weeklyChallengeState");

class ChallengeInitiationError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "ChallengeInitiationError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function buildInitiateChallenge(dependencies = {}) {
  const friendshipModel = dependencies.Friendship || Friendship;
  const instanceModel = dependencies.ChallengeInstance || ChallengeInstance;
  const ensureWeeklyChallenge =
    dependencies.ensureWeeklyChallengeForDate || ensureWeeklyChallengeForDate;
  const events = dependencies.eventBus || eventBus;

  return async function initiateChallenge({ userId, friendUserId, stakeId }) {
    const friendship = await friendshipModel.findBetweenUsers(
      userId,
      friendUserId
    );
    if (!friendship || friendship.status !== "ACCEPTED") {
      throw new ChallengeInitiationError(
        "You can only challenge accepted friends",
        403
      );
    }

    const { weeklyChallenge } = await ensureWeeklyChallenge();
    if (!weeklyChallenge || weeklyChallenge.resolvedAt) {
      throw new ChallengeInitiationError(
        "No active challenge for the current week",
        409
      );
    }

    const weekOf = weeklyChallenge.weekOf;

    const existing = await instanceModel.findByPairAndWeek(
      userId,
      friendUserId,
      weekOf
    );
    if (existing) {
      throw new ChallengeInitiationError(
        "A challenge already exists between these users this week"
      );
    }

    const instance = await instanceModel.create({
      challengeId: weeklyChallenge.challenge.id,
      weekOf,
      userAId: userId,
      userBId: friendUserId,
      proposedById: userId,
      proposedStakeId: stakeId,
    });

    events.emit("CHALLENGE_INITIATED", {
      instanceId: instance.id,
      userId,
      friendUserId,
      challengeId: weeklyChallenge.challenge.id,
    });

    return instance;
  };
}

const initiateChallenge = buildInitiateChallenge();

module.exports = {
  buildInitiateChallenge,
  initiateChallenge,
  ChallengeInitiationError,
};
