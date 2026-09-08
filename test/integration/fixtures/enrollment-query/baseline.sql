WITH enrollment_candidates AS MATERIALIZED (
       SELECT DISTINCT participant.user_id
       FROM race_participants participant
       JOIN races race ON race.id=participant.race_id
       WHERE participant.status='accepted'
         AND participant.forfeited_at IS NULL
         AND participant.finished_at IS NULL
         AND race.status='active'
         AND ($3::text IS NULL OR participant.user_id>$3)
         AND NOT EXISTS (
           SELECT 1 FROM global_step_event_entitlements entitlement
           WHERE entitlement.event_id=$1
             AND entitlement.user_id=participant.user_id
         )
       ORDER BY participant.user_id LIMIT $2
     )
     SELECT person.id,person.timezone,
            person.global_event_timezone AS "globalEventTimezone"
     FROM enrollment_candidates candidate
     JOIN users person ON person.id=candidate.user_id
     ORDER BY person.id
