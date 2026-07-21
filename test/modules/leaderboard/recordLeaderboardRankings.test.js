const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRaceRecordLeaderboard,
} = require("../../../src/modules/leaderboard/recordLeaderboardRankings");

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

  assert.deepEqual(result.top100, [
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
    inTop100: true,
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
    result.top100.map((entry) => ({
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

test("buildRaceRecordLeaderboard excludes users without a top-3 finish", () => {
  const result = buildRaceRecordLeaderboard(
    [
      { userId: "u1", displayName: "Atlas", firsts: 1, seconds: 0, thirds: 0 },
      { userId: "u2", displayName: "Blaze", firsts: 0, seconds: 0, thirds: 0 },
    ],
    "u2"
  );

  assert.deepEqual(result.top100, [
    {
      rank: 1,
      userId: "u1",
      displayName: "Atlas",
      firsts: 1,
      seconds: 0,
      thirds: 0,
    },
  ]);

  assert.deepEqual(result.currentUser, {
    rank: null,
    displayName: "Blaze",
    firsts: 0,
    seconds: 0,
    thirds: 0,
    inTop100: false,
  });
});
