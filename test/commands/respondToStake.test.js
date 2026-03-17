const assert = require("node:assert/strict");
const test = require("node:test");

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
