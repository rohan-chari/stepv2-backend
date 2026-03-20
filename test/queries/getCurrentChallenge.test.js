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
    now() {
      return new Date("2026-03-19T15:30:00.000Z");
    },
  });

  const result = await getCurrentChallenge("user-1");

  assert.equal(result.challenge.id, "challenge-1");
  assert.equal(result.weekOf, "2026-03-16");
  assert.equal(result.endsAt, "2026-03-23T03:59:00.000Z");
  assert.deepEqual(result.syncDays, [
    {
      date: "2026-03-16",
      startsAt: "2026-03-16T04:00:00.000Z",
      endsAt: "2026-03-17T04:00:00.000Z",
    },
    {
      date: "2026-03-17",
      startsAt: "2026-03-17T04:00:00.000Z",
      endsAt: "2026-03-18T04:00:00.000Z",
    },
    {
      date: "2026-03-18",
      startsAt: "2026-03-18T04:00:00.000Z",
      endsAt: "2026-03-19T04:00:00.000Z",
    },
    {
      date: "2026-03-19",
      startsAt: "2026-03-19T04:00:00.000Z",
      endsAt: "2026-03-19T15:30:00.000Z",
    },
  ]);
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
    now() {
      return new Date("2026-03-19T15:30:00.000Z");
    },
  });

  const result = await getCurrentChallenge("user-1");

  assert.equal(result.challenge, null);
  assert.equal(result.weekOf, null);
  assert.deepEqual(result.instances, []);
  assert.deepEqual(result.syncDays, []);
  assert.equal(typeof result.nextDropAt, "string");
  assert.deepEqual(queryCalls, []);
});
