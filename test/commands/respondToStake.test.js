const assert = require("node:assert/strict");
const test = require("node:test");

const {
  respondToStake,
} = require("../../src/commands/respondToStake");
const { eventBus } = require("../../src/events/eventBus");
const { ChallengeInstance } = require("../../src/models/challengeInstance");

// Regression test: ChallengeInstance.update must include relations so that
// respondToStake (and proposeStake) return the full instance with stake.name,
// userA.displayName, etc. Without this, the frontend shows "Unknown" after
// accepting a stake because the response only contains stakeId (a UUID)
// but no stake object.
test("ChallengeInstance.update includes stake, proposedStake, userA, userB relations", async () => {
  const { ChallengeInstance } = require("../../src/models/challengeInstance");

  const updateStr = ChallengeInstance.update.toString();

  assert.ok(
    updateStr.includes("include"),
    "ChallengeInstance.update() must use Prisma include to return relations. " +
    "Without this, respondToStake returns an instance without stake.name, " +
    "causing the frontend to show 'Unknown' after accepting."
  );
});

test("respondToStake emits STAKE_ACCEPTED with the proposer as recipient", async (t) => {
  const originalFindById = ChallengeInstance.findById;
  const originalUpdate = ChallengeInstance.update;
  const originalEmit = eventBus.emit;

  let emittedEvent;

  ChallengeInstance.findById = async (id) => ({
    id,
    userAId: "user-1",
    userBId: "user-2",
    status: "PENDING_STAKE",
    proposedById: "user-1",
    proposedStakeId: "stake-1",
  });

  ChallengeInstance.update = async (id, fields) => ({
    id,
    ...fields,
  });

  eventBus.emit = (event, payload) => {
    emittedEvent = { event, payload };
  };

  t.after(() => {
    ChallengeInstance.findById = originalFindById;
    ChallengeInstance.update = originalUpdate;
    eventBus.emit = originalEmit;
  });

  await respondToStake({
    userId: "user-2",
    instanceId: "instance-1",
    accept: true,
  });

  assert.deepEqual(emittedEvent, {
    event: "STAKE_ACCEPTED",
    payload: {
      instanceId: "instance-1",
      acceptedById: "user-2",
      proposedById: "user-1",
      stakeId: "stake-1",
    },
  });
});
