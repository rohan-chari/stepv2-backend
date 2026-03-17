const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildInitiateChallenge,
  ChallengeInitiationError,
} = require("../../src/commands/initiateChallenge");

test("initiateChallenge creates an instance for the ensured weekly challenge", async () => {
  const createdPayloads = [];
  const events = [];

  const initiateChallenge = buildInitiateChallenge({
    Friendship: {
      async findBetweenUsers() {
        return { id: "friendship-1", status: "ACCEPTED" };
      },
    },
    async ensureWeeklyChallengeForDate() {
      return {
        weeklyChallenge: {
          id: "weekly-1",
          weekOf: "2026-03-16",
          challenge: { id: "challenge-1" },
        },
      };
    },
    ChallengeInstance: {
      async findByPairAndWeek() {
        return null;
      },
      async create(payload) {
        createdPayloads.push(payload);
        return { id: "instance-1", ...payload };
      },
    },
    eventBus: {
      emit(event, payload) {
        events.push({ event, payload });
      },
    },
  });

  const instance = await initiateChallenge({
    userId: "user-1",
    friendUserId: "user-2",
    stakeId: "stake-1",
  });

  assert.equal(instance.challengeId, "challenge-1");
  assert.deepEqual(createdPayloads, [
    {
      challengeId: "challenge-1",
      weekOf: "2026-03-16",
      userAId: "user-1",
      userBId: "user-2",
      proposedById: "user-1",
      proposedStakeId: "stake-1",
    },
  ]);
  assert.deepEqual(events, [
    {
      event: "CHALLENGE_INITIATED",
      payload: {
        instanceId: "instance-1",
        userId: "user-1",
        friendUserId: "user-2",
        challengeId: "challenge-1",
      },
    },
  ]);
});

test("initiateChallenge rejects resolved weekly challenges", async () => {
  const initiateChallenge = buildInitiateChallenge({
    Friendship: {
      async findBetweenUsers() {
        return { id: "friendship-1", status: "ACCEPTED" };
      },
    },
    async ensureWeeklyChallengeForDate() {
      return {
        weeklyChallenge: {
          id: "weekly-1",
          weekOf: "2026-03-16",
          resolvedAt: "2026-03-20T14:00:00.000Z",
          challenge: { id: "challenge-1" },
        },
      };
    },
    ChallengeInstance: {
      async findByPairAndWeek() {
        throw new Error("should not check for existing instances");
      },
      async create() {
        throw new Error("should not create an instance");
      },
    },
  });

  await assert.rejects(
    () =>
      initiateChallenge({
        userId: "user-1",
        friendUserId: "user-2",
      }),
    (error) => {
      assert.ok(error instanceof ChallengeInitiationError);
      assert.equal(error.message, "No active challenge for the current week");
      assert.equal(error.statusCode, 409);
      return true;
    }
  );
});
