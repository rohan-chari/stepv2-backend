// Durable lifecycle entries for a global event's race impact. These helpers
// only establish membership; settlement remains the sole score authority.

function uniqueUserIds(userIds = []) {
  return [...new Set(userIds.filter(Boolean))].sort();
}

// Serializes the two membership decisions that would otherwise write-skew:
// event creation scans ACTIVE races while a race start/late join checks for an
// ACTIVE event. It is intentionally a transaction-scoped advisory lock; both
// callers already own their domain transaction and neither needs a process
// local mutex.
async function acquireGlobalEnrollmentLock(tx) {
  if (typeof tx?.$executeRawUnsafe === "function") {
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      "global-event-enrollment"
    );
    return;
  }
  // Small injected transaction fakes in unit tests may expose only queryRaw.
  // Production Prisma uses executeRaw because pg_advisory_xact_lock returns
  // Postgres void, which queryRaw cannot deserialize with the pg adapter.
  if (typeof tx?.$queryRawUnsafe !== "function") return;
  await tx.$queryRawUnsafe(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    "global-event-enrollment"
  );
}

async function createPendingEnrollments(tx, { eventId, raceId, userIds }) {
  const unique = uniqueUserIds(userIds);
  if (!eventId || !raceId || unique.length === 0) return 0;
  const result = await tx.globalEventRaceImpact.createMany({
    data: unique.map((userId) => ({ eventId, raceId, userId, status: "PENDING" })),
    skipDuplicates: true,
  });
  return result.count || 0;
}

// Call inside the transaction that makes a participant/race ACTIVE. Doing this
// in the same commit closes the race-start/late-join gap without making a
// second best-effort write part of a user-visible response.
async function enrollIfGlobalEventActive(tx, { raceId, userIds, at }) {
  if (!tx?.globalStepEvent || !tx?.globalEventRaceImpact) return null;
  await acquireGlobalEnrollmentLock(tx);
  const current = new Date(at);
  const event = await tx.globalStepEvent.findFirst({
    where: { startsAt: { lte: current }, endsAt: { gt: current } },
    orderBy: { startsAt: "desc" },
  });
  if (!event) return null;
  await createPendingEnrollments(tx, { eventId: event.id, raceId, userIds });
  return event;
}

module.exports = {
  uniqueUserIds,
  acquireGlobalEnrollmentLock,
  createPendingEnrollments,
  enrollIfGlobalEventActive,
};
