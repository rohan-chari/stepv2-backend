async function updateStreak(
  { participantAId, participantBId, winnerUserId },
  { findStreak, createStreak, saveStreak }
) {
  // Canonical ordering: lower userId is always userA
  const [userAId, userBId] = [participantAId, participantBId].sort();

  let streak = await findStreak(userAId, userBId);

  if (!streak) {
    if (winnerUserId === null) {
      // Skipped week, no existing streak — create empty
      const newStreak = {
        userAId,
        userBId,
        currentWinnerUserId: null,
        currentStreak: 0,
        userALifetimeWins: 0,
        userBLifetimeWins: 0,
      };
      return await createStreak(newStreak);
    }

    // First ever result for this pair
    const newStreak = {
      userAId,
      userBId,
      currentWinnerUserId: winnerUserId,
      currentStreak: 1,
      userALifetimeWins: winnerUserId === userAId ? 1 : 0,
      userBLifetimeWins: winnerUserId === userBId ? 1 : 0,
    };
    return await createStreak(newStreak);
  }

  // Skipped week — preserve existing streak
  if (winnerUserId === null) {
    return await saveStreak(streak);
  }

  // Update lifetime wins
  if (winnerUserId === userAId) {
    streak.userALifetimeWins++;
  } else {
    streak.userBLifetimeWins++;
  }

  // Update current streak
  if (streak.currentWinnerUserId === winnerUserId) {
    streak.currentStreak++;
  } else {
    streak.currentWinnerUserId = winnerUserId;
    streak.currentStreak = 1;
  }

  return await saveStreak(streak);
}

module.exports = { updateStreak };
