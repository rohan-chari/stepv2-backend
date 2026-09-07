
  WITH requested AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS request(
      "userId" text,
      "at" timestamptz
    )
  )
  SELECT DISTINCT ON (requested."userId")
         requested."userId",
         entitlement.event_id AS "eventId",
         event.multiplier,
         entitlement.ends_at AS "endsAt"
    FROM requested
    JOIN global_step_event_entitlements entitlement
      ON entitlement.user_id=requested."userId"
     AND entitlement.starts_at <= requested."at"
     AND entitlement.ends_at > requested."at"
     AND entitlement.start_outcome IN ('ACTIVATED_ON_TIME','ACTIVATED_LATE_JOIN')
    JOIN global_step_events event
      ON event.id=entitlement.event_id
     AND event.schedule_mode='LOCAL_ENTITLEMENTS'
    WHERE EXISTS (SELECT 1
    FROM global_event_race_impacts impact
    JOIN races race
      ON race.id=impact.race_id
     AND race.status::text='active'
    JOIN race_participants participant
      ON participant.race_id=impact.race_id
     AND participant.user_id=requested."userId"
     AND participant.status::text='accepted'
     AND participant.forfeited_at IS NULL
     AND participant.finished_at IS NULL
    WHERE impact.event_id=entitlement.event_id
      AND impact.user_id=requested."userId"
      AND ($2::text IS NULL OR impact.race_id=$2::text)
    )
   ORDER BY requested."userId",entitlement.starts_at DESC