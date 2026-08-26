-- Capture the migration-instant raw-step baseline inside the durable command
-- envelope. The worker, not this migration, remains the only participant-row
-- writer. This runs in the same deploy migration transaction sequence before
-- any replacement process starts claiming commands.
UPDATE race_admin_commands command
   SET payload = command.payload || jsonb_build_object(
     'baselineByParticipant', COALESCE((
       SELECT jsonb_object_agg(
         participant.id,
         GREATEST(
           0,
           COALESCE(
             participant.raw_steps,
             participant.total_steps - participant.bonus_steps
           )
         )
       )
         FROM race_participants participant
        WHERE participant.race_id = command.race_id
          AND participant.status = 'accepted'::"RaceParticipantStatus"
     ), '{}'::jsonb)
   )
 WHERE command.command_type = 'TOURNAMENT_POWERUPS_ACTIVATE'
   AND command.status = 'PENDING';
