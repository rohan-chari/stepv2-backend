const { prisma } = require("../../../db");

class MarkRaceResultsSeenError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "MarkRaceResultsSeenError";
    this.statusCode = statusCode;
  }
}

// Mark the calling user's race-results popup as "seen" for a batch of races.
// Display-only ack: does NOT feed the box/powerup roll gate. Idempotent — a
// single updateMany sets results_seen_at = now() for this user's participant
// rows in the given races. Unknown / non-participant raceIds simply match no
// rows (updateMany ignores them), so the operation is always safe.
async function markRaceResultsSeen({ userId, raceIds }) {
  if (!Array.isArray(raceIds) || raceIds.length === 0) {
    throw new MarkRaceResultsSeenError("raceIds must be a non-empty array", 400);
  }
  if (!raceIds.every((id) => typeof id === "string" && id.length > 0)) {
    throw new MarkRaceResultsSeenError("raceIds must be an array of strings", 400);
  }

  return prisma.raceParticipant.updateMany({
    where: { userId, raceId: { in: raceIds } },
    data: { resultsSeenAt: new Date() },
  });
}

module.exports = { markRaceResultsSeen, MarkRaceResultsSeenError };
