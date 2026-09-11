// Existing participant timestamps establish the historical start cohort without
// replaying scoring. One bounded set read/update for the scheduler's <=100 rows.
// Active-race leave is a timestamped forfeit, not participant deletion. Cancelled
// races lack a reliable cancellation timestamp, so ambiguous candidates defer.
async function stampEventRecapStartCounts(tx, entitlementIds) {
  if (!entitlementIds.length) return;
  await tx.$executeRawUnsafe(`WITH counts AS (
    SELECT e.id,e.schedule_revision,
      COUNT(DISTINCT p.race_id) FILTER (WHERE r.id IS NOT NULL
        AND r.status IN ('active','completed')
        AND (r.completed_at IS NULL OR r.completed_at>e.starts_at)
        AND (p.finished_at IS NULL OR p.finished_at>e.starts_at)
        AND (p.forfeited_at IS NULL OR p.forfeited_at>e.starts_at))::int AS race_count,
      BOOL_OR(r.status='cancelled' OR (r.status='completed' AND r.completed_at IS NULL)) AS ambiguous
    FROM global_step_event_entitlements e
    LEFT JOIN LATERAL (
      SELECT participant.* FROM race_participants participant
      WHERE participant.user_id=e.user_id AND participant.status='accepted'
        AND participant.joined_at<=e.starts_at LIMIT 1001
    ) p ON TRUE
    LEFT JOIN races r ON r.id=p.race_id AND r.started_at<=e.starts_at
      AND (r.ends_at IS NULL OR r.ends_at>e.starts_at)
    WHERE e.id=ANY($1::text[]) AND e.recap_race_count IS NULL
    GROUP BY e.id,e.schedule_revision
    HAVING COUNT(p.id)<1001
  ) UPDATE global_step_event_entitlements e
    SET recap_race_count=c.race_count,recap_count_policy_version=1,
      recap_window_revision=c.schedule_revision
    FROM counts c WHERE e.id=c.id AND NOT COALESCE(c.ambiguous,FALSE)
      AND e.recap_race_count IS NULL`, entitlementIds);
}
module.exports = { stampEventRecapStartCounts };
