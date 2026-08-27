const { Prisma } = require("@prisma/client");

// One authoritative Postgres predicate for both Home response builders. An
// aggregate net of zero is still eligible; only an all-zero per-race vector is
// suppressed.
async function getEligibleGlobalEventSummary({ prisma, userId }) {
  const rows = await prisma.$queryRaw(Prisma.sql`
    WITH authoritative_time AS (
      SELECT statement_timestamp() AT TIME ZONE 'UTC' AS now_at_load
    )
    SELECT
      s.id,
      s.event_id AS "eventId",
      s.extra_race_steps AS "extraRaceSteps",
      s.race_count AS "raceCount",
      s.settled_at AS "settledAt",
      s.expires_at AS "expiresAt",
      GREATEST(
        0,
        FLOOR(EXTRACT(EPOCH FROM (s.expires_at - t.now_at_load)) * 1000)
      )::int AS "remainingMsAtLoad"
    FROM global_event_user_summaries s
    CROSS JOIN authoritative_time t
    WHERE s.user_id = ${userId}
      AND s.acknowledged_at IS NULL
      AND s.attribution_version = 2
      AND s.expires_at > t.now_at_load
      AND EXISTS (
        SELECT 1
        FROM global_event_race_impacts i
        WHERE i.event_id = s.event_id
          AND i.user_id = s.user_id
          AND i.status = 'FINAL'
          AND i.attribution_version = 2
          AND i.delta_steps <> 0
      )
    ORDER BY s.settled_at DESC, s.id DESC
    LIMIT 1
  `);
  const row = rows[0];
  if (!row || !Number.isInteger(row.remainingMsAtLoad) || row.remainingMsAtLoad <= 0) {
    return null;
  }
  const { remainingMsAtLoad, ...summary } = row;
  return { ...summary, validForMs: remainingMsAtLoad };
}

module.exports = { getEligibleGlobalEventSummary };
