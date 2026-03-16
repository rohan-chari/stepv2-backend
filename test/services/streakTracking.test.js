const assert = require("node:assert/strict");
const test = require("node:test");

const { updateStreak } = require("../../src/services/streakTracking");

// 4.1 — Streak created on first resolution
test("updateStreak creates a streak record on first win", async () => {
  let savedStreak;

  const result = await updateStreak(
    { participantAId: "user-a", participantBId: "user-b", winnerUserId: "user-a" },
    {
      findStreak(userAId, userBId) {
        // No existing streak
        return null;
      },
      createStreak(streak) {
        savedStreak = streak;
        return { id: "streak-1", ...streak };
      },
      saveStreak(streak) {
        savedStreak = streak;
        return streak;
      },
    }
  );

  assert.equal(result.currentWinnerUserId, "user-a");
  assert.equal(result.currentStreak, 1);
  assert.equal(result.userALifetimeWins, 1);
  assert.equal(result.userBLifetimeWins, 0);
});

// 4.2 — Streak increments on consecutive wins
test("updateStreak increments streak for consecutive wins by same user", async () => {
  const existingStreak = {
    id: "streak-1",
    userAId: "user-a",
    userBId: "user-b",
    currentWinnerUserId: "user-a",
    currentStreak: 2,
    userALifetimeWins: 2,
    userBLifetimeWins: 0,
  };

  let savedStreak;

  const result = await updateStreak(
    { participantAId: "user-a", participantBId: "user-b", winnerUserId: "user-a" },
    {
      findStreak() {
        return { ...existingStreak };
      },
      createStreak() {},
      saveStreak(streak) {
        savedStreak = streak;
        return streak;
      },
    }
  );

  assert.equal(result.currentWinnerUserId, "user-a");
  assert.equal(result.currentStreak, 3);
  assert.equal(result.userALifetimeWins, 3);
  assert.equal(result.userBLifetimeWins, 0);
});

// 4.3 — Streak resets when the other user wins
test("updateStreak resets streak to 1 when the other user wins", async () => {
  const existingStreak = {
    id: "streak-1",
    userAId: "user-a",
    userBId: "user-b",
    currentWinnerUserId: "user-a",
    currentStreak: 3,
    userALifetimeWins: 3,
    userBLifetimeWins: 0,
  };

  let savedStreak;

  const result = await updateStreak(
    { participantAId: "user-a", participantBId: "user-b", winnerUserId: "user-b" },
    {
      findStreak() {
        return { ...existingStreak };
      },
      createStreak() {},
      saveStreak(streak) {
        savedStreak = streak;
        return streak;
      },
    }
  );

  assert.equal(result.currentWinnerUserId, "user-b");
  assert.equal(result.currentStreak, 1);
  assert.equal(result.userALifetimeWins, 3);
  assert.equal(result.userBLifetimeWins, 1);
});

// 4.4 — Skipped week preserves streak
test("updateStreak with null winner (skipped week) preserves existing streak", async () => {
  const existingStreak = {
    id: "streak-1",
    userAId: "user-a",
    userBId: "user-b",
    currentWinnerUserId: "user-a",
    currentStreak: 3,
    userALifetimeWins: 3,
    userBLifetimeWins: 0,
  };

  let savedStreak;

  const result = await updateStreak(
    { participantAId: "user-a", participantBId: "user-b", winnerUserId: null },
    {
      findStreak() {
        return { ...existingStreak };
      },
      createStreak() {},
      saveStreak(streak) {
        savedStreak = streak;
        return streak;
      },
    }
  );

  // Streak should be preserved — skipped week does not break it
  assert.equal(result.currentWinnerUserId, "user-a");
  assert.equal(result.currentStreak, 3);
  assert.equal(result.userALifetimeWins, 3);
  assert.equal(result.userBLifetimeWins, 0);
});

// 4.5 — Canonical user ordering
test("updateStreak uses canonical ordering: lower userId is always userA", async () => {
  let findCalledWith;
  let createdStreak;

  // User B (higher ID) initiates with User A (lower ID)
  const result = await updateStreak(
    { participantAId: "user-z", participantBId: "user-a", winnerUserId: "user-z" },
    {
      findStreak(userAId, userBId) {
        findCalledWith = { userAId, userBId };
        return null;
      },
      createStreak(streak) {
        createdStreak = streak;
        return { id: "streak-1", ...streak };
      },
      saveStreak(streak) {
        return streak;
      },
    }
  );

  // Regardless of who initiated, the lower ID ("user-a") should be userA
  assert.equal(findCalledWith.userAId, "user-a");
  assert.equal(findCalledWith.userBId, "user-z");
  assert.equal(createdStreak.userAId, "user-a");
  assert.equal(createdStreak.userBId, "user-z");

  // Winner is still user-z, tracked in the canonical structure
  assert.equal(result.currentWinnerUserId, "user-z");
  assert.equal(result.currentStreak, 1);
  // user-z is userB in canonical ordering, so userBLifetimeWins should increment
  assert.equal(result.userALifetimeWins, 0);
  assert.equal(result.userBLifetimeWins, 1);
});

// 4.6 — Lifetime record accuracy
test("updateStreak tracks lifetime wins accurately over many resolutions", async () => {
  // Simulate 10 resolved challenges: A wins 6, B wins 4
  const winSequence = [
    "user-a", "user-a", "user-b", "user-a", "user-b",
    "user-a", "user-b", "user-a", "user-b", "user-a",
  ];

  let currentStreak = null;

  for (const winnerId of winSequence) {
    currentStreak = await updateStreak(
      { participantAId: "user-a", participantBId: "user-b", winnerUserId: winnerId },
      {
        findStreak() {
          return currentStreak ? { ...currentStreak } : null;
        },
        createStreak(streak) {
          return { id: "streak-1", ...streak };
        },
        saveStreak(streak) {
          currentStreak = streak;
          return streak;
        },
      }
    );
  }

  assert.equal(currentStreak.userALifetimeWins, 6);
  assert.equal(currentStreak.userBLifetimeWins, 4);
  // Last winner was user-a, and the last two were: user-b then user-a
  // So current streak should be 1 for user-a
  assert.equal(currentStreak.currentWinnerUserId, "user-a");
  assert.equal(currentStreak.currentStreak, 1);
});
