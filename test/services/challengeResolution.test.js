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

// 3.1 — Head-to-head: higher steps wins
test("resolveChallenge: higher total steps wins head-to-head", () => {
  const result = resolveChallenge({
    challenge: {
      type: "head_to_head",
      resolutionRule: "higher_total",
      thresholdValue: null,
    },
    userAId: "user-a",
    userBId: "user-b",
    dailyStepsA: weeklySteps([7000, 6000, 8000, 5000, 7000, 6000, 6000]), // 45000
    dailyStepsB: weeklySteps([5000, 6000, 5000, 6000, 5000, 6000, 5000]), // 38000
  });

  assert.equal(result.winnerUserId, "user-a");
  assert.equal(result.userATotalSteps, 45000);
  assert.equal(result.userBTotalSteps, 38000);
});

// 3.2 — Head-to-head: exact tie uses tiebreaker
test("resolveChallenge: exact tie broken by who reached the total first", () => {
  const result = resolveChallenge({
    challenge: {
      type: "head_to_head",
      resolutionRule: "higher_total",
      thresholdValue: null,
    },
    userAId: "user-a",
    userBId: "user-b",
    dailyStepsA: weeklySteps([8000, 7000, 7000, 7000, 7000, 7000, 7000]), // 50000
    dailyStepsB: weeklySteps([7000, 7000, 7000, 7000, 7000, 7000, 8000]), // 50000
    // User A reached 50000 on Saturday (day 6), User B on Sunday (day 7)
    totalReachedAtA: "2026-03-21T18:30:00Z",
    totalReachedAtB: "2026-03-22T20:00:00Z",
  });

  assert.equal(result.winnerUserId, "user-a");
  assert.equal(result.userATotalSteps, 50000);
  assert.equal(result.userBTotalSteps, 50000);
});

// 3.3 — Threshold race: first to cross wins
test("resolveChallenge: first to cross threshold wins regardless of final total", () => {
  const result = resolveChallenge({
    challenge: {
      type: "threshold",
      resolutionRule: "first_to_threshold",
      thresholdValue: 50000,
    },
    userAId: "user-a",
    userBId: "user-b",
    dailyStepsA: weeklySteps([10000, 12000, 15000, 13000, 8000, 5000, 3000]), // 66000
    dailyStepsB: weeklySteps([8000, 9000, 8000, 9000, 8000, 10000, 20000]),  // 72000
    // User A crossed 50k on Wednesday, User B on Friday
    thresholdCrossedAtA: "2026-03-18T22:00:00Z",
    thresholdCrossedAtB: "2026-03-20T19:00:00Z",
  });

  assert.equal(result.winnerUserId, "user-a");
});

// 3.4 — Threshold race: neither crosses threshold
test("resolveChallenge: when neither crosses threshold, higher total wins", () => {
  const result = resolveChallenge({
    challenge: {
      type: "threshold",
      resolutionRule: "first_to_threshold",
      thresholdValue: 100000,
    },
    userAId: "user-a",
    userBId: "user-b",
    dailyStepsA: weeklySteps([10000, 11000, 10000, 11000, 10000, 10000, 10000]), // 72000
    dailyStepsB: weeklySteps([9000, 10000, 9000, 10000, 9000, 9000, 9000]),     // 65000
    thresholdCrossedAtA: null,
    thresholdCrossedAtB: null,
  });

  assert.equal(result.winnerUserId, "user-a");
  assert.equal(result.userATotalSteps, 72000);
  assert.equal(result.userBTotalSteps, 65000);
});

// 3.5 — Daily majority: outpace 5 of 7 days
test("resolveChallenge: daily majority — user with more winning days wins", () => {
  const result = resolveChallenge({
    challenge: {
      type: "head_to_head",
      resolutionRule: "daily_majority",
      thresholdValue: null,
    },
    userAId: "user-a",
    userBId: "user-b",
    // User A wins Mon, Tue, Wed, Sat (4 days)
    // User B wins Thu, Fri, Sun (3 days)
    dailyStepsA: weeklySteps([12000, 11000, 13000, 5000, 6000, 14000, 4000]),
    dailyStepsB: weeklySteps([10000, 9000,  10000, 8000, 9000, 10000, 7000]),
  });

  assert.equal(result.winnerUserId, "user-a");
});

