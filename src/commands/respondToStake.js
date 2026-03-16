const { ChallengeInstance } = require("../models/challengeInstance");
const { Stake } = require("../models/stake");
const { eventBus } = require("../events/eventBus");

class StakeNegotiationError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "StakeNegotiationError";
    if (statusCode) this.statusCode = statusCode;
  }
}

async function respondToStake({ userId, instanceId, accept, counterStakeId }) {
  const instance = await ChallengeInstance.findById(instanceId);
  if (!instance) {
    throw new StakeNegotiationError("Challenge instance not found");
  }

  // Must be a participant
  if (instance.userAId !== userId && instance.userBId !== userId) {
    throw new StakeNegotiationError(
      "You are not a participant in this challenge",
      403
    );
  }

  // Must be in pending_stake
  if (instance.status !== "PENDING_STAKE") {
    throw new StakeNegotiationError(
      "Stake negotiation is closed — challenge is already active"
    );
  }

  // Cannot accept your own proposal
  if (accept && instance.proposedById === userId) {
    throw new StakeNegotiationError(
      "You cannot accept your own proposal — only the other user can respond"
    );
  }

  if (accept) {
    // Lock in the proposed stake and activate the challenge
    const updated = await ChallengeInstance.update(instanceId, {
      stakeId: instance.proposedStakeId,
      stakeStatus: "AGREED",
      status: "ACTIVE",
    });

    eventBus.emit("STAKE_ACCEPTED", {
      instanceId,
      acceptedById: userId,
      stakeId: instance.proposedStakeId,
    });

    return updated;
  }

  // Counter-propose
  if (!counterStakeId) {
    throw new StakeNegotiationError(
      "counterStakeId is required when declining"
    );
  }

  const stake = await Stake.findById(counterStakeId);
  if (!stake || !stake.active) {
    throw new StakeNegotiationError("Counter stake not found or inactive");
  }

  const updated = await ChallengeInstance.update(instanceId, {
    proposedById: userId,
    proposedStakeId: counterStakeId,
    stakeStatus: "PROPOSING",
  });

  eventBus.emit("STAKE_COUNTERED", {
    instanceId,
    counteredById: userId,
    stakeId: counterStakeId,
  });

  return updated;
}

module.exports = { respondToStake, StakeNegotiationError };
