const WEEKS_BEFORE_REPEAT = 104;

async function selectWeeklyChallenge({
  findActiveChallenges,
  markChallengeUsed,
  now,
}) {
  const currentDate = now instanceof Date ? now : new Date(now || Date.now());
  const cutoffDate = new Date(currentDate);
  cutoffDate.setDate(cutoffDate.getDate() - WEEKS_BEFORE_REPEAT * 7);

  const challenges = await findActiveChallenges();

  if (challenges.length === 0) {
    throw new Error("No active challenges in the pool");
  }

  // Prefer challenges never used or not used within the repeat window
  const eligible = challenges.filter(
    (c) => !c.lastUsedAt || c.lastUsedAt < cutoffDate
  );

  let selected;
  if (eligible.length > 0) {
    selected = eligible[Math.floor(Math.random() * eligible.length)];
  } else {
    // All used recently — pick the one used longest ago
    selected = [...challenges].sort(
      (a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0)
    )[0];
  }

  await markChallengeUsed(selected.id);
  return selected;
}

module.exports = { selectWeeklyChallenge };
