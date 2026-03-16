const assert = require("node:assert/strict");
const test = require("node:test");

const { buildGetCurrentChallenge } = require("../../src/queries/getCurrentChallenge");

test("getCurrentChallenge returns the ensured weekly challenge and user instances", async () => {
  const queryCalls = [];

  const getCurrentChallenge = buildGetCurrentChallenge({
    async ensureWeeklyChallengeForDate() {
      return {
        weeklyChallenge: {
          id: "weekly-1",
          weekOf: "2026-03-16",
          challenge: {
            id: "challenge-1",
            title: "Beat Your Partner",
            description: "Whoever takes more steps this week wins.",
            type: "HEAD_TO_HEAD",
            resolutionRule: "higher_total",
            thresholdValue: null,
          },
        },
      };
    },
    ChallengeInstance: {
      async findForUser(userId, weekOf) {
        queryCalls.push({ userId, weekOf });
        return [{ id: "instance-1", status: "ACTIVE" }];
      },
    },
  });

  const result = await getCurrentChallenge("user-1");

  assert.equal(result.challenge.id, "challenge-1");
  assert.equal(result.weekOf, "2026-03-16");
  assert.deepEqual(result.instances, [{ id: "instance-1", status: "ACTIVE" }]);
  assert.deepEqual(queryCalls, [{ userId: "user-1", weekOf: "2026-03-16" }]);
});

test("getCurrentChallenge returns no active challenge after the week is resolved", async () => {
  const queryCalls = [];

  const getCurrentChallenge = buildGetCurrentChallenge({
    async ensureWeeklyChallengeForDate() {
      return {
        weeklyChallenge: {
          id: "weekly-1",
          weekOf: "2026-03-16",
          resolvedAt: "2026-03-20T14:00:00.000Z",
          challenge: {
            id: "challenge-1",
            title: "Beat Your Partner",
            description: "Whoever takes more steps this week wins.",
            type: "HEAD_TO_HEAD",
            resolutionRule: "higher_total",
            thresholdValue: null,
          },
        },
      };
    },
    ChallengeInstance: {
      async findForUser(userId, weekOf) {
        queryCalls.push({ userId, weekOf });
        return [{ id: "instance-1", status: "COMPLETED" }];
      },
    },
  });

  const result = await getCurrentChallenge("user-1");

  assert.equal(result.challenge, null);
  assert.equal(result.weekOf, null);
  assert.deepEqual(result.instances, []);
  assert.equal(typeof result.nextDropAt, "string");
  assert.deepEqual(queryCalls, []);
});
