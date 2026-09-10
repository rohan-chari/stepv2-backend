WITH missing AS MATERIALIZED (
         SELECT outbox.id,outbox.alert_id,outbox.updated_at
           FROM inbox_delivery_outbox outbox
          WHERE outbox.status IN ('RETRY','LEASED','DELIVERED','EXHAUSTED')
            AND (outbox.expires_at IS NULL OR outbox.expires_at > $1)
            AND NOT EXISTS (SELECT 1 FROM inbox_delivery_device_attempts attempt WHERE attempt.outbox_id=outbox.id)
       ), candidates AS MATERIALIZED (
         SELECT outbox.id
           FROM missing outbox
           CROSS JOIN LATERAL (SELECT alert.user_id,alert.source_key FROM inbox_alerts alert WHERE alert.id=outbox.alert_id OFFSET 0) alert
           CROSS JOIN LATERAL (SELECT 1 FROM notification_schedules schedule
             WHERE schedule.recipient_user_id=alert.user_id AND schedule.delivery_key=alert.source_key
               AND schedule.type='GLOBAL_EVENT_STARTED' OFFSET 0) schedule
          ORDER BY outbox.updated_at,outbox.id LIMIT $2
       )
       UPDATE inbox_delivery_outbox outbox
          SET status='RETRY',available_at=$1,retry_at=$1,
              lease_until=NULL,lease_token=NULL,delivered_at=NULL,updated_at=$1,
              last_error_code='TARGET_SNAPSHOT_RECONCILED'
         FROM candidates WHERE outbox.id=candidates.id
