const { randomUUID } = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");

function number(value) {
  return Number(value || 0);
}

async function recordOperationalCounters(client = defaultPrisma, deltas = {}) {
  if (!client?.globalStepEventOperationalCounter) return false;
  for (const [metric, rawDelta] of Object.entries(deltas)) {
    const delta = BigInt(Math.max(0, Math.round(Number(rawDelta) || 0)));
    if (delta === 0n) continue;
    await client.globalStepEventOperationalCounter.upsert({
      where: { metric },
      create: { metric, value: delta },
      update: { value: { increment: delta } },
    });
  }
  return true;
}

async function captureOperationalSnapshot({ client = defaultPrisma, now = new Date() } = {}) {
  const current = new Date(now);
  const staleBefore = new Date(current.getTime() - 2 * 60 * 1000);
  const [row = {}] = await client.$queryRawUnsafe(`
    WITH timezone_safe_entitlements AS (
      SELECT entitlement.*,
             COALESCE(known_timezone.name, 'America/New_York') AS effective_timezone
        FROM global_step_event_entitlements entitlement
        LEFT JOIN pg_timezone_names known_timezone
          ON known_timezone.name=entitlement.timezone
    ), participant_races AS (
      SELECT rp.race_id, rp.user_id, r.started_at,
             COALESCE(r.ends_at, $1) AS race_end,
             GREATEST(r.started_at, COALESCE(rp.joined_at, r.started_at)) AS membership_start,
             LEAST(
               COALESCE(r.ends_at, $1),
               COALESCE(rp.forfeited_at, COALESCE(r.ends_at, $1)),
               COALESCE(rp.finished_at, COALESCE(r.ends_at, $1))
             ) AS membership_end,
             CASE
               WHEN COALESCE(r.ends_at, $1) - r.started_at < interval '24 hours' THEN 'lt_24h'
               WHEN COALESCE(r.ends_at, $1) - r.started_at < interval '48 hours' THEN '24_48h'
               ELSE 'gte_48h'
             END AS duration_bucket
        FROM race_participants rp
        JOIN races r ON r.id = rp.race_id
       WHERE r.started_at IS NOT NULL
         AND rp.status = 'accepted'::"RaceParticipantStatus"
         AND EXISTS (
           SELECT 1 FROM global_step_events g
            WHERE g.schedule_mode = 'LOCAL_ENTITLEMENTS'
              AND g.starts_at < COALESCE(r.ends_at, $1)
              AND g.ends_at > r.started_at
         )
    ), opportunity_rows AS (
      SELECT pr.race_id, pr.user_id, pr.duration_bucket, e.event_id,
             CASE WHEN e.id IS NULL THEN NULL ELSE
               EXTRACT(EPOCH FROM (
                 ((e.starts_at AT TIME ZONE 'UTC') AT TIME ZONE e.effective_timezone) - e.starts_at
               )) / 60
             END AS offset_minutes
        FROM participant_races pr
        LEFT JOIN timezone_safe_entitlements e
          ON e.user_id = pr.user_id
         AND e.starts_at < pr.membership_end
         AND e.ends_at > pr.membership_start
    ), race_offset_span AS (
      SELECT race_id,
             COALESCE(MAX(offset_minutes) - MIN(offset_minutes), 0) AS offset_span
        FROM opportunity_rows
       GROUP BY race_id
    ), participant_exposure AS (
      SELECT o.race_id, o.user_id, o.duration_bucket,
             CASE
               WHEN ros.offset_span <= 120 THEN 'aligned'
               WHEN ros.offset_span <= 480 THEN 'moderate'
               ELSE 'wide'
             END AS offset_separation_bucket,
             COUNT(DISTINCT o.event_id) AS event_count
        FROM opportunity_rows o
        JOIN race_offset_span ros ON ros.race_id = o.race_id
       GROUP BY o.race_id, o.user_id, o.duration_bucket, ros.offset_span
    ), exposure_groups AS (
      SELECT duration_bucket || ':' || offset_separation_bucket AS bucket,
             COUNT(*) FILTER (WHERE event_count = 0) AS zero_count,
             COUNT(*) FILTER (WHERE event_count = 1) AS one_count,
             COUNT(*) FILTER (WHERE event_count > 1) AS multiple_count
        FROM participant_exposure
       GROUP BY duration_bucket, offset_separation_bucket
    ), entitlement_offset_groups AS (
      SELECT CASE
               WHEN offset_minutes < -360 THEN 'utc_minus_12_to_6'
               WHEN offset_minutes < 0 THEN 'utc_minus_6_to_0'
               WHEN offset_minutes <= 360 THEN 'utc_0_to_plus_6'
               ELSE 'utc_plus_6_to_14'
             END AS bucket,
             COUNT(*) AS count
        FROM (
          SELECT EXTRACT(EPOCH FROM (
                   ((e.starts_at AT TIME ZONE 'UTC') AT TIME ZONE e.effective_timezone) - e.starts_at
                 )) / 60 AS offset_minutes
            FROM timezone_safe_entitlements e
        ) offsets
       GROUP BY 1
    ), durable_counters AS (
      SELECT COALESCE(jsonb_object_agg(metric, value), '{}'::jsonb) AS values
        FROM global_step_event_operational_counters
    )
    SELECT
      (SELECT COUNT(*) FROM global_step_event_entitlements WHERE start_processed_at IS NULL AND starts_at <= $1) AS due_starts,
      (SELECT COUNT(*) FROM global_step_event_entitlements WHERE end_processed_at IS NULL AND ends_at <= $1) AS due_ends,
      (SELECT COUNT(*) FROM global_step_event_entitlements WHERE start_processed_at IS NULL AND starts_at < $2) AS stale_pending_starts,
      (SELECT COUNT(*) FROM global_step_events WHERE schedule_mode = 'LOCAL_ENTITLEMENTS' AND (event_day IS NULL OR local_start_minute IS NULL OR duration_minutes IS NULL)) AS invalid_local_parents,
      (SELECT COUNT(*) FROM global_step_events WHERE schedule_mode = 'LOCAL_ENTITLEMENTS' AND starts_at <= $1 AND ends_at > $1) AS active_parents,
      (SELECT COUNT(*) FROM global_step_event_entitlements WHERE starts_at <= $1 AND ends_at > $1) AS active_entitlements,
      (SELECT COUNT(*) FROM participant_exposure WHERE event_count = 0) AS exposure_zero_races,
      (SELECT COUNT(*) FROM participant_exposure WHERE event_count = 1) AS exposure_one_races,
      (SELECT COUNT(*) FROM participant_exposure WHERE event_count > 1) AS exposure_multiple_races,
      (SELECT COALESCE(jsonb_object_agg(bucket, jsonb_build_object(
        'zero', zero_count, 'one', one_count, 'multiple', multiple_count
      )), '{}'::jsonb) FROM exposure_groups) AS exposure_buckets,
      (SELECT COALESCE(jsonb_object_agg(bucket, count), '{}'::jsonb)
         FROM entitlement_offset_groups) AS entitlements_by_offset,
      jsonb_build_object(
        'startClaims', (SELECT COUNT(*) FROM global_step_event_entitlements WHERE start_processed_at IS NOT NULL AND start_outcome <> 'SKIPPED_STALE'),
        'startFailures', (SELECT COUNT(*) FROM global_step_event_entitlements WHERE start_outcome = 'SKIPPED_STALE'),
        'endClaims', (SELECT COUNT(*) FROM global_step_event_entitlements WHERE end_processed_at IS NOT NULL),
        'endFailures', (SELECT COUNT(*) FROM global_step_event_entitlements WHERE end_processed_at IS NULL AND ends_at < $2),
        'fallbackEntitlements', (SELECT COUNT(*) FROM global_step_event_entitlements e JOIN users u ON u.id=e.user_id WHERE e.timezone='America/New_York' AND u.global_event_timezone IS NULL),
        'candidateUsers', (SELECT COUNT(*) FROM users WHERE global_event_timezone_candidate IS NOT NULL),
        'lateEntitlements', (SELECT COUNT(*) FROM global_step_event_entitlements WHERE created_at > starts_at),
        'impactedRaces', (SELECT COUNT(DISTINCT race_id) FROM global_event_race_impacts),
        'pushesAttempted', (SELECT COUNT(*) FROM inbox_delivery_outbox o JOIN inbox_alerts a ON a.id=o.alert_id WHERE a.type='GLOBAL_EVENT_STARTED' AND o.attempt_count > 0),
        'pushesSent', (SELECT COUNT(*) FROM inbox_delivery_outbox o JOIN inbox_alerts a ON a.id=o.alert_id WHERE a.type='GLOBAL_EVENT_STARTED' AND o.delivered_at IS NOT NULL),
        'summariesPending', (SELECT COUNT(DISTINCT (i.event_id, i.user_id)) FROM global_event_race_impacts i WHERE i.status <> 'FINAL'),
        'summariesFinalized', (SELECT COUNT(*) FROM global_event_user_summaries),
        'maxStartQueueLatencyMs', COALESCE((SELECT MAX(EXTRACT(EPOCH FROM ($1-starts_at))*1000) FROM global_step_event_entitlements WHERE start_processed_at IS NULL AND starts_at <= $1), 0),
        'maxEndQueueLatencyMs', COALESCE((SELECT MAX(EXTRACT(EPOCH FROM ($1-ends_at))*1000) FROM global_step_event_entitlements WHERE end_processed_at IS NULL AND ends_at <= $1), 0)
      ) || (SELECT values FROM durable_counters) AS rollout_counters
  `, current, staleBefore);
  const data = {
    observedAt: current,
    dueStarts: number(row.due_starts),
    dueEnds: number(row.due_ends),
    stalePendingStarts: number(row.stale_pending_starts),
    invalidLocalParents: number(row.invalid_local_parents),
    activeParents: number(row.active_parents),
    activeEntitlements: number(row.active_entitlements),
    // Historical column names are retained because the migration is additive;
    // values now correctly count participant-race rows, including zeroes.
    exposureZeroRaces: number(row.exposure_zero_races),
    exposureOneRaces: number(row.exposure_one_races),
    exposureMultipleRaces: number(row.exposure_multiple_races),
    exposureBuckets: row.exposure_buckets || {},
    entitlementsByOffset: row.entitlements_by_offset || {},
    rolloutCounters: row.rollout_counters || {},
  };
  data.healthy = data.stalePendingStarts === 0 && data.invalidLocalParents === 0;
  return client.globalStepEventOperationalSnapshot.create({
    data: { id: randomUUID(), ...data },
  });
}

module.exports = { recordOperationalCounters, captureOperationalSnapshot };
