const { prisma } = require("../../../db");

class MarkRankedResultsSeenError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "MarkRankedResultsSeenError";
    this.statusCode = statusCode;
  }
}

// Mark the calling user's ranked weekly-cohort summary popup as "seen" for one
// settled week. Display-only ack — the sibling of markRaceResultsSeen. We resolve
// the week by its public index, then an idempotent updateMany sets
// results_seen_at = now() on this user's member row for that week. An unknown
// weekIndex or a non-member matches no rows, so the call is always safe.
async function markRankedResultsSeen({ userId, weekIndex }) {
  if (!Number.isInteger(weekIndex)) {
    throw new MarkRankedResultsSeenError("weekIndex must be an integer", 400);
  }

  const week = await prisma.rankedWeek.findUnique({
    where: { index: weekIndex },
    select: { id: true },
  });
  if (!week) return { count: 0 };

  return prisma.rankedCohortMember.updateMany({
    where: { userId, weekId: week.id },
    data: { resultsSeenAt: new Date() },
  });
}

module.exports = { markRankedResultsSeen, MarkRankedResultsSeenError };
