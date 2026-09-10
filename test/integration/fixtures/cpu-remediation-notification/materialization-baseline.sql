WITH candidates AS (
           SELECT schedule.id
             FROM notification_schedules schedule
            WHERE schedule.type='GLOBAL_EVENT_STARTED'
              AND schedule.status='MATERIALIZED'
              AND (
                NOT EXISTS (
                  SELECT 1 FROM inbox_alerts alert
                  JOIN inbox_delivery_outbox outbox ON outbox.alert_id=alert.id AND outbox.kind='PUSH'
                   WHERE alert.user_id=schedule.recipient_user_id
                     AND alert.source_key=schedule.delivery_key
                )
              )
            ORDER BY schedule.updated_at,schedule.id LIMIT $2
         )
         UPDATE notification_schedules schedule
            SET status=CASE WHEN schedule.admission_class IS NULL THEN 'PENDING' ELSE 'ADMISSION_PENDING' END,
                claimed_at=NULL,released_at=NULL,
                canceled_at=NULL,cancellation_reason=NULL,available_at=$1,updated_at=$1
           FROM candidates WHERE schedule.id=candidates.id