// 3.6 — Creative: highest single day
test("resolveChallenge: highest single-day step count wins", () => {
  const result = resolveChallenge({
    challenge: {
      type: "creative",
      resolutionRule: "highest_single_day",
      thresholdValue: null,
    },
    userAId: "user-a",
    userBId: "user-b",
    // User A's best day: 18000 (Tuesday)
    dailyStepsA: weeklySteps([10000, 18000, 8000, 9000, 7000, 12000, 6000]),
    // User B's best day: 22000 (Saturday)
    dailyStepsB: weeklySteps([8000, 9000, 10000, 7000, 6000, 22000, 5000]),
  });

  assert.equal(result.winnerUserId, "user-b");
});

// 3.7 — Creative: most consistent (lowest variance)
test("resolveChallenge: most consistent — lowest standard deviation wins", () => {
  const result = resolveChallenge({
    challenge: {
      type: "creative",
      resolutionRule: "lowest_variance",
      thresholdValue: null,
    },
    userAId: "user-a",
    userBId: "user-b",
    // User A: perfectly consistent (std dev = 0)
    dailyStepsA: weeklySteps([10000, 10000, 10000, 10000, 10000, 10000, 10000]),
    // User B: high variance
    dailyStepsB: weeklySteps([5000, 20000, 8000, 15000, 3000, 12000, 7000]),
  });

  assert.equal(result.winnerUserId, "user-a");
});

// 3.8 — Creative: weekend warrior
test("resolveChallenge: weekend warrior — highest Sat+Sun combined wins", () => {
  const result = resolveChallenge({
    challenge: {
      type: "creative",
      resolutionRule: "weekend_warrior",
      thresholdValue: null,
    },
    userAId: "user-a",
    userBId: "user-b",
    // User A: great weekdays, okay weekend (Sat: 12000 + Sun: 13000 = 25000)
    dailyStepsA: weeklySteps([15000, 14000, 16000, 15000, 14000, 12000, 13000]),
    // User B: okay weekdays, great weekend (Sat: 18000 + Sun: 12000 = 30000)
    dailyStepsB: weeklySteps([5000, 6000, 5000, 6000, 5000, 18000, 12000]),
  });

  assert.equal(result.winnerUserId, "user-b");
});

// --- New resolution rules ---

test("resolveChallenge: streak_days — most days hitting threshold wins", () => {
  const result = resolveChallenge({
    challenge: { type: "CREATIVE", resolutionRule: "streak_days", thresholdValue: 10000 },
    userAId: "user-a",
    userBId: "user-b",
    // A hits 10K on 5 days, B hits 10K on 3 days
    dailyStepsA: weeklySteps([12000, 11000, 10000, 9000, 10000, 15000, 10000]),
    dailyStepsB: weeklySteps([10000, 8000, 12000, 7000, 6000, 10000, 9000]),
  });
  assert.equal(result.winnerUserId, "user-a");
});

test("resolveChallenge: streak_days — tie returns null", () => {
  const result = resolveChallenge({
    challenge: { type: "CREATIVE", resolutionRule: "streak_days", thresholdValue: 10000 },
    userAId: "user-a",
    userBId: "user-b",
    dailyStepsA: weeklySteps([10000, 8000, 10000, 8000, 10000, 8000, 10000]),
    dailyStepsB: weeklySteps([10000, 10000, 10000, 10000, 8000, 8000, 8000]),
  });
  assert.equal(result.winnerUserId, null);
});

test("resolveChallenge: comeback_king — behind at midweek, ahead by end wins", () => {
  const result = resolveChallenge({
    challenge: { type: "CREATIVE", resolutionRule: "comeback_king" },
    userAId: "user-a",
    userBId: "user-b",
    // A: weak Mon-Wed (18K), strong Thu-Sun (52K) = 70K total
    dailyStepsA: weeklySteps([5000, 6000, 7000, 13000, 13000, 13000, 13000]),
    // B: strong Mon-Wed (33K), weak Thu-Sun (20K) = 53K total
    dailyStepsB: weeklySteps([11000, 11000, 11000, 5000, 5000, 5000, 5000]),
  });
  // A was behind at midweek (18K < 33K) and won overall (70K > 53K) = comeback
  assert.equal(result.winnerUserId, "user-a");
});

test("resolveChallenge: comeback_king — no comeback falls back to higher total", () => {
  const result = resolveChallenge({
    challenge: { type: "CREATIVE", resolutionRule: "comeback_king" },
    userAId: "user-a",
    userBId: "user-b",
    // A ahead at midweek AND ahead at end — no comeback happened
    dailyStepsA: weeklySteps([12000, 12000, 12000, 10000, 10000, 10000, 10000]),
    dailyStepsB: weeklySteps([5000, 5000, 5000, 8000, 8000, 8000, 8000]),
  });
  assert.equal(result.winnerUserId, "user-a");
});

