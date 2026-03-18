const assert = require("node:assert/strict");
const test = require("node:test");

const {
  resolveChallenge,
  resolveWeeklyChallenges,
} = require("../../src/services/challengeResolution");

// Helper to create daily steps for a week (Mon-Sun)
function weeklySteps(stepsArray) {
  const monday = "2026-03-16";
  return stepsArray.map((steps, i) => {
    const date = new Date(monday);
    date.setDate(date.getDate() + i);
    return { date: date.toISOString().slice(0, 10), steps };
  });
}

test("resolveChallenge: higher total steps wins", () => {
  const result = resolveChallenge({
    challenge: { type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
    userAId: "user-a",
    userBId: "user-b",
    dailyStepsA: weeklySteps([7000, 6000, 8000, 5000, 7000, 6000, 6000]), // 45000
    dailyStepsB: weeklySteps([5000, 6000, 5000, 6000, 5000, 6000, 5000]), // 38000
  });

  assert.equal(result.winnerUserId, "user-a");
  assert.equal(result.userATotalSteps, 45000);
  assert.equal(result.userBTotalSteps, 38000);
});

test("resolveChallenge: exact tie broken by who reached the total first", () => {
  const result = resolveChallenge({
    challenge: { type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
    userAId: "user-a",
    userBId: "user-b",
    dailyStepsA: weeklySteps([8000, 7000, 7000, 7000, 7000, 7000, 7000]), // 50000
    dailyStepsB: weeklySteps([7000, 7000, 7000, 7000, 7000, 7000, 8000]), // 50000
    totalReachedAtA: "2026-03-21T18:30:00Z",
    totalReachedAtB: "2026-03-22T20:00:00Z",
  });

  assert.equal(result.winnerUserId, "user-a");
  assert.equal(result.userATotalSteps, 50000);
  assert.equal(result.userBTotalSteps, 50000);
});

test("resolveChallenge: unknown rule falls back to higher total", () => {
  const result = resolveChallenge({
    challenge: { type: "CREATIVE", resolutionRule: "some_future_rule" },
    userAId: "user-a",
    userBId: "user-b",
    dailyStepsA: weeklySteps([10000, 10000, 10000, 10000, 10000, 10000, 10000]),
    dailyStepsB: weeklySteps([5000, 5000, 5000, 5000, 5000, 5000, 5000]),
  });

  assert.equal(result.winnerUserId, "user-a");
});

test("resolveWeeklyChallenges updates instance with final totals and resolvedAt", async () => {
  const updatedInstances = [];

  await resolveWeeklyChallenges({
    findActiveAndPendingInstances() {
      return [
        {
          id: "instance-1",
          challengeId: "challenge-1",
          userAId: "user-a",
          userBId: "user-b",
          status: "active",
          stakeStatus: "agreed",
          stakeId: "stake-1",
        },
      ];
    },
    getChallenge(challengeId) {
      return {
        id: challengeId,
        type: "HEAD_TO_HEAD",
        resolutionRule: "higher_total",
      };
    },
    getDailySteps(userId) {
      if (userId === "user-a") {
        return weeklySteps([7000, 6000, 8000, 5000, 7000, 6000, 6000]); // 45000
      }
      return weeklySteps([5000, 6000, 5000, 6000, 5000, 6000, 5000]); // 38000
    },
    updateInstance(id, fields) {
      updatedInstances.push({ id, ...fields });
    },
  });

  assert.equal(updatedInstances.length, 1);
  assert.equal(updatedInstances[0].id, "instance-1");
  assert.equal(updatedInstances[0].userATotalSteps, 45000);
  assert.equal(updatedInstances[0].userBTotalSteps, 38000);
  assert.equal(updatedInstances[0].winnerUserId, "user-a");
  assert.equal(updatedInstances[0].status, "completed");
  assert.ok(updatedInstances[0].resolvedAt, "resolvedAt should be set");
});

test("resolveWeeklyChallenges marks pending_stake instances as skipped with no winner", async () => {
  const updatedInstances = [];

  await resolveWeeklyChallenges({
    findActiveAndPendingInstances() {
      return [
        {
          id: "instance-pending",
          challengeId: "challenge-1",
          userAId: "user-a",
          userBId: "user-b",
          status: "pending_stake",
          stakeStatus: "proposing",
          stakeId: null,
        },
      ];
    },
    getChallenge() {
      return { id: "challenge-1", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" };
    },
    getDailySteps() {
      return [];
    },
    updateInstance(id, fields) {
      updatedInstances.push({ id, ...fields });
    },
  });

  assert.equal(updatedInstances.length, 1);
  assert.equal(updatedInstances[0].id, "instance-pending");
  assert.equal(updatedInstances[0].status, "completed");
  assert.equal(updatedInstances[0].stakeStatus, "skipped");
  assert.equal(updatedInstances[0].winnerUserId, null);
});

test("resolveWeeklyChallenges resolves multiple instances with independent winners", async () => {
  const updatedInstances = [];

  await resolveWeeklyChallenges({
    findActiveAndPendingInstances() {
      return [
        {
          id: "instance-ab",
          challengeId: "challenge-1",
          userAId: "user-a",
          userBId: "user-b",
          status: "active",
          stakeStatus: "agreed",
          stakeId: "stake-1",
        },
        {
          id: "instance-ac",
          challengeId: "challenge-1",
          userAId: "user-a",
          userBId: "user-c",
          status: "active",
          stakeStatus: "agreed",
          stakeId: "stake-2",
        },
      ];
    },
    getChallenge() {
      return {
        id: "challenge-1",
        type: "HEAD_TO_HEAD",
        resolutionRule: "higher_total",
      };
    },
    getDailySteps(userId) {
      const data = {
        "user-a": weeklySteps([7000, 6000, 8000, 5000, 7000, 6000, 6000]),
        "user-b": weeklySteps([5000, 6000, 5000, 6000, 5000, 6000, 5000]),
        "user-c": weeklySteps([8000, 7000, 8000, 7000, 8000, 7000, 7000]),
      };
      return data[userId] || [];
    },
    updateInstance(id, fields) {
      updatedInstances.push({ id, ...fields });
    },
  });

  assert.equal(updatedInstances.length, 2);

  const abResult = updatedInstances.find((i) => i.id === "instance-ab");
  const acResult = updatedInstances.find((i) => i.id === "instance-ac");

  assert.equal(abResult.winnerUserId, "user-a");
  assert.equal(abResult.userATotalSteps, 45000);
  assert.equal(abResult.userBTotalSteps, 38000);

  assert.equal(acResult.winnerUserId, "user-c");
  assert.equal(acResult.userATotalSteps, 45000);
  assert.equal(acResult.userBTotalSteps, 52000);
});
