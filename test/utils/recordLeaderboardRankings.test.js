const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildChallengeRecordLeaderboard,
  buildRaceRecordLeaderboard,
} = require("../../src/utils/recordLeaderboardRankings");

test("buildChallengeRecordLeaderboard ranks by win percentage and excludes users below the minimum", () => {
  const result = buildChallengeRecordLeaderboard(
    [
      { userId: "u1", displayName: "Ace", wins: 5, losses: 0 },
      { userId: "u2", displayName: "Blaze", wins: 4, losses: 1 },
      { userId: "u3", displayName: "Cedar", wins: 4, losses: 0 },
    ],
    "u1"
  );

  assert.deepEqual(result.top10, [
    {
      rank: 1,
      userId: "u1",
      displayName: "Ace",
      wins: 5,
      losses: 0,
      completedCount: 5,
      winPercentage: 1,
    },
    {
      rank: 2,
      userId: "u2",
      displayName: "Blaze",
      wins: 4,
      losses: 1,
      completedCount: 5,
      winPercentage: 0.8,
    },
  ]);

  assert.deepEqual(result.currentUser, {
    rank: 1,
    displayName: "Ace",
    wins: 5,
    losses: 0,
    completedCount: 5,
    winPercentage: 1,
    inTop10: true,
    qualified: true,
  });
});

test("buildChallengeRecordLeaderboard returns current user as unranked when below the minimum", () => {
  const result = buildChallengeRecordLeaderboard(
    [
      { userId: "u1", displayName: "Ace", wins: 5, losses: 0 },
      { userId: "u2", displayName: "Cedar", wins: 4, losses: 0 },
    ],
    "u2"
  );

  assert.deepEqual(result.top10, [
    {
      rank: 1,
      userId: "u1",
      displayName: "Ace",
      wins: 5,
      losses: 0,
      completedCount: 5,
      winPercentage: 1,
    },
  ]);

  assert.deepEqual(result.currentUser, {
    rank: null,
    displayName: "Cedar",
    wins: 4,
    losses: 0,
    completedCount: 4,
    winPercentage: 1,
    inTop10: false,
    qualified: false,
  });
});

test("buildChallengeRecordLeaderboard breaks ties by completed count then wins", () => {
  const result = buildChallengeRecordLeaderboard(
    [
      { userId: "u1", displayName: "Atlas", wins: 8, losses: 2 },
      { userId: "u2", displayName: "Bolt", wins: 4, losses: 1 },
      { userId: "u3", displayName: "Cinder", wins: 8, losses: 2 },
      { userId: "u4", displayName: "Drift", wins: 12, losses: 3 },
    ],
    "u4"
  );

  assert.deepEqual(
    result.top10.map((entry) => ({
      displayName: entry.displayName,
      rank: entry.rank,
      wins: entry.wins,
      losses: entry.losses,
      completedCount: entry.completedCount,
    })),
    [
      { displayName: "Drift", rank: 1, wins: 12, losses: 3, completedCount: 15 },
      { displayName: "Atlas", rank: 2, wins: 8, losses: 2, completedCount: 10 },
      { displayName: "Cinder", rank: 2, wins: 8, losses: 2, completedCount: 10 },
      { displayName: "Bolt", rank: 4, wins: 4, losses: 1, completedCount: 5 },
    ]
  );
});

test("buildRaceRecordLeaderboard ranks by points then firsts then seconds then thirds", () => {
  const result = buildRaceRecordLeaderboard(
    [
      { userId: "u1", displayName: "Atlas", firsts: 1, seconds: 1, thirds: 0 },
      { userId: "u2", displayName: "Blaze", firsts: 1, seconds: 0, thirds: 0 },
      { userId: "u3", displayName: "Cinder", firsts: 0, seconds: 1, thirds: 1 },
      { userId: "u4", displayName: "Drift", firsts: 0, seconds: 0, thirds: 1 },
    ],
    "u1"
  );

  assert.deepEqual(result.top10, [
    {
      rank: 1,
      userId: "u1",
      displayName: "Atlas",
      firsts: 1,
      seconds: 1,
      thirds: 0,
    },
    {
      rank: 2,
      userId: "u2",
      displayName: "Blaze",
      firsts: 1,
      seconds: 0,
      thirds: 0,
    },
    {
      rank: 3,
      userId: "u3",
      displayName: "Cinder",
      firsts: 0,
      seconds: 1,
      thirds: 1,
    },
    {
      rank: 4,
      userId: "u4",
      displayName: "Drift",
      firsts: 0,
      seconds: 0,
      thirds: 1,
    },
  ]);

  assert.deepEqual(result.currentUser, {
    rank: 1,
    displayName: "Atlas",
    firsts: 1,
    seconds: 1,
    thirds: 0,
    inTop10: true,
  });
});

test("buildRaceRecordLeaderboard gives equal rank when race records are identical", () => {
  const result = buildRaceRecordLeaderboard(
    [
      { userId: "u1", displayName: "Atlas", firsts: 1, seconds: 0, thirds: 0 },
      { userId: "u2", displayName: "Blaze", firsts: 1, seconds: 0, thirds: 0 },
      { userId: "u3", displayName: "Cinder", firsts: 0, seconds: 2, thirds: 0 },
    ],
    "u3"
  );

  assert.deepEqual(
    result.top10.map((entry) => ({
      displayName: entry.displayName,
      rank: entry.rank,
    })),
    [
      { displayName: "Atlas", rank: 1 },
      { displayName: "Blaze", rank: 1 },
      { displayName: "Cinder", rank: 3 },
    ]
  );
});