test("resolveChallenge: close_the_rings — most days hitting personal goal wins", () => {
  const result = resolveChallenge({
    challenge: { type: "CREATIVE", resolutionRule: "close_the_rings" },
    userAId: "user-a",
    userBId: "user-b",
    // A has goal of 8000, hits it 6/7 days
    dailyStepsA: weeklySteps([9000, 8000, 8500, 8000, 9000, 8000, 7000]),
    // B has goal of 6000, hits it 5/7 days
    dailyStepsB: weeklySteps([7000, 6500, 6000, 5000, 6000, 5500, 7000]),
    stepGoalA: 8000,
    stepGoalB: 6000,
  });
  assert.equal(result.winnerUserId, "user-a");
});

test("resolveChallenge: close_the_rings — defaults to 10K when no goal set", () => {
  const result = resolveChallenge({
    challenge: { type: "CREATIVE", resolutionRule: "close_the_rings" },
    userAId: "user-a",
    userBId: "user-b",
    dailyStepsA: weeklySteps([10000, 10000, 10000, 10000, 10000, 10000, 10000]),
    dailyStepsB: weeklySteps([10000, 10000, 10000, 10000, 10000, 9000, 9000]),
    stepGoalA: null,
    stepGoalB: null,
  });
  assert.equal(result.winnerUserId, "user-a");
});

test("resolveChallenge: progressive_target — escalating daily target, most days cleared wins", () => {
  const result = resolveChallenge({
    challenge: { type: "CREATIVE", resolutionRule: "progressive_target", thresholdValue: 5000 },
    userAId: "user-a",
    userBId: "user-b",
    // Targets: 5K, 6K, 7K, 8K, 9K, 10K, 11K
    // A clears: 5K✓ 6K✓ 7K✓ 8K✓ 9K✗ 10K✗ 11K✗ = 4
    dailyStepsA: weeklySteps([6000, 7000, 8000, 9000, 8000, 8000, 8000]),
    // B clears: 5K✓ 6K✓ 7K✓ 8K✓ 9K✓ 10K✓ 11K✗ = 6
    dailyStepsB: weeklySteps([5000, 6000, 7000, 8000, 9000, 10000, 10000]),
  });
  assert.equal(result.winnerUserId, "user-b");
});

test("resolveChallenge: rest_day_penalty — worst day subtracted, highest adjusted wins", () => {
  const result = resolveChallenge({
    challenge: { type: "CREATIVE", resolutionRule: "rest_day_penalty" },
    userAId: "user-a",
    userBId: "user-b",
    // A: total 70K, worst day 10K, adjusted = 60K
    dailyStepsA: weeklySteps([10000, 10000, 10000, 10000, 10000, 10000, 10000]),
    // B: total 68K, worst day 2K, adjusted = 66K
    dailyStepsB: weeklySteps([2000, 11000, 11000, 11000, 11000, 11000, 11000]),
  });
  // B has higher adjusted total (66K > 60K) despite lower raw total
  assert.equal(result.winnerUserId, "user-b");
});

test("resolveChallenge: hot_start — Mon+Tue+Wed total only", () => {
  const result = resolveChallenge({
    challenge: { type: "CREATIVE", resolutionRule: "hot_start" },
    userAId: "user-a",
    userBId: "user-b",
    // A: Mon-Wed = 36K, Thu-Sun irrelevant
    dailyStepsA: weeklySteps([12000, 12000, 12000, 1000, 1000, 1000, 1000]),
    // B: Mon-Wed = 30K, but strong back half
    dailyStepsB: weeklySteps([10000, 10000, 10000, 15000, 15000, 15000, 15000]),
  });
  assert.equal(result.winnerUserId, "user-a");
});

test("resolveChallenge: strong_finish — Thu+Fri+Sat+Sun total only", () => {
  const result = resolveChallenge({
    challenge: { type: "CREATIVE", resolutionRule: "strong_finish" },
    userAId: "user-a",
    userBId: "user-b",
    // A: Thu-Sun = 4K
    dailyStepsA: weeklySteps([15000, 15000, 15000, 1000, 1000, 1000, 1000]),
    // B: Thu-Sun = 60K
    dailyStepsB: weeklySteps([1000, 1000, 1000, 15000, 15000, 15000, 15000]),
  });
  assert.equal(result.winnerUserId, "user-b");
});

