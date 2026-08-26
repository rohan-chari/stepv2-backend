function positiveRank(row) {
  const value = row?.finalRank ?? row?.provisionalRank;
  return Number.isInteger(value) && value > 0 ? value : null;
}

function verifiedCount(row) {
  return Number.isInteger(row?.verifiedCount) && row.verifiedCount >= 0
    ? row.verifiedCount
    : null;
}

function deriveStandingContext(rows, mine) {
  const rank = positiveRank(mine);
  if (!rank) {
    return {
      percentile: null,
      nextTargetRank: null,
      referralsBehindNextTarget: null,
    };
  }

  const rankedRows = (Array.isArray(rows) ? rows : []).filter((row) => positiveRank(row));
  const rankedEntrantCount = rankedRows.length;
  const percentile = rankedEntrantCount > 0
    ? Math.min(100, Math.max(1, Math.ceil((100 * rank) / rankedEntrantCount)))
    : null;

  if (rank === 1) {
    return {
      percentile,
      nextTargetRank: null,
      referralsBehindNextTarget: null,
    };
  }

  const nextTargetRank = rank - 1;
  const ahead = rankedRows.find((row) => positiveRank(row) === nextTargetRank);
  const mineCount = verifiedCount(mine);
  const aheadCount = verifiedCount(ahead);
  const referralsBehindNextTarget = mineCount == null || aheadCount == null
    ? null
    : Math.max(1, aheadCount - mineCount + 1);

  return { percentile, nextTargetRank, referralsBehindNextTarget };
}

module.exports = { deriveStandingContext };
