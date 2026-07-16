// Shared display-illusion logic (Stealth / Detour / Imposter), extracted from
// getRaceProgress so the tournament bracket payload masks a non-COMPLETED
// matchup exactly as the race room does — otherwise the bracket is a side
// channel that defeats Stealth (spec §6.4/D5). COMPLETED matchups always show
// true finals, so callers skip masking for those.

// Gather the viewer-dependent illusion state from a race's ACTIVE effects.
//   * stealthedUserIds: users whose plank is masked to everyone but themselves.
//   * viewerIsDetoured: the viewer sees ALL players as "???".
//   * imposterSwaps: leaderboard slot swaps (a race-room ordering illusion; the
//     fixed bracket does not reorder, so bracket callers ignore this).
function collectRaceIllusions(activeEffects, viewerUserId, nowMs = Date.now()) {
  const stealthedUserIds = new Set();
  let viewerIsDetoured = false;
  const imposterSwaps = [];

  for (const e of activeEffects || []) {
    if (e.type === "STEALTH_MODE") {
      stealthedUserIds.add(e.targetUserId);
    }
    if (e.type === "DETOUR_SIGN" && e.targetUserId === viewerUserId) {
      viewerIsDetoured = true;
    }
    if (e.type === "IMPOSTER") {
      const notExpired =
        !e.expiresAt || new Date(e.expiresAt).getTime() > nowMs;
      const swapWithUserId = (e.metadata || {}).swapWithUserId;
      if (notExpired && e.targetUserId && swapWithUserId) {
        imposterSwaps.push({ a: e.targetUserId, b: swapWithUserId });
      }
    }
  }

  return { stealthedUserIds, viewerIsDetoured, imposterSwaps };
}

// A player's plank in a matchup is stealth-masked when they are stealthed, are
// NOT the viewer, and have not finished — the same rule as the race-room
// leaderboard (getRaceProgress).
function isStealthedForViewer(
  userId,
  { stealthedUserIds, viewerUserId, finished }
) {
  return (
    stealthedUserIds.has(userId) && userId !== viewerUserId && !finished
  );
}

module.exports = { collectRaceIllusions, isStealthedForViewer };
