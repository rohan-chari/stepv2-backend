WITH candidates AS (
         SELECT outbox.id
           FROM inbox_delivery_outbox outbox
           JOIN inbox_alerts alert ON alert.id=outbox.alert_id
           JOIN notification_schedules schedule
             ON schedule.recipient_user_id=alert.user_id
            AND schedule.delivery_key=alert.source_key
          WHERE schedule.type='GLOBAL_EVENT_STARTED'
            AND outbox.status IN ('RETRY','LEASED','DELIVERED','EXHAUSTED')
            AND (outbox.expires_at IS NULL OR outbox.expires_at > $1)
            AND NOT EXISTS (
              SELECT 1 FROM inbox_delivery_device_attempts attempt
               WHERE attempt.outbox_id=outbox.id
            )
          ORDER BY outbox.updated_at,outbox.id LIMIT $2
       )
       UPDATE inbox_delivery_outbox outbox
          SET status='RETRY',available_at=$1,retry_at=$1,
              lease_until=NULL,lease_token=NULL,delivered_at=NULL,updated_at=$1,
              last_error_code='TARGET_SNAPSHOT_RECONCILED'
         FROM candidates WHERE outbox.id=candidates.id
