WITH candidate_ids AS MATERIALIZED (
       SELECT projection.id
         FROM domain_event_notification_projections projection
         JOIN domain_event_outbox event ON event.id=projection.domain_event_id
         JOIN domain_event_audiences audience
           ON audience.domain_event_id=event.id
          AND audience.recipient_id=projection.recipient_user_id
        WHERE event.event_type='PLACEMENT_CHANGED_V1'
          AND event.schema_version=1
          AND event.expansion_completed_at IS NOT NULL
          AND projection.projection_kind='SILENT_REFRESH'
          AND projection.status IN ('PENDING','RETRY','PROCESSING')
          AND projection.available_at <= $1
          AND (projection.lease_until IS NULL OR projection.lease_until <= $1)
          AND (
            NOT (event.payload ? 'endsAt') OR
            (jsonb_typeof(event.payload->'endsAt')='string' AND
             (event.payload->>'endsAt') ~
               '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$')
          )
          AND (
            NOT (audience.facts ? 'expiresAt') OR
            (jsonb_typeof(audience.facts->'expiresAt')='string' AND
             (audience.facts->>'expiresAt') ~
               '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$')
          )
          AND NOT EXISTS (
            SELECT 1 FROM device_tokens token
             WHERE token.user_id=projection.recipient_user_id
               AND (
                 token.status='ACTIVE' OR
                 (token.status IS NULL AND NOT EXISTS (
                   SELECT 1 FROM global_step_event_generation_state generation
                    WHERE generation.id=1 AND generation.quarantine_started_at IS NOT NULL
                 ))
               )
          )
        ORDER BY projection.available_at,event.occurred_at,projection.id
        LIMIT $2
        FOR UPDATE OF projection SKIP LOCKED
     ), records AS MATERIALIZED (
       SELECT projection.id,projection.domain_event_id,
              recipient.id IS NOT NULL AS recipient_exists,
              CASE WHEN event.payload ? 'endsAt'
                THEN (event.payload->>'endsAt')::timestamptz <= $1 ELSE false END
                AS event_expired,
              CASE WHEN audience.facts ? 'expiresAt'
                THEN (audience.facts->>'expiresAt')::timestamptz <= $1 ELSE false END
                AS audience_expired
         FROM candidate_ids candidate
         JOIN domain_event_notification_projections projection ON projection.id=candidate.id
         JOIN domain_event_outbox event ON event.id=projection.domain_event_id
         JOIN domain_event_audiences audience
           ON audience.domain_event_id=event.id
          AND audience.recipient_id=projection.recipient_user_id
         LEFT JOIN users recipient ON recipient.id=projection.recipient_user_id
     ), completed_projections AS (
       UPDATE domain_event_notification_projections projection
          SET status=CASE WHEN NOT record.recipient_exists OR
                                    record.event_expired OR record.audience_expired
                          THEN 'SUPPRESSED' ELSE 'COMPLETED' END,
              last_error_code=CASE WHEN NOT record.recipient_exists
                                     THEN 'RECIPIENT_DELETED'
                                   WHEN record.event_expired OR record.audience_expired
                                     THEN 'EVENT_EXPIRED'
                                   ELSE NULL END,
              lease_token=NULL,lease_until=NULL,completed_at=$1,updated_at=$1
         FROM records record
        WHERE projection.id=record.id
       RETURNING projection.id,projection.domain_event_id
     ), candidate_parents AS MATERIALIZED (
       SELECT DISTINCT domain_event_id FROM completed_projections
     ), completed_events AS (
       UPDATE domain_event_outbox event
          SET status=CASE WHEN EXISTS (
                SELECT 1 FROM domain_event_notification_projections failed
                 WHERE failed.domain_event_id=event.id
                   AND failed.status='FAILED_TERMINAL'
              ) THEN 'FAILED_TERMINAL' ELSE 'COMPLETED' END,
              completed_at=$1,lease_token=NULL,lease_until=NULL,updated_at=$1
         FROM candidate_parents parent
        WHERE event.id=parent.domain_event_id
          AND event.expansion_completed_at IS NOT NULL
          AND event.status NOT IN ('COMPLETED','SUPPRESSED','FAILED_TERMINAL')
          AND NOT EXISTS (
            SELECT 1 FROM domain_event_notification_projections remaining
             WHERE remaining.domain_event_id=event.id
               AND remaining.status NOT IN ('COMPLETED','SUPPRESSED','FAILED_TERMINAL')
               AND NOT EXISTS (
                 SELECT 1 FROM completed_projections completed
                  WHERE completed.id=remaining.id
               )
          )
       RETURNING event.id
     )
     SELECT count(*)::int AS processed FROM completed_projections
