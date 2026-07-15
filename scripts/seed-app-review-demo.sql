-- App Review demo seed.
-- Idempotent: re-running refreshes the same demo rows instead of duplicating them.
-- Target account: apple_id = 'review-account-v1' (provisioned by the wrapper script
-- using APP_REVIEW_EMAIL). The reviewer is an UNFLAGGED real user; only the
-- seeded supporting cast (Alex/Maya/Jordan) carries is_review_account = true,
-- so they stay invisible to real users in search, leaderboards, public races.

BEGIN;

DO $$
DECLARE
  demo_user_id text;
  alex_id text;
  maya_id text;
  jordan_id text;
  week_start date := (
    current_date - ((extract(isodow from current_date)::int - 1) * interval '1 day')
  )::date;
  today date := current_date;
BEGIN
  SELECT id INTO demo_user_id
  FROM users
  WHERE apple_id = 'review-account-v1';

  IF demo_user_id IS NULL THEN
    RAISE EXCEPTION 'No reviewer user with apple_id review-account-v1 found. Run the wrapper script to provision it first.';
  END IF;

  UPDATE users
  SET
    coins = 5000,
    step_goal = 8000,
    last_step_sync_at = now(),
    profile_photo_prompt_dismissed_at = now()
  WHERE id = demo_user_id;

  INSERT INTO users (
    id,
    apple_id,
    email,
    name,
    display_name,
    coins,
    step_goal,
    last_step_sync_at,
    is_review_account,
    created_at
  )
  VALUES
    (
      '11111111-1111-4111-8111-111111111111',
      'demo-review-alex',
      'alex.demo@example.com',
      'Alex Summit',
      'Alex Summit',
      1250,
      9000,
      now(),
      true,
      now() - interval '12 days'
    ),
    (
      '22222222-2222-4222-8222-222222222222',
      'demo-review-maya',
      'maya.demo@example.com',
      'Maya Miles',
      'Maya Miles',
      1800,
      10000,
      now(),
      true,
      now() - interval '10 days'
    ),
    (
      '33333333-3333-4333-8333-333333333333',
      'demo-review-jordan',
      'jordan.demo@example.com',
      'Jordan Pace',
      'Jordan Pace',
      2200,
      7500,
      now(),
      true,
      now() - interval '8 days'
    )
  ON CONFLICT (apple_id) DO UPDATE
  SET
    email = excluded.email,
    name = excluded.name,
    display_name = excluded.display_name,
    coins = excluded.coins,
    step_goal = excluded.step_goal,
    last_step_sync_at = now(),
    is_review_account = true;

  SELECT id INTO alex_id FROM users WHERE apple_id = 'demo-review-alex';
  SELECT id INTO maya_id FROM users WHERE apple_id = 'demo-review-maya';
  SELECT id INTO jordan_id FROM users WHERE apple_id = 'demo-review-jordan';

  INSERT INTO friendships (
    id,
    requester_id,
    addressee_id,
    status,
    relationship_type,
    created_at,
    updated_at
  )
  VALUES
    (
      '70000000-0000-4000-8000-000000000001',
      demo_user_id,
      alex_id,
      'ACCEPTED',
      'friend',
      now() - interval '9 days',
      now()
    ),
    (
      '70000000-0000-4000-8000-000000000002',
      demo_user_id,
      maya_id,
      'ACCEPTED',
      'friend',
      now() - interval '8 days',
      now()
    ),
    (
      '70000000-0000-4000-8000-000000000003',
      jordan_id,
      demo_user_id,
      'ACCEPTED',
      'partner',
      now() - interval '7 days',
      now()
    )
  ON CONFLICT (requester_id, addressee_id) DO UPDATE
  SET
    status = excluded.status,
    relationship_type = excluded.relationship_type,
    updated_at = now();

  INSERT INTO steps (id, user_id, steps, step_goal, date, created_at)
  VALUES
    ('80000000-0000-4000-8000-000000000001', demo_user_id, 9400, 8000, today, now()),
    ('80000000-0000-4000-8000-000000000002', demo_user_id, 11200, 8000, today - 1, now()),
    ('80000000-0000-4000-8000-000000000003', demo_user_id, 8750, 8000, today - 2, now()),
    ('80000000-0000-4000-8000-000000000004', demo_user_id, 13100, 8000, today - 3, now()),
    ('80000000-0000-4000-8000-000000000011', alex_id, 8200, 9000, today, now()),
    ('80000000-0000-4000-8000-000000000012', alex_id, 9900, 9000, today - 1, now()),
    ('80000000-0000-4000-8000-000000000013', alex_id, 7600, 9000, today - 2, now()),
    ('80000000-0000-4000-8000-000000000021', maya_id, 10500, 10000, today, now()),
    ('80000000-0000-4000-8000-000000000022', maya_id, 12100, 10000, today - 1, now()),
    ('80000000-0000-4000-8000-000000000023', maya_id, 9100, 10000, today - 2, now()),
    ('80000000-0000-4000-8000-000000000031', jordan_id, 7200, 7500, today, now()),
    ('80000000-0000-4000-8000-000000000032', jordan_id, 8400, 7500, today - 1, now())
  ON CONFLICT (user_id, date) DO UPDATE
  SET
    steps = excluded.steps,
    step_goal = excluded.step_goal;

  INSERT INTO step_samples (
    id,
    user_id,
    period_start,
    period_end,
    steps,
    source_name,
    source_id,
    source_device_id,
    device_model,
    recording_method,
    metadata,
    created_at
  )
  VALUES
    (
      '81000000-0000-4000-8000-000000000001',
      demo_user_id,
      today + time '09:00',
      today + time '10:00',
      2200,
      'App Review Demo',
      'demo',
      'demo-iphone',
      'iPhone',
      'automatic',
      '{"demo": true}'::jsonb,
      now()
    ),
    (
      '81000000-0000-4000-8000-000000000002',
      demo_user_id,
      today + time '10:00',
      today + time '11:00',
      1800,
      'App Review Demo',
      'demo',
      'demo-iphone',
      'iPhone',
      'automatic',
      '{"demo": true}'::jsonb,
      now()
    ),
    (
      '81000000-0000-4000-8000-000000000003',
      demo_user_id,
      today + time '13:00',
      today + time '14:00',
      2900,
      'App Review Demo',
      'demo',
      'demo-iphone',
      'iPhone',
      'automatic',
      '{"demo": true}'::jsonb,
      now()
    ),
    (
      '81000000-0000-4000-8000-000000000004',
      demo_user_id,
      today + time '16:00',
      today + time '17:00',
      1600,
      'App Review Demo',
      'demo',
      'demo-iphone',
      'iPhone',
      'automatic',
      '{"demo": true}'::jsonb,
      now()
    ),
    (
      '81000000-0000-4000-8000-000000000011',
      alex_id,
      today + time '09:00',
      today + time '10:00',
      1700,
      'App Review Demo',
      'demo',
      'demo-iphone',
      'iPhone',
      'automatic',
      '{"demo": true}'::jsonb,
      now()
    ),
    (
      '81000000-0000-4000-8000-000000000012',
      alex_id,
      today + time '12:00',
      today + time '13:00',
      2400,
      'App Review Demo',
      'demo',
      'demo-iphone',
      'iPhone',
      'automatic',
      '{"demo": true}'::jsonb,
      now()
    ),
    (
      '81000000-0000-4000-8000-000000000021',
      maya_id,
      today + time '09:00',
      today + time '10:00',
      2600,
      'App Review Demo',
      'demo',
      'demo-iphone',
      'iPhone',
      'automatic',
      '{"demo": true}'::jsonb,
      now()
    ),
    (
      '81000000-0000-4000-8000-000000000022',
      maya_id,
      today + time '15:00',
      today + time '16:00',
      3100,
      'App Review Demo',
      'demo',
      'demo-iphone',
      'iPhone',
      'automatic',
      '{"demo": true}'::jsonb,
      now()
    ),
    (
      '81000000-0000-4000-8000-000000000031',
      jordan_id,
      today + time '11:00',
      today + time '12:00',
      1900,
      'App Review Demo',
      'demo',
      'demo-iphone',
      'iPhone',
      'automatic',
      '{"demo": true}'::jsonb,
      now()
    ),
    (
      '81000000-0000-4000-8000-000000000032',
      jordan_id,
      today + time '14:00',
      today + time '15:00',
      1800,
      'App Review Demo',
      'demo',
      'demo-iphone',
      'iPhone',
      'automatic',
      '{"demo": true}'::jsonb,
      now()
    )
  ON CONFLICT (id) DO UPDATE
  SET
    period_start = excluded.period_start,
    period_end = excluded.period_end,
    steps = excluded.steps,
    metadata = excluded.metadata;

  INSERT INTO challenges (
    id,
    title,
    description,
    type,
    resolution_rule,
    threshold_value,
    active,
    last_used_at,
    created_at
  )
  VALUES
    (
      '90000000-0000-4000-8000-000000000001',
      'App Review Step Duel',
      'Demo weekly challenge for App Review.',
      'head_to_head',
      'higher_total_steps',
      null,
      true,
      now(),
      now() - interval '20 days'
    )
  ON CONFLICT (id) DO UPDATE
  SET
    title = excluded.title,
    description = excluded.description,
    active = true,
    last_used_at = now();

  INSERT INTO weekly_challenges (
    id,
    week_of,
    challenge_id,
    dropped_at,
    resolved_at,
    created_at,
    updated_at
  )
  VALUES (
    '91000000-0000-4000-8000-000000000001',
    week_start,
    '90000000-0000-4000-8000-000000000001',
    now() - interval '6 hours',
    null,
    now() - interval '6 hours',
    now()
  )
  ON CONFLICT (week_of) DO UPDATE
  SET
    challenge_id = excluded.challenge_id,
    dropped_at = excluded.dropped_at,
    resolved_at = null,
    updated_at = now();

  INSERT INTO stakes (
    id,
    name,
    description,
    category,
    relationship_tags,
    format,
    sponsor_id,
    active,
    created_at
  )
  VALUES (
    '92000000-0000-4000-8000-000000000001',
    'Smoothie on the loser',
    'Loser buys the winner a post-walk smoothie.',
    'Food',
    ARRAY['friend', 'partner'],
    'in_person',
    null,
    true,
    now() - interval '18 days'
  )
  ON CONFLICT (id) DO UPDATE
  SET
    name = excluded.name,
    description = excluded.description,
    category = excluded.category,
    relationship_tags = excluded.relationship_tags,
    format = excluded.format,
    active = true;

  INSERT INTO challenge_instances (
    id,
    challenge_id,
    week_of,
    user_a_id,
    user_b_id,
    stake_id,
    stake_status,
    proposed_by_id,
    proposed_stake_id,
    status,
    winner_user_id,
    user_a_total_steps,
    user_b_total_steps,
    resolved_at,
    created_at,
    updated_at
  )
  VALUES
    (
      '93000000-0000-4000-8000-000000000001',
      '90000000-0000-4000-8000-000000000001',
      week_start,
      demo_user_id,
      alex_id,
      '92000000-0000-4000-8000-000000000001',
      'agreed',
      demo_user_id,
      '92000000-0000-4000-8000-000000000001',
      'active',
      null,
      42450,
      38620,
      null,
      now() - interval '5 days',
      now()
    ),
    (
      '93000000-0000-4000-8000-000000000002',
      '90000000-0000-4000-8000-000000000001',
      week_start - 7,
      demo_user_id,
      maya_id,
      '92000000-0000-4000-8000-000000000001',
      'agreed',
      maya_id,
      '92000000-0000-4000-8000-000000000001',
      'completed',
      demo_user_id,
      68120,
      64200,
      now() - interval '6 days',
      now() - interval '12 days',
      now()
    )
  ON CONFLICT (user_a_id, user_b_id, week_of) DO UPDATE
  SET
    challenge_id = excluded.challenge_id,
    stake_id = excluded.stake_id,
    stake_status = excluded.stake_status,
    proposed_by_id = excluded.proposed_by_id,
    proposed_stake_id = excluded.proposed_stake_id,
    status = excluded.status,
    winner_user_id = excluded.winner_user_id,
    user_a_total_steps = excluded.user_a_total_steps,
    user_b_total_steps = excluded.user_b_total_steps,
    resolved_at = excluded.resolved_at,
    updated_at = now();

  INSERT INTO races (
    id,
    creator_id,
    name,
    target_steps,
    -- TR-906: races are time-based; target_steps stays a DISPLAY goal only.
    -- Without this column these fixtures defaulted to time_based=false and
    -- behaved like target-mode races (which no longer complete on target).
    time_based,
    status,
    max_duration_days,
    buy_in_amount,
    payout_preset,
    pot_coins,
    started_at,
    ends_at,
    completed_at,
    winner_user_id,
    powerups_enabled,
    powerup_step_interval,
    is_public,
    max_participants,
    created_at,
    updated_at
  )
  VALUES
    (
      '10000000-0000-4000-8000-000000000001',
      demo_user_id,
      'Demo Powerup Sprint',
      25000,
      true,
      'active',
      7,
      100,
      'top3_70_20_10',
      0,
      today + time '08:30',
      today + time '08:30' + interval '7 days',
      null,
      null,
      true,
      2000,
      false,
      6,
      now() - interval '2 days',
      now()
    ),
    (
      '10000000-0000-4000-8000-000000000002',
      jordan_id,
      'Demo Public Gold Rush',
      30000,
      true,
      'pending',
      5,
      150,
      'winner_takes_all',
      0,
      null,
      null,
      null,
      null,
      true,
      3000,
      true,
      8,
      now() - interval '1 day',
      now()
    ),
    (
      '10000000-0000-4000-8000-000000000003',
      maya_id,
      'Demo Weekend Invite',
      18000,
      true,
      'pending',
      4,
      0,
      'winner_takes_all',
      0,
      null,
      null,
      null,
      null,
      true,
      2500,
      false,
      4,
      now() - interval '8 hours',
      now()
    ),
    (
      '10000000-0000-4000-8000-000000000004',
      alex_id,
      'Demo Finished 10K',
      10000,
      true,
      'completed',
      3,
      50,
      'winner_takes_all',
      150,
      today - 2 + time '08:00',
      today + time '08:00',
      now() - interval '1 day',
      demo_user_id,
      false,
      null,
      false,
      3,
      now() - interval '4 days',
      now()
    )
  ON CONFLICT (id) DO UPDATE
  SET
    creator_id = excluded.creator_id,
    name = excluded.name,
    target_steps = excluded.target_steps,
    time_based = excluded.time_based,
    status = excluded.status,
    max_duration_days = excluded.max_duration_days,
    buy_in_amount = excluded.buy_in_amount,
    payout_preset = excluded.payout_preset,
    pot_coins = excluded.pot_coins,
    started_at = excluded.started_at,
    ends_at = excluded.ends_at,
    completed_at = excluded.completed_at,
    winner_user_id = excluded.winner_user_id,
    powerups_enabled = excluded.powerups_enabled,
    powerup_step_interval = excluded.powerup_step_interval,
    is_public = excluded.is_public,
    max_participants = excluded.max_participants,
    updated_at = now();

  INSERT INTO race_participants (
    id,
    race_id,
    user_id,
    status,
    total_steps,
    baseline_steps,
    next_box_at_steps,
    bonus_steps,
    max_bonus_steps,
    powerup_slots,
    buy_in_amount,
    buy_in_status,
    payout_coins,
    placement,
    finished_at,
    finish_total_steps,
    joined_at,
    last_read_race_chat_at,
    last_chat_push_at,
    chat_muted
  )
  VALUES
    (
      '20000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      demo_user_id,
      'accepted',
      12400,
      0,
      12000,
      1500,
      1500,
      4,
      100,
      'held',
      0,
      null,
      null,
      null,
      today + time '08:30',
      now() - interval '3 minutes',
      null,
      false
    ),
    (
      '20000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001',
      alex_id,
      'accepted',
      9800,
      0,
      12000,
      0,
      0,
      3,
      100,
      'held',
      0,
      null,
      null,
      null,
      today + time '08:30',
      null,
      null,
      false
    ),
    (
      '20000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000001',
      maya_id,
      'accepted',
      13900,
      0,
      16000,
      0,
      0,
      3,
      100,
      'held',
      0,
      null,
      null,
      null,
      today + time '08:30',
      null,
      null,
      false
    ),
    (
      '20000000-0000-4000-8000-000000000011',
      '10000000-0000-4000-8000-000000000002',
      jordan_id,
      'accepted',
      0,
      0,
      3000,
      0,
      0,
      3,
      150,
      'held',
      0,
      null,
      null,
      null,
      now() - interval '1 day',
      null,
      null,
      false
    ),
    (
      '20000000-0000-4000-8000-000000000012',
      '10000000-0000-4000-8000-000000000002',
      alex_id,
      'accepted',
      0,
      0,
      3000,
      0,
      0,
      3,
      150,
      'held',
      0,
      null,
      null,
      null,
      now() - interval '18 hours',
      null,
      null,
      false
    ),
    (
      '20000000-0000-4000-8000-000000000021',
      '10000000-0000-4000-8000-000000000003',
      maya_id,
      'accepted',
      0,
      0,
      2500,
      0,
      0,
      3,
      0,
      'none',
      0,
      null,
      null,
      null,
      now() - interval '8 hours',
      null,
      null,
      false
    ),
    (
      '20000000-0000-4000-8000-000000000022',
      '10000000-0000-4000-8000-000000000003',
      demo_user_id,
      'invited',
      0,
      0,
      2500,
      0,
      0,
      3,
      0,
      'none',
      0,
      null,
      null,
      null,
      now() - interval '8 hours',
      null,
      null,
      false
    ),
    (
      '20000000-0000-4000-8000-000000000031',
      '10000000-0000-4000-8000-000000000004',
      demo_user_id,
      'accepted',
      10550,
      0,
      0,
      0,
      0,
      3,
      50,
      'committed',
      150,
      1,
      now() - interval '1 day 3 hours',
      10550,
      today - 2 + time '08:00',
      now() - interval '1 day',
      null,
      false
    ),
    (
      '20000000-0000-4000-8000-000000000032',
      '10000000-0000-4000-8000-000000000004',
      alex_id,
      'accepted',
      9200,
      0,
      0,
      0,
      0,
      3,
      50,
      'committed',
      0,
      2,
      null,
      null,
      today - 2 + time '08:00',
      null,
      null,
      false
    ),
    (
      '20000000-0000-4000-8000-000000000033',
      '10000000-0000-4000-8000-000000000004',
      maya_id,
      'accepted',
      8800,
      0,
      0,
      0,
      0,
      3,
      50,
      'committed',
      0,
      3,
      null,
      null,
      today - 2 + time '08:00',
      null,
      null,
      false
    )
  ON CONFLICT (race_id, user_id) DO UPDATE
  SET
    status = excluded.status,
    total_steps = excluded.total_steps,
    baseline_steps = excluded.baseline_steps,
    next_box_at_steps = excluded.next_box_at_steps,
    bonus_steps = excluded.bonus_steps,
    max_bonus_steps = excluded.max_bonus_steps,
    powerup_slots = excluded.powerup_slots,
    buy_in_amount = excluded.buy_in_amount,
    buy_in_status = excluded.buy_in_status,
    payout_coins = excluded.payout_coins,
    placement = excluded.placement,
    finished_at = excluded.finished_at,
    finish_total_steps = excluded.finish_total_steps,
    joined_at = excluded.joined_at,
    last_read_race_chat_at = excluded.last_read_race_chat_at,
    chat_muted = excluded.chat_muted;

  INSERT INTO race_powerups (
    id,
    race_id,
    participant_id,
    user_id,
    type,
    rarity,
    status,
    earned_at_steps,
    used_at,
    target_user_id,
    upgrade_level,
    created_at,
    updated_at
  )
  VALUES
    (
      '30000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      demo_user_id,
      null,
      null,
      'mystery_box',
      2000,
      null,
      null,
      0,
      now() - interval '2 hours',
      now()
    ),
    (
      '30000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      demo_user_id,
      'second_wind',
      'uncommon',
      'held',
      4000,
      null,
      null,
      0,
      now() - interval '90 minutes',
      now()
    ),
    (
      '30000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      demo_user_id,
      'protein_shake',
      'common',
      'held',
      6000,
      null,
      null,
      2,
      now() - interval '70 minutes',
      now()
    ),
    (
      '30000000-0000-4000-8000-000000000004',
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      demo_user_id,
      'runners_high',
      'uncommon',
      'used',
      8000,
      now() - interval '35 minutes',
      null,
      1,
      now() - interval '35 minutes',
      now()
    ),
    (
      '30000000-0000-4000-8000-000000000005',
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      demo_user_id,
      null,
      null,
      'queued',
      10000,
      null,
      null,
      0,
      now() - interval '20 minutes',
      now()
    ),
    (
      '30000000-0000-4000-8000-000000000006',
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      alex_id,
      'red_card',
      'rare',
      'held',
      4000,
      null,
      null,
      0,
      now() - interval '80 minutes',
      now()
    )
  ON CONFLICT (id) DO UPDATE
  SET
    type = excluded.type,
    rarity = excluded.rarity,
    status = excluded.status,
    earned_at_steps = excluded.earned_at_steps,
    used_at = excluded.used_at,
    target_user_id = excluded.target_user_id,
    upgrade_level = excluded.upgrade_level,
    updated_at = now();

  INSERT INTO race_active_effects (
    id,
    race_id,
    target_participant_id,
    target_user_id,
    source_user_id,
    powerup_id,
    type,
    status,
    starts_at,
    expires_at,
    metadata,
    created_at,
    updated_at
  )
  VALUES (
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    demo_user_id,
    demo_user_id,
    '30000000-0000-4000-8000-000000000004',
    'runners_high',
    'active_effect',
    now() - interval '35 minutes',
    now() + interval '2 hours',
    jsonb_build_object('stepsAtBuffStart', 6900, 'demo', true),
    now() - interval '35 minutes',
    now()
  )
  ON CONFLICT (id) DO UPDATE
  SET
    status = excluded.status,
    starts_at = excluded.starts_at,
    expires_at = excluded.expires_at,
    metadata = excluded.metadata,
    updated_at = now();

  INSERT INTO race_powerup_events (
    id,
    race_id,
    actor_user_id,
    event_type,
    powerup_type,
    target_user_id,
    description,
    metadata,
    created_at
  )
  VALUES
    (
      '60000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      demo_user_id,
      'POWERUP_USED',
      'runners_high',
      demo_user_id,
      'Sugaroro2 activated Lvl 1 Runner''s High.',
      '{"demo": true}'::jsonb,
      now() - interval '34 minutes'
    ),
    (
      '60000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001',
      alex_id,
      'MYSTERY_BOX_EARNED',
      'mystery_box',
      null,
      'Alex Summit earned a mystery box.',
      '{"demo": true}'::jsonb,
      now() - interval '25 minutes'
    )
  ON CONFLICT (id) DO UPDATE
  SET
    description = excluded.description,
    metadata = excluded.metadata,
    created_at = excluded.created_at;

  INSERT INTO race_messages (
    id,
    race_id,
    sender_id,
    kind,
    body,
    created_at,
    deleted_at
  )
  VALUES
    (
      '50000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      maya_id,
      'user',
      'I just passed 13k. Catch me if you can.',
      now() - interval '12 minutes',
      null
    ),
    (
      '50000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001',
      demo_user_id,
      'user',
      'Runner''s High is live. I am closing the gap.',
      now() - interval '9 minutes',
      null
    ),
    (
      '50000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000001',
      alex_id,
      'user',
      'Saving a Red Card for the final stretch.',
      now() - interval '6 minutes',
      null
    ),
    (
      '50000000-0000-4000-8000-000000000004',
      '10000000-0000-4000-8000-000000000001',
      null,
      'system',
      'Demo race chat is ready for App Review.',
      now() - interval '4 minutes',
      null
    )
  ON CONFLICT (id) DO UPDATE
  SET
    body = excluded.body,
    created_at = excluded.created_at,
    deleted_at = null;

  INSERT INTO coin_transactions (
    id,
    user_id,
    amount,
    reason,
    ref_id,
    created_at
  )
  VALUES (
    '94000000-0000-4000-8000-000000000001',
    demo_user_id,
    4540,
    'app_review_demo_top_up',
    'app-review-demo-sugaroro2',
    now()
  )
  ON CONFLICT (id) DO UPDATE
  SET
    amount = excluded.amount,
    created_at = excluded.created_at;

  INSERT INTO user_shop_items (id, user_id, shop_item_id, purchased_at)
  SELECT
    '95000000-0000-4000-8000-000000000001',
    demo_user_id,
    shop_items.id,
    now() - interval '1 day'
  FROM shop_items
  WHERE sku = 'sunglasses'
  ON CONFLICT (user_id, shop_item_id) DO NOTHING;

  INSERT INTO user_shop_items (id, user_id, shop_item_id, purchased_at)
  SELECT
    '95000000-0000-4000-8000-000000000002',
    demo_user_id,
    shop_items.id,
    now() - interval '1 day'
  FROM shop_items
  WHERE sku = 'shoes'
  ON CONFLICT (user_id, shop_item_id) DO NOTHING;

  INSERT INTO user_equipped_accessories (
    id,
    user_id,
    slot,
    shop_item_id,
    updated_at
  )
  SELECT
    '96000000-0000-4000-8000-000000000001',
    demo_user_id,
    'FACE',
    shop_items.id,
    now()
  FROM shop_items
  WHERE sku = 'sunglasses'
  ON CONFLICT (user_id, slot) DO UPDATE
  SET shop_item_id = excluded.shop_item_id, updated_at = now();

  INSERT INTO user_equipped_accessories (
    id,
    user_id,
    slot,
    shop_item_id,
    updated_at
  )
  SELECT
    '96000000-0000-4000-8000-000000000002',
    demo_user_id,
    'FEET',
    shop_items.id,
    now()
  FROM shop_items
  WHERE sku = 'shoes'
  ON CONFLICT (user_id, slot) DO UPDATE
  SET shop_item_id = excluded.shop_item_id, updated_at = now();
END $$;

COMMIT;

SELECT 'demo_user|' || id || '|' || coalesce(display_name, '<no display name>') || '|coins=' || coins
FROM users
WHERE apple_id = 'review-account-v1';

SELECT 'demo_races|' || status || '|' || count(*)
FROM races
WHERE id IN (
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004'
)
GROUP BY status
ORDER BY status;

SELECT 'demo_powerups|' || count(*)
FROM race_powerups
WHERE race_id = '10000000-0000-4000-8000-000000000001';

SELECT 'demo_challenges|' || count(*)
FROM challenge_instances
WHERE id IN (
  '93000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000002'
);
