const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildGetCurrentChallenge,
} = require("../../src/queries/getCurrentChallenge");

function fakeWeeklyChallenge() {
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
}

function buildDeps(overrides = {}) {
  const stepsCalls = [];
  return {
    deps: {
      async ensureWeeklyChallengeForDate() {
        return overrides.weeklyChallenge ?? fakeWeeklyChallenge();
      },
      ChallengeInstance: {
        async findForUser(userId, weekOf) {
          return overrides.instances ?? [];
        },
      },
      Steps: {
        async sumStepsForUsers(userIds, startDate, endDate) {
          stepsCalls.push({ userIds, startDate, endDate });
          return overrides.stepTotals ?? new Map();
        },
      },
      computeRankings:
        overrides.computeRankings ??
        require("../../src/utils/rankings").computeRankings,
      now: () => new Date("2026-03-19T15:30:00.000Z"),
    },
    stepsCalls,
  };
}

test("active instance gets ranking attached (user winning)", async () => {
  const { deps, stepsCalls } = buildDeps({
    instances: [
      {
        id: "inst-1",
        status: "ACTIVE",
        userAId: "user-1",
        userBId: "user-2",
      },
    ],
    stepTotals: new Map([
      ["user-1", 10000],
      ["user-2", 7000],
    ]),
  });

  const getCurrentChallenge = buildGetCurrentChallenge(deps);
  const result = await getCurrentChallenge("user-1");

  assert.deepEqual(result.instances[0].ranking, {
    rank: 1,
    totalParticipants: 2,
  });
  assert.equal(stepsCalls.length, 1);
  assert.deepEqual(stepsCalls[0].userIds.sort(), ["user-1", "user-2"]);
  assert.equal(stepsCalls[0].startDate, "2026-03-16");
  assert.equal(stepsCalls[0].endDate, "2026-03-19");
});

test("active instance gets ranking attached (user losing)", async () => {
  const { deps } = buildDeps({
    instances: [
      {
        id: "inst-1",
        status: "ACTIVE",
        userAId: "user-1",
        userBId: "user-2",
      },
    ],
    stepTotals: new Map([
      ["user-1", 3000],
      ["user-2", 7000],
    ]),
  });

  const getCurrentChallenge = buildGetCurrentChallenge(deps);
  const result = await getCurrentChallenge("user-1");

  assert.deepEqual(result.instances[0].ranking, {
    rank: 2,
    totalParticipants: 2,
  });
});

test("tied steps both get rank 1", async () => {
  const { deps } = buildDeps({
    instances: [
      {
        id: "inst-1",
        status: "ACTIVE",
        userAId: "user-1",
        userBId: "user-2",
      },
    ],
    stepTotals: new Map([
      ["user-1", 5000],
      ["user-2", 5000],
    ]),
  });

  const getCurrentChallenge = buildGetCurrentChallenge(deps);
  const result = await getCurrentChallenge("user-1");

  assert.deepEqual(result.instances[0].ranking, {
    rank: 1,
    totalParticipants: 2,
  });
});

test("PENDING_STAKE instance does NOT get ranking", async () => {
  const { deps, stepsCalls } = buildDeps({
    instances: [
      {
        id: "inst-1",
        status: "PENDING_STAKE",
        userAId: "user-1",
        userBId: "user-2",
      },
    ],
  });

  const getCurrentChallenge = buildGetCurrentChallenge(deps);
  const result = await getCurrentChallenge("user-1");

  assert.equal(result.instances[0].ranking, undefined);
  assert.equal(stepsCalls.length, 0);
});

test("mixed active and pending: only active gets ranking", async () => {
  const { deps, stepsCalls } = buildDeps({
    instances: [
      {
        id: "inst-active",
        status: "ACTIVE",
        userAId: "user-1",
        userBId: "user-2",
      },
      {
        id: "inst-pending",
        status: "PENDING_STAKE",
        userAId: "user-1",
        userBId: "user-3",
      },
    ],
    stepTotals: new Map([
      ["user-1", 10000],
      ["user-2", 7000],
    ]),
  });

  const getCurrentChallenge = buildGetCurrentChallenge(deps);
  const result = await getCurrentChallenge("user-1");

  const active = result.instances.find((i) => i.id === "inst-active");
  const pending = result.instances.find((i) => i.id === "inst-pending");

  assert.deepEqual(active.ranking, { rank: 1, totalParticipants: 2 });
  assert.equal(pending.ranking, undefined);
  // Only active participants queried
  assert.equal(stepsCalls.length, 1);
  assert.ok(!stepsCalls[0].userIds.includes("user-3"));
});

test("no active instances skips step fetching entirely", async () => {
  const { deps, stepsCalls } = buildDeps({
    instances: [
      {
        id: "inst-1",
        status: "PENDING_STAKE",
        userAId: "user-1",
        userBId: "user-2",
      },
      {
        id: "inst-2",
        status: "COMPLETED",
        userAId: "user-1",
        userBId: "user-3",
      },
    ],
  });

  const getCurrentChallenge = buildGetCurrentChallenge(deps);
  await getCurrentChallenge("user-1");

  assert.equal(stepsCalls.length, 0);
});

test("multiple active instances with shared participants use single batch query", async () => {
  const { deps, stepsCalls } = buildDeps({
    instances: [
      {
        id: "inst-1",
        status: "ACTIVE",
        userAId: "user-1",
        userBId: "user-2",
      },
      {
        id: "inst-2",
        status: "ACTIVE",
        userAId: "user-1",
        userBId: "user-3",
      },
    ],
    stepTotals: new Map([
      ["user-1", 10000],
      ["user-2", 7000],
      ["user-3", 12000],
    ]),
  });

  const getCurrentChallenge = buildGetCurrentChallenge(deps);
  const result = await getCurrentChallenge("user-1");

  // Single batch query for all unique users
  assert.equal(stepsCalls.length, 1);
  assert.deepEqual(stepsCalls[0].userIds.sort(), [
    "user-1",
    "user-2",
    "user-3",
  ]);

  const inst1 = result.instances.find((i) => i.id === "inst-1");
  const inst2 = result.instances.find((i) => i.id === "inst-2");

  // user-1 (10000) beats user-2 (7000)
  assert.deepEqual(inst1.ranking, { rank: 1, totalParticipants: 2 });
  // user-1 (10000) loses to user-3 (12000)
  assert.deepEqual(inst2.ranking, { rank: 2, totalParticipants: 2 });
});
