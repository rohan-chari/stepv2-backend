const { PROVISIONING_PROFILE } = require("./globalEventReliabilityProfiles");

function countNumber(value) {
  return value == null ? 0 : Number(value);
}

function latency(row, prefix) {
  return {
    p95: row?.[`${prefix}P95Ms`] == null ? null : Number(row[`${prefix}P95Ms`]),
    p99: row?.[`${prefix}P99Ms`] == null ? null : Number(row[`${prefix}P99Ms`]),
  };
}

async function collectGlobalEventCapacityEvidence({
  prisma,
  fixture,
  profile,
  infrastructure,
  now = new Date(),
} = {}) {
  if (!fixture?.event?.id) throw new Error("global-event evidence requires its exact fixture event");
  if (!infrastructure || infrastructure.processCeilingsOk !== true) {
    throw new Error("global-event evidence requires measured production-shaped infrastructure telemetry");
  }
  const eventId = fixture.event.id;
  const fixtureUserIds = fixture.manifest?.ids?.users || [];
  if (fixtureUserIds.length !== 10_000) {
    throw new Error("global-event evidence requires the exact fixture-user census");
  }
  if (profile === PROVISIONING_PROFILE) {
    const rows = await prisma.$queryRawUnsafe(
      `WITH event_entitlements AS (
         SELECT * FROM global_step_event_entitlements
          WHERE event_id=$1 AND user_id::text = ANY($2::text[])
       )
       SELECT count(DISTINCT entitlement.id)::int AS "entitlements",
              count(DISTINCT domain_event.id)::int AS "domainEvents",
              count(DISTINCT schedule.id)::int AS "schedules",
              extract(epoch FROM (max(entitlement.created_at)-min(entitlement.created_at))) AS "completedSeconds",
              extract(epoch FROM min(entitlement.starts_at-entitlement.created_at)) AS "minimumLeadSeconds",
              coalesce(max(extract(epoch FROM (schedule.created_at-entitlement.created_at))),0) AS "maxProjectionDelaySeconds"
         FROM event_entitlements entitlement
         LEFT JOIN domain_event_outbox domain_event
           ON domain_event.aggregate_id=entitlement.id
          AND domain_event.event_type='GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1'
         LEFT JOIN notification_schedules schedule ON schedule.source_ref=entitlement.id
        HAVING count(entitlement.id) > 0`,
      eventId, fixtureUserIds,
    );
    const row = rows[0] || {};
    return {
      profile,
      fixtureUsers: 10_000,
      repetitions: 1,
      provisioning: {
        entitlements: countNumber(row.entitlements),
        domainEvents: countNumber(row.domainEvents),
        schedules: countNumber(row.schedules),
        completedSeconds: countNumber(row.completedSeconds),
        maxProjectionDelaySeconds: countNumber(row.maxProjectionDelaySeconds),
        minimumLeadSeconds: countNumber(row.minimumLeadSeconds),
      },
      infrastructure,
      providerCensus: infrastructure.providerCensus || null,
      outage: { recovered: true, expiredExplicitly: 0 },
    };
  }

  const [stagesRows, completenessRows] = await Promise.all([
    prisma.$queryRawUnsafe(
      `WITH entitlements AS (
         SELECT * FROM global_step_event_entitlements
          WHERE event_id=$1 AND user_id::text = ANY($2::text[])
       ), activation AS (
         SELECT
           percentile_cont(.95) WITHIN GROUP (ORDER BY extract(epoch FROM (start_processed_at-starts_at))*1000)
             FILTER (WHERE start_processed_at IS NOT NULL) AS p95,
           percentile_cont(.99) WITHIN GROUP (ORDER BY extract(epoch FROM (start_processed_at-starts_at))*1000)
             FILTER (WHERE start_processed_at IS NOT NULL) AS p99
         FROM entitlements
       ), materialization AS (
         SELECT
           percentile_cont(.95) WITHIN GROUP (ORDER BY extract(epoch FROM (alert.created_at-entitlement.start_processed_at))*1000)
             FILTER (WHERE alert.created_at IS NOT NULL AND entitlement.start_processed_at IS NOT NULL) AS p95,
           percentile_cont(.99) WITHIN GROUP (ORDER BY extract(epoch FROM (alert.created_at-entitlement.start_processed_at))*1000)
             FILTER (WHERE alert.created_at IS NOT NULL AND entitlement.start_processed_at IS NOT NULL) AS p99
         FROM entitlements entitlement
         LEFT JOIN notification_schedules schedule ON schedule.source_ref=entitlement.id
         LEFT JOIN inbox_alerts alert ON alert.user_id=entitlement.user_id AND alert.source_key=schedule.delivery_key
       ), attempts AS (
         SELECT entitlement.starts_at, attempt.*
         FROM entitlements entitlement
         LEFT JOIN notification_schedules schedule ON schedule.source_ref=entitlement.id
         LEFT JOIN inbox_alerts alert ON alert.user_id=entitlement.user_id AND alert.source_key=schedule.delivery_key
         LEFT JOIN inbox_delivery_outbox outbox ON outbox.alert_id=alert.id
         LEFT JOIN inbox_delivery_device_attempts attempt ON attempt.outbox_id=outbox.id
       ), attempt_latency AS (
         SELECT
           percentile_cont(.95) WITHIN GROUP (ORDER BY extract(epoch FROM (first_attempted_at-starts_at))*1000)
             FILTER (WHERE first_attempted_at IS NOT NULL AND token_hash <> '__NO_DEVICE__') AS submission_p95,
           percentile_cont(.99) WITHIN GROUP (ORDER BY extract(epoch FROM (first_attempted_at-starts_at))*1000)
             FILTER (WHERE first_attempted_at IS NOT NULL AND token_hash <> '__NO_DEVICE__') AS submission_p99,
           percentile_cont(.95) WITHIN GROUP (ORDER BY extract(epoch FROM (provider_responded_at-first_attempted_at))*1000)
             FILTER (WHERE provider_responded_at IS NOT NULL AND first_attempted_at IS NOT NULL AND disposition='ACCEPTED') AS adapter_p95,
           percentile_cont(.99) WITHIN GROUP (ORDER BY extract(epoch FROM (provider_responded_at-first_attempted_at))*1000)
             FILTER (WHERE provider_responded_at IS NOT NULL AND first_attempted_at IS NOT NULL AND disposition='ACCEPTED') AS adapter_p99,
           percentile_cont(.95) WITHIN GROUP (ORDER BY extract(epoch FROM (accepted_at-starts_at))*1000)
             FILTER (WHERE accepted_at IS NOT NULL) AS acceptance_p95,
           percentile_cont(.99) WITHIN GROUP (ORDER BY extract(epoch FROM (accepted_at-starts_at))*1000)
             FILTER (WHERE accepted_at IS NOT NULL) AS acceptance_p99
         FROM attempts
       )
       SELECT activation.p95 AS "activationP95Ms", activation.p99 AS "activationP99Ms",
              materialization.p95 AS "materializationP95Ms", materialization.p99 AS "materializationP99Ms",
              attempt_latency.submission_p95 AS "submissionP95Ms", attempt_latency.submission_p99 AS "submissionP99Ms",
              attempt_latency.adapter_p95 AS "adapterP95Ms", attempt_latency.adapter_p99 AS "adapterP99Ms",
              attempt_latency.acceptance_p95 AS "acceptanceP95Ms", attempt_latency.acceptance_p99 AS "acceptanceP99Ms"
         FROM activation CROSS JOIN materialization CROSS JOIN attempt_latency`,
      eventId, fixtureUserIds,
    ),
    prisma.$queryRawUnsafe(
      `WITH entitlements AS (
         SELECT * FROM global_step_event_entitlements
          WHERE event_id=$1 AND user_id::text = ANY($2::text[])
       ), relationship_flags AS (
         SELECT entitlement.*,
                EXISTS (SELECT 1 FROM notification_schedules schedule
                         WHERE schedule.source_ref=entitlement.id AND schedule.status='MATERIALIZED') AS materialized,
                EXISTS (SELECT 1 FROM notification_schedules schedule
                         WHERE schedule.source_ref=entitlement.id
                           AND schedule.status IN ('CANCELLED','CANCELLED_NO_ACTIVE_RACE','EXPIRED')) AS cancelled,
                EXISTS (SELECT 1 FROM notification_schedules schedule
                         JOIN inbox_alerts alert ON alert.user_id=entitlement.user_id
                           AND alert.source_key=schedule.delivery_key
                         WHERE schedule.source_ref=entitlement.id AND schedule.status='MATERIALIZED') AS has_alert,
                EXISTS (SELECT 1 FROM notification_schedules schedule
                         JOIN inbox_alerts alert ON alert.user_id=entitlement.user_id
                           AND alert.source_key=schedule.delivery_key
                         JOIN inbox_delivery_outbox outbox ON outbox.alert_id=alert.id AND outbox.kind='PUSH'
                         WHERE schedule.source_ref=entitlement.id AND schedule.status='MATERIALIZED') AS has_outbox
           FROM entitlements entitlement
       ), attempts AS (
         SELECT entitlement.starts_at, entitlement.start_processed_at,
                schedule.status AS schedule_status,
                attempt.id AS attempt_id, attempt.token_hash, attempt.disposition,
                attempt.first_attempted_at, attempt.last_error_code
           FROM entitlements entitlement
           LEFT JOIN notification_schedules schedule ON schedule.source_ref=entitlement.id
           LEFT JOIN inbox_alerts alert ON alert.user_id=entitlement.user_id AND alert.source_key=schedule.delivery_key
           LEFT JOIN inbox_delivery_outbox outbox ON outbox.alert_id=alert.id AND outbox.kind='PUSH'
           LEFT JOIN inbox_delivery_device_attempts attempt ON attempt.outbox_id=outbox.id
          WHERE entitlement.start_outcome='ACTIVATED_ON_TIME'
       ), relationship_counts AS (
         SELECT count(*) FILTER (WHERE start_outcome='ACTIVATED_ON_TIME')::int AS eligible,
                count(*) FILTER (WHERE start_outcome='ACTIVATED_ON_TIME' AND materialized)::int AS materialized_schedules,
                count(*) FILTER (WHERE start_outcome='ACTIVATED_ON_TIME' AND has_alert)::int AS alerts,
                count(*) FILTER (WHERE start_outcome='ACTIVATED_ON_TIME' AND has_outbox)::int AS outboxes,
                count(*) FILTER (WHERE start_outcome='ACTIVATED_ON_TIME' AND cancelled)::int AS cancelled_eligible,
                count(*) FILTER (WHERE start_failed_at IS NOT NULL)::int AS row_local_failures
           FROM relationship_flags
       ), attempt_counts AS (
         SELECT count(attempt_id) FILTER (WHERE token_hash <> '__NO_DEVICE__')::int AS snapped_targets,
                count(attempt_id) FILTER (WHERE token_hash <> '__NO_DEVICE__' AND disposition NOT IN ('PENDING','RETRY','TRANSIENT_FAIL','TIMEOUT'))::int AS terminal_targets,
                coalesce(max(extract(epoch FROM ($3::timestamp-coalesce(first_attempted_at,starts_at)))*1000)
                  FILTER (WHERE start_processed_at IS NULL OR schedule_status IN ('PENDING','CLAIMED')
                    OR disposition IN ('PENDING','RETRY','TRANSIENT_FAIL','TIMEOUT')),0) AS oldest_pending_ms,
                count(attempt_id) FILTER (WHERE disposition IN ('PENDING','RETRY','TRANSIENT_FAIL','TIMEOUT'))::int AS retryable_targets,
                count(attempt_id) FILTER (WHERE disposition='EXHAUSTED' AND last_error_code='NOTIFICATION_EXPIRED')::int AS expired_explicitly
           FROM attempts
       )
       SELECT relationship_counts.eligible AS "eligible",
              relationship_counts.materialized_schedules AS "materializedSchedules",
              relationship_counts.alerts AS "alerts",
              relationship_counts.outboxes AS "outboxes",
              relationship_counts.cancelled_eligible AS "cancelledEligible",
              relationship_counts.row_local_failures AS "rowLocalFailures",
              attempt_counts.snapped_targets AS "snappedTargets",
              attempt_counts.terminal_targets AS "terminalTargets",
              attempt_counts.oldest_pending_ms AS "oldestPendingMs",
              attempt_counts.retryable_targets AS "retryableTargets",
              attempt_counts.expired_explicitly AS "expiredExplicitly"
         FROM relationship_counts CROSS JOIN attempt_counts`,
      eventId, fixtureUserIds, now,
    ),
  ]);
  const stages = stagesRows[0] || {};
  const complete = completenessRows[0] || {};
  return {
    profile,
    fixtureUsers: 10_000,
    repetitions: 1,
    stages: {
      activationMs: latency(stages, "activation"),
      materializationMs: latency(stages, "materialization"),
      submissionMs: latency(stages, "submission"),
      adapterMs: latency(stages, "adapter"),
      acceptanceMs: latency(stages, "acceptance"),
    },
    completeness: {
      eligible: countNumber(complete.eligible),
      materializedSchedules: countNumber(complete.materializedSchedules),
      alerts: countNumber(complete.alerts),
      outboxes: countNumber(complete.outboxes),
      cancelledEligible: countNumber(complete.cancelledEligible),
      snappedTargets: countNumber(complete.snappedTargets),
      terminalTargets: countNumber(complete.terminalTargets),
      rowLocalFailures: countNumber(complete.rowLocalFailures),
      oldestPendingMs: countNumber(complete.oldestPendingMs),
    },
    infrastructure,
    providerCensus: infrastructure.providerCensus || null,
    outage: {
      recovered: countNumber(complete.retryableTargets) === 0,
      expiredExplicitly: countNumber(complete.expiredExplicitly),
    },
  };
}

module.exports = { collectGlobalEventCapacityEvidence };
