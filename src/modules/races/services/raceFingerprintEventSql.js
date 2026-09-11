// The deployed recap event query, extracted verbatim. Final transaction fences
// retain PostgreSQL authority. Versioned fingerprints use a total event order.
const FULL_EVENT_SQL = `/* steps:prepared-read:v1 */ WITH race_window AS (
         SELECT started_at FROM races WHERE id=$1
       ), schedule AS (
         SELECT COALESCE((
           SELECT NOT EXISTS (
             SELECT 1
             FROM (
               SELECT source.starts_at AS boundary_at, source.id AS event_id,
                 'START'::text AS boundary_kind
               FROM global_step_events source
               JOIN race_window race ON source.ends_at > race.started_at
               WHERE source.schedule_mode='LEGACY_GLOBAL'
               UNION ALL
               SELECT source.ends_at AS boundary_at, source.id AS event_id,
                 'END'::text AS boundary_kind
               FROM global_step_events source
               JOIN race_window race ON source.ends_at > race.started_at
               WHERE source.schedule_mode='LEGACY_GLOBAL'
             ) boundary
             WHERE boundary.boundary_at <=
                 (to_timestamp($3::float8 / 1000) AT TIME ZONE 'UTC')
               AND (boundary.boundary_at, boundary.event_id, boundary.boundary_kind) >
                 (cursor.boundary_at, cursor.event_id, cursor.boundary_kind)
           )
           FROM global_step_event_boundary_cursors cursor
           WHERE cursor.key='global'
         ), false) AS current
       ), candidate_events AS (
         SELECT event.id, event.starts_at, event.ends_at,
           event.multiplier, event.label, event.schedule_mode,
           NULL::text AS entitlement_id, NULL::text AS impact_id,
           NULL::text AS user_id
         FROM global_step_events event
         JOIN races race ON race.id=$1
         WHERE event.schedule_mode='LEGACY_GLOBAL'
           AND event.ends_at > race.started_at AND event.starts_at <= $2
         UNION ALL
         SELECT event.id, entitlement.starts_at, entitlement.ends_at,
           event.multiplier, event.label, event.schedule_mode,
           entitlement.id, impact.id, entitlement.user_id
         FROM global_step_event_entitlements entitlement
         JOIN global_step_events event ON event.id=entitlement.event_id
           AND event.schedule_mode='LOCAL_ENTITLEMENTS'
         JOIN global_event_race_impacts impact
           ON impact.event_id=entitlement.event_id
          AND impact.user_id=entitlement.user_id
          AND impact.race_id=$1
         JOIN races race ON race.id=$1
         WHERE entitlement.start_outcome IN ('ACTIVATED_ON_TIME','ACTIVATED_LATE_JOIN')
           AND entitlement.ends_at > race.started_at
           AND entitlement.starts_at <= $2
       )
       SELECT event.id, event.starts_at AS "startsAt", event.ends_at AS "endsAt",
         event.multiplier, event.label, event.schedule_mode AS "scheduleMode",
         event.entitlement_id AS "entitlementId", event.impact_id AS "impactId",
         event.user_id AS "userId",
         schedule.current AS "globalBoundaryScheduleCurrent"
       FROM schedule LEFT JOIN candidate_events event ON TRUE
       ORDER BY event.starts_at, event.id, event.entitlement_id, event.impact_id, event.user_id`;

module.exports = { FULL_EVENT_SQL };