test("resolveChallenge: daily_minimum — under threshold zeroed, adjusted total wins", () => {
  const result = resolveChallenge({
    challenge: { type: "CREATIVE", resolutionRule: "daily_minimum", thresholdValue: 5000 },
    userAId: "user-a",
    userBId: "user-b",
    // A: all days above 5K, adjusted = 70K
    dailyStepsA: weeklySteps([10000, 10000, 10000, 10000, 10000, 10000, 10000]),
    // B: 2 days below 5K (zeroed), adjusted = 5*12000 = 60K
    dailyStepsB: weeklySteps([12000, 12000, 12000, 4000, 12000, 3000, 12000]),
  });
  assert.equal(result.winnerUserId, "user-a");
});

test("resolveChallenge: improvement_over_baseline — biggest % improvement wins", () => {
  const result = resolveChallenge({
    challenge: { type: "CREATIVE", resolutionRule: "improvement_over_baseline" },
    userAId: "user-a",
    userBId: "user-b",
    // A: baseline 40K, this week 50K = +25%
    dailyStepsA: weeklySteps([7000, 7000, 7000, 7000, 7000, 8000, 7000]),
    // B: baseline 60K, this week 70K = +16.7%
    dailyStepsB: weeklySteps([10000, 10000, 10000, 10000, 10000, 10000, 10000]),
    baselineA: 40000,
    baselineB: 60000,
  });
  // A improved more (25% > 16.7%)
  assert.equal(result.winnerUserId, "user-a");
});

test("resolveChallenge: improvement_over_baseline — no baseline means 0% improvement", () => {
  const result = resolveChallenge({
    challenge: { type: "CREATIVE", resolutionRule: "improvement_over_baseline" },
    userAId: "user-a",
    userBId: "user-b",
    dailyStepsA: weeklySteps([10000, 10000, 10000, 10000, 10000, 10000, 10000]),
    dailyStepsB: weeklySteps([5000, 5000, 5000, 5000, 5000, 5000, 5000]),
    baselineA: 0, // new user
    baselineB: 30000,
  });
  // A: 0% (no baseline), B: 16.7%
  assert.equal(result.winnerUserId, "user-b");
});

// 3.9 — Resolution updates final step totals
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
        type: "head_to_head",
        resolutionRule: "higher_total",
        thresholdValue: null,
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
    updateStreak() {},
  });

  assert.equal(updatedInstances.length, 1);
  assert.equal(updatedInstances[0].id, "instance-1");
  assert.equal(updatedInstances[0].userATotalSteps, 45000);
  assert.equal(updatedInstances[0].userBTotalSteps, 38000);
  assert.equal(updatedInstances[0].winnerUserId, "user-a");
  assert.equal(updatedInstances[0].status, "completed");
  assert.ok(updatedInstances[0].resolvedAt, "resolvedAt should be set");
});

// 3.10 — Resolution does not affect pending_stake instances (marks as skipped)
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
      return { id: "challenge-1", type: "head_to_head", resolutionRule: "higher_total" };
    },
    getDailySteps() {
      return [];
    },
    updateInstance(id, fields) {
      updatedInstances.push({ id, ...fields });
    },
    updateStreak() {},
  });

  assert.equal(updatedInstances.length, 1);
  assert.equal(updatedInstances[0].id, "instance-pending");
  assert.equal(updatedInstances[0].status, "completed");
  assert.equal(updatedInstances[0].stakeStatus, "skipped");
  assert.equal(updatedInstances[0].winnerUserId, null);
});

// 3.11 — Multiple instances resolve independently
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
        type: "head_to_head",
        resolutionRule: "higher_total",
        thresholdValue: null,
      };
    },
    getDailySteps(userId) {
      const data = {
        // User A: 45000 total
        "user-a": weeklySteps([7000, 6000, 8000, 5000, 7000, 6000, 6000]),
        // User B: 38000 total (A beats B)
        "user-b": weeklySteps([5000, 6000, 5000, 6000, 5000, 6000, 5000]),
        // User C: 52000 total (C beats A)
        "user-c": weeklySteps([8000, 7000, 8000, 7000, 8000, 7000, 7000]),
      };
      return data[userId] || [];
    },
    updateInstance(id, fields) {
      updatedInstances.push({ id, ...fields });
    },
    updateStreak() {},
  });

  assert.equal(updatedInstances.length, 2);

  const abResult = updatedInstances.find((i) => i.id === "instance-ab");
  const acResult = updatedInstances.find((i) => i.id === "instance-ac");

  // User A beats User B
  assert.equal(abResult.winnerUserId, "user-a");
  assert.equal(abResult.userATotalSteps, 45000);
  assert.equal(abResult.userBTotalSteps, 38000);

  // User C beats User A (User A is userA in instance, User C is userB)
  assert.equal(acResult.winnerUserId, "user-c");
  assert.equal(acResult.userATotalSteps, 45000);
  assert.equal(acResult.userBTotalSteps, 52000);
});
