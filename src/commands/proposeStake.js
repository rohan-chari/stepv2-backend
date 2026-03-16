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

async function proposeStake({ userId, instanceId, stakeId }) {
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

  // Validate stake
  const stake = await Stake.findById(stakeId);
  if (!stake || !stake.active) {
    throw new StakeNegotiationError("Stake not found or inactive");
  }

  const updated = await ChallengeInstance.update(instanceId, {
    proposedById: userId,
    proposedStakeId: stakeId,
    stakeStatus: "PROPOSING",
  });

  eventBus.emit("STAKE_PROPOSED", {
    instanceId,
    proposedById: userId,
    stakeId,
  });

  return updated;
}

module.exports = { proposeStake, StakeNegotiationError };
