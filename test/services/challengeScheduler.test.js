const assert = require("node:assert/strict");
const test = require("node:test");

const {
  selectWeeklyChallenge,
} = require("../../src/services/challengeScheduler");

// 1.1 — Challenge selection avoids recent repeats
test("selectWeeklyChallenge picks the only unused challenge from a pool of 104", async () => {
  const now = new Date("2026-03-16T14:00:00Z");

  // 103 challenges used within the last 104 weeks, 1 never used
  const challenges = Array.from({ length: 104 }, (_, i) => ({
    id: `challenge-${i}`,
    title: `Challenge ${i}`,
    type: "head_to_head",
    active: true,
    lastUsedAt: i < 103 ? new Date(now - (i + 1) * 7 * 24 * 60 * 60 * 1000) : null,
  }));

  const selected = await selectWeeklyChallenge({
    findActiveChallenges() {
      return challenges;
    },
    markChallengeUsed(challengeId) {
      const c = challenges.find((ch) => ch.id === challengeId);
      c.lastUsedAt = now;
    },
    now,
  });

  // The only never-used challenge is challenge-103
  assert.equal(selected.id, "challenge-103");
  assert.ok(
    challenges[103].lastUsedAt,
    "Selected challenge should be marked as used"
  );
});

// 1.2 — Challenge selection fails gracefully with insufficient pool
test("selectWeeklyChallenge picks the oldest-used challenge when all have been used recently", async () => {
  const now = new Date("2026-03-16T14:00:00Z");

  // Only 50 challenges, all used recently
  const challenges = Array.from({ length: 50 }, (_, i) => ({
    id: `challenge-${i}`,
    title: `Challenge ${i}`,
    type: "head_to_head",
    active: true,
    // challenge-49 was used longest ago (50 weeks ago)
    lastUsedAt: new Date(now - (i + 1) * 7 * 24 * 60 * 60 * 1000),
  }));

  let markedId;

  const selected = await selectWeeklyChallenge({
    findActiveChallenges() {
      return challenges;
    },
    markChallengeUsed(challengeId) {
      markedId = challengeId;
    },
    now,
  });

  // Should pick the one with the oldest lastUsedAt (challenge-49, used 50 weeks ago)
  assert.equal(selected.id, "challenge-49");
  assert.equal(markedId, "challenge-49");
});
