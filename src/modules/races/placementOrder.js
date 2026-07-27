// THE placement comparator (batch 2026-07-26, items 12/16).
//
// Before this module the codebase carried FIVE rank implementations over two
// scoring sources: getRaces, getHomeRaceCard, getRaceProgress's serializer sort,
// placementRecompute's cron sort, and the Flutter client's own re-sort. Home,
// the races list and race detail each read a different one, so the same user
// legitimately saw three different placements for one race.
//
// Every server-side rank site now imports THIS function. The two scoring worlds
// (live effect-resolved vs persisted RaceParticipant.totalSteps) are NOT merged
// here — that is a separate project — but given the same input rows every
// surface now produces the same order, which is what the divergence reports
// were actually about.
//
// Order:
//   1. Finishers ahead of runners.
//   2. Among finishers: stored `placement`, then earliest `finishedAt`.
//   3. Among runners: most steps first.
//   4. Ties (notably EVERYONE at 0 steps at the start of a day): earliest
//      `joinedAt`, then `userId` — deterministic and stable across surfaces.
//
// Callers must project whichever total they are ranking on onto `totalSteps`
// before sorting (getHomeRaceCard/getRaceProgress project the LIVE total;
// getRaces and placementRecompute rank the persisted one).
function compareParticipantsForPlacement(left, right) {
  if (left.finishedAt && right.finishedAt) {
    const leftPlacement = left.placement ?? Number.MAX_SAFE_INTEGER;
    const rightPlacement = right.placement ?? Number.MAX_SAFE_INTEGER;
    if (leftPlacement !== rightPlacement) {
      return leftPlacement - rightPlacement;
    }

    const leftFinishedAt = new Date(left.finishedAt).getTime();
    const rightFinishedAt = new Date(right.finishedAt).getTime();
    if (leftFinishedAt !== rightFinishedAt) {
      return leftFinishedAt - rightFinishedAt;
    }
  }

  if (left.finishedAt) return -1;
  if (right.finishedAt) return 1;

  const stepDiff = (right.totalSteps || 0) - (left.totalSteps || 0);
  if (stepDiff !== 0) {
    return stepDiff;
  }

  const leftJoinedAt = left.joinedAt ? new Date(left.joinedAt).getTime() : 0;
  const rightJoinedAt = right.joinedAt ? new Date(right.joinedAt).getTime() : 0;
  if (leftJoinedAt !== rightJoinedAt) {
    return leftJoinedAt - rightJoinedAt;
  }

  return String(left.userId || "").localeCompare(String(right.userId || ""));
}

// userId -> 1-based placement, computed with the shared comparator. `rows` must
// already be the ACCEPTED set with the total to rank on projected onto
// `totalSteps`.
function placementsByUserId(rows) {
  const ranked = [...(rows || [])].sort(compareParticipantsForPlacement);
  const map = new Map();
  ranked.forEach((row, index) => {
    map.set(row.userId, index + 1);
  });
  return map;
}

module.exports = { compareParticipantsForPlacement, placementsByUserId };
