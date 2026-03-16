const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildEnsureWeeklyChallengeForDate,
  buildResolveWeeklyChallengeForDate,
  buildResetWeeklyChallengeForDate,
} = require("../../src/services/weeklyChallengeState");

test("ensureWeeklyChallengeForDate creates the current week when it is missing", async () => {
  const createdRows = [];
  let selectionCalls = 0;

  const ensureWeeklyChallengeForDate = buildEnsureWeeklyChallengeForDate({
    WeeklyChallenge: {
      async findByWeek() {
        return null;
      },
      async create(payload) {
        createdRows.push(payload);
        return {
          id: "weekly-1",
          weekOf: payload.weekOf,
          droppedAt: new Date("2026-03-16T14:00:00.000Z"),
          resolvedAt: null,
          challenge: {
            id: payload.challengeId,
            title: "Beat Your Partner",
          },
        };
      },
    },
    async selectWeeklyChallenge() {
      selectionCalls += 1;
      return {
        id: "challenge-1",
        title: "Beat Your Partner",
      };
    },
  });

  const result = await ensureWeeklyChallengeForDate({
    now: new Date("2026-03-18T14:00:00.000Z"),
  });

  assert.equal(selectionCalls, 1);
  assert.equal(result.created, true);
  assert.equal(result.weeklyChallenge.id, "weekly-1");
  assert.equal(result.weeklyChallenge.challenge.id, "challenge-1");
  assert.deepEqual(createdRows, [
    {
      weekOf: "2026-03-16",
      challengeId: "challenge-1",
    },
  ]);
});

test("ensureWeeklyChallengeForDate returns the existing week without reselecting", async () => {
  let selectionCalls = 0;

  const ensureWeeklyChallengeForDate = buildEnsureWeeklyChallengeForDate({
    WeeklyChallenge: {
      async findByWeek() {
        return {
          id: "weekly-1",
          weekOf: "2026-03-16",
          droppedAt: new Date("2026-03-16T14:00:00.000Z"),
          resolvedAt: null,
          challenge: {
            id: "challenge-1",
            title: "Beat Your Partner",
          },
        };
      },
      async create() {
        throw new Error("create should not be called");
      },
    },
    async selectWeeklyChallenge() {
      selectionCalls += 1;
      return {
        id: "challenge-2",
        title: "Should Not Be Used",
      };
    },
  });

  const result = await ensureWeeklyChallengeForDate({
    now: new Date("2026-03-19T14:00:00.000Z"),
  });

  assert.equal(selectionCalls, 0);
  assert.equal(result.created, false);
  assert.equal(result.weeklyChallenge.challenge.id, "challenge-1");
});

test("resolveWeeklyChallengeForDate resolves the current week and marks it resolved", async () => {
  const resolutionCalls = [];
  const markedRows = [];

  const resolveWeeklyChallengeForDate = buildResolveWeeklyChallengeForDate({
    WeeklyChallenge: {
      async findByWeek() {
        return {
          id: "weekly-1",
          weekOf: "2026-03-16",
          resolvedAt: null,
          challenge: {
            id: "challenge-1",
            title: "Beat Your Partner",
          },
        };
      },
      async markResolved(weekOf, resolvedAt) {
        markedRows.push({ weekOf, resolvedAt });
        return {
          id: "weekly-1",
          weekOf,
          resolvedAt,
          challenge: {
            id: "challenge-1",
            title: "Beat Your Partner",
          },
        };
      },
    },
    async runSundayResolution({ weekOf }) {
      resolutionCalls.push(weekOf);
      return { resolvedInstances: 2 };
    },
  });

  const result = await resolveWeeklyChallengeForDate({
    now: new Date("2026-03-21T14:00:00.000Z"),
  });

  assert.deepEqual(resolutionCalls, ["2026-03-16"]);
  assert.equal(result.resolved, true);
  assert.equal(result.summary.resolvedInstances, 2);
  assert.equal(markedRows[0].weekOf, "2026-03-16");
});

test("resetWeeklyChallengeForDate clears current-week instances and reopens the week", async () => {
  const deletedWeeks = [];
  const reopenedWeeks = [];

  const resetWeeklyChallengeForDate = buildResetWeeklyChallengeForDate({
    WeeklyChallenge: {
      async findByWeek() {
        return {
          id: "weekly-1",
          weekOf: "2026-03-16",
          droppedAt: new Date("2026-03-16T14:00:00.000Z"),
          resolvedAt: new Date("2026-03-20T14:00:00.000Z"),
          challenge: {
            id: "challenge-1",
            title: "Beat Your Partner",
          },
        };
      },
      async markUnresolved(weekOf) {
        reopenedWeeks.push(weekOf);
        return {
          id: "weekly-1",
          weekOf,
          droppedAt: new Date("2026-03-16T14:00:00.000Z"),
          resolvedAt: null,
          challenge: {
            id: "challenge-1",
            title: "Beat Your Partner",
          },
        };
      },
    },
    ChallengeInstance: {
      async deleteByWeek(weekOf) {
        deletedWeeks.push(weekOf);
        return 3;
      },
    },
  });

  const result = await resetWeeklyChallengeForDate({
    now: new Date("2026-03-21T14:00:00.000Z"),
  });

  assert.equal(result.reset, true);
  assert.equal(result.deletedInstances, 3);
  assert.equal(result.weeklyChallenge.resolvedAt, null);
  assert.deepEqual(deletedWeeks, ["2026-03-16"]);
  assert.deepEqual(reopenedWeeks, ["2026-03-16"]);
});
