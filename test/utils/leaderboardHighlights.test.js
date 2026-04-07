const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildLeaderboardHighlightCards,
  getChallengeWinsNeededToAdvance,
  getRacePodiumTargetToAdvance,
} = require("../../src/utils/leaderboardHighlights");

test("buildLeaderboardHighlightCards chooses the strongest cards and uses step fallback order", () => {
  const cards = buildLeaderboardHighlightCards({
    steps: [
      { period: "allTime", rank: 17, nextRank: 16, distanceToNext: 842 },
      { period: "month", rank: 6, nextRank: 5, distanceToNext: 120 },
    ],
    challenges: {
      rank: 7,
      winsNeededToAdvance: 2,
    },
    races: {
      rank: 2,
      podiumTarget: { firsts: 0, seconds: 1, thirds: 0 },
    },
  });

  assert.deepEqual(cards, [
    {
      id: "races-allTime",
      leaderboardType: "races",
      period: "allTime",
      title: "You're 2nd all time in races. That's huge.",
      subtitle: "A 2nd-place finish could move you up.",
    },
    {
      id: "challenges-allTime",
      leaderboardType: "challenges",
      period: "allTime",
      title: "You're 7th all time in challenges. Keep climbing.",
      subtitle: "2 more wins could move you up.",
    },
    {
      id: "steps-allTime",
      leaderboardType: "steps",
      period: "allTime",
      title: "You're 17th all time in steps. Keep it up.",
      subtitle: "Only 842 steps from 16th.",
    },
  ]);
});

test("buildLeaderboardHighlightCards prefers all-time steps over equally ranked challenge cards", () => {
  const cards = buildLeaderboardHighlightCards({
    steps: [{ period: "allTime", rank: 5, nextRank: 4, distanceToNext: 501 }],
    challenges: { rank: 5, winsNeededToAdvance: 3 },
  });

  assert.equal(cards[0].leaderboardType, "steps");
  assert.equal(cards[1].leaderboardType, "challenges");
});

test("buildLeaderboardHighlightCards uses special copy for first place", () => {
  const cards = buildLeaderboardHighlightCards({
    races: {
      rank: 1,
      podiumTarget: null,
    },
  });

  assert.deepEqual(cards, [
    {
      id: "races-allTime",
      leaderboardType: "races",
      period: "allTime",
      title: "You're 1st all time in races.",
      subtitle: "Everyone's chasing you.",
    },
  ]);
});

test("getChallengeWinsNeededToAdvance returns the minimum future wins required to pass the next spot", () => {
  const winsNeeded = getChallengeWinsNeededToAdvance(
    { wins: 3, losses: 2 },
    { wins: 4, losses: 1 }
  );

  assert.equal(winsNeeded, 5);
});

test("getChallengeWinsNeededToAdvance returns null when the next spot is mathematically unreachable by wins alone", () => {
  const winsNeeded = getChallengeWinsNeededToAdvance(
    { wins: 4, losses: 1 },
    { wins: 5, losses: 0 }
  );

  assert.equal(winsNeeded, null);
});

test("getRacePodiumTargetToAdvance finds the lightest podium combination that moves the user up", () => {
  const target = getRacePodiumTargetToAdvance(
    { firsts: 0, seconds: 0, thirds: 1 },
    { firsts: 0, seconds: 1, thirds: 0 }
  );

  assert.deepEqual(target, { firsts: 0, seconds: 1, thirds: 0 });
});

test("getRacePodiumTargetToAdvance chooses the smallest added podium result that breaks a tied point total", () => {
  const target = getRacePodiumTargetToAdvance(
    { firsts: 0, seconds: 2, thirds: 0 },
    { firsts: 1, seconds: 0, thirds: 0 }
  );

  assert.deepEqual(target, { firsts: 0, seconds: 0, thirds: 1 });
});
