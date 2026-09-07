SELECT jsonb_build_object(
          'id', race.id,
          'name', race.name,
          'scheduledStartAt', EXTRACT(EPOCH FROM race.scheduled_start_at) * 1000,
          'teamAName', race.team_a_name,
          'teamBName', race.team_b_name,
          'status', UPPER(race.status::text),
          'startedAt', EXTRACT(EPOCH FROM race.started_at) * 1000,
          'endsAt', EXTRACT(EPOCH FROM race.ends_at) * 1000,
          'timezone', race.timezone,
          'targetSteps', race.target_steps,
          'timeBased', race.time_based,
          'powerupsEnabled', race.powerups_enabled,
          'powerupStepInterval', race.powerup_step_interval,
          'isTeamRace', race.is_team_race,
          'teamSize', race.team_size
        ) AS race,
        COALESCE(jsonb_agg(jsonb_build_object(
          'id', participant.id,
          'userId', participant.user_id,
          'status', UPPER(participant.status::text),
          'totalSteps', participant.total_steps,
          'rawSteps', participant.raw_steps,
          'bonusSteps', participant.bonus_steps,
          'maxBonusSteps', participant.max_bonus_steps,
          'nextBoxAtSteps', participant.next_box_at_steps,
          'powerupSlots', participant.powerup_slots,
          'finishedAt', EXTRACT(EPOCH FROM participant.finished_at) * 1000,
          'finishTotalSteps', participant.finish_total_steps,
          'forfeitedAt', EXTRACT(EPOCH FROM participant.forfeited_at) * 1000,
          'joinedAt', EXTRACT(EPOCH FROM participant.joined_at) * 1000,
          'team', UPPER(participant.team::text),
          'placement', participant.placement,
          'lastNotifiedPlacement', participant.last_notified_placement,
          'highMultiplierNotifiedAt', EXTRACT(EPOCH FROM participant.high_multiplier_notified_at) * 1000,
          'user', jsonb_build_object('id', person.id, 'displayName', person.display_name),
          'totalsUpdatedAt', EXTRACT(EPOCH FROM participant.totals_updated_at) * 1000
        ) ORDER BY participant.id) FILTER (WHERE participant.id IS NOT NULL), '[]'::jsonb)
          AS participants
       FROM races race
       LEFT JOIN race_participants participant ON participant.race_id=race.id
       LEFT JOIN users person ON person.id=participant.user_id
       WHERE race.id=$1
       GROUP BY race.id