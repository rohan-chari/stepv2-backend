/**
 * Compute rankings for an array of participants based on total steps.
 * Uses standard competition ranking (ties get same rank, next rank skips).
 *
 * @param {Array<{id: string, totalSteps: number}>} participants
 * @returns {Array<{id: string, totalSteps: number, rank: number}>}
 */
function computeRankings(participants) {
  if (participants.length === 0) return [];

  const sorted = [...participants].sort((a, b) => b.totalSteps - a.totalSteps);

  let currentRank = 1;
  sorted[0].rank = 1;

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].totalSteps < sorted[i - 1].totalSteps) {
      currentRank = i + 1;
    }
    sorted[i].rank = currentRank;
  }

  return sorted;
}

module.exports = { computeRankings };
