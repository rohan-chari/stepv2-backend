const { Prisma } = require("@prisma/client");

// One authoritative Postgres predicate for both Home response builders. An
// aggregate net of zero is still eligible; only an all-zero per-race vector is
// suppressed.
async function getEligibleGlobalEventSummary({ prisma, userId }) {
  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT
      s.id,
      s.event_id AS "eventId",
      s.extra_race_steps AS "extraRaceSteps",
      s.race_count AS "raceCount",
      s.settled_at AS "settledAt"
    FROM global_event_user_summaries s
    WHERE s.user_id = ${userId}
      AND s.acknowledged_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM global_event_race_impacts i
        WHERE i.event_id = s.event_id
          AND i.user_id = s.user_id
          AND i.status = 'FINAL'
          AND i.delta_steps <> 0
      )
    ORDER BY s.settled_at DESC, s.id DESC
    LIMIT 1
  `);
  return rows[0] || null;
}

module.exports = { getEligibleGlobalEventSummary };
