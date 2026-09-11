// One indexed latest-event lookup per bounded caller cohort, before visibility
// filtering: acknowledging a newer event can never resurrect an older result.
async function readSavedEventRecaps(prisma, userIds) {
  if (!userIds.length) return [];
  return prisma.$queryRawUnsafe(`SELECT requested.user_id AS "userId",s.id,
    s.event_id AS "eventId",s.extra_race_steps AS "extraRaceSteps",s.race_count AS "raceCount",
    s.settled_at AS "settledAt",s.expires_at AS "expiresAt",
    FLOOR(EXTRACT(EPOCH FROM (s.expires_at-(statement_timestamp() AT TIME ZONE 'UTC')))*1000)::int AS "remainingMsAtLoad"
    FROM unnest($1::text[]) requested(user_id)
    CROSS JOIN LATERAL (
      SELECT e.event_id FROM global_step_event_entitlements e
      JOIN global_step_events p ON p.id=e.event_id
      WHERE e.user_id=requested.user_id AND e.ends_at<=(statement_timestamp() AT TIME ZONE 'UTC')
        AND p.multiplier=2 AND p.schedule_mode='LOCAL_ENTITLEMENTS'
      ORDER BY e.ends_at DESC,e.id DESC LIMIT 1
    ) latest
    JOIN event_recaps s ON s.user_id=requested.user_id AND s.event_id=latest.event_id
    WHERE s.acknowledged_at IS NULL AND NOT s.suppressed AND s.extra_race_steps>0
      AND s.expires_at>(statement_timestamp() AT TIME ZONE 'UTC')`, userIds);
}
module.exports = { readSavedEventRecaps };
