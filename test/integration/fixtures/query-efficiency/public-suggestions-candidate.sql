WITH eligible AS MATERIALIZED (
 SELECT r.*
      FROM races r
      LEFT JOIN users creator ON creator.id = r.creator_id
      WHERE r.is_public = TRUE
        AND r.status IN ('pending'::"RaceStatus", 'active'::"RaceStatus")
        AND r.tournament_id IS NULL
        AND (r.creator_id IS NULL OR creator.is_review_account = FALSE)
        AND NOT (r.status = 'pending'::"RaceStatus" AND r.seed_id IS NOT NULL)
        AND r.seed_id IS NULL
        AND (r.is_team_race = FALSE OR r.status = 'pending'::"RaceStatus")
        AND NOT EXISTS (
          SELECT 1
          FROM race_participants mine
          WHERE mine.race_id = r.id AND mine.user_id = $1
        )
), counts AS MATERIALIZED (
 SELECT rp.race_id, COUNT(*) AS accepted_count
 FROM race_participants rp JOIN eligible e ON e.id=rp.race_id
 WHERE rp.status='accepted'::"RaceParticipantStatus"
 GROUP BY rp.race_id
), candidates AS MATERIALIZED (
 SELECT r.*, COALESCE(parts.accepted_count,0) AS accepted_count
 FROM eligible r LEFT JOIN counts parts ON parts.race_id=r.id
 WHERE r.max_participants IS NULL OR COALESCE(parts.accepted_count,0)<r.max_participants
      ORDER BY r.created_at DESC, r.id ASC
      LIMIT $2
    )

      SELECT
        r.id,
        r.name,
        r.status::text AS status,
        r.max_duration_days AS "maxDurationDays",
        r.ends_at AS "endsAt",
        r.scheduled_start_at AS "scheduledStartAt",
        r.scheduled_end_at AS "scheduledEndAt",
        r.started_at AS "startedAt",
        r.target_steps AS "targetSteps",
        r.buy_in_amount AS "buyInAmount",
        r.payout_preset::text AS "payoutPreset",
        r.pot_coins AS "potCoins",
        r.funded_prize AS "fundedPrize",
        r.payout_rounding_version AS "payoutRoundingVersion",
        r.prize_pool_coins AS "prizePoolCoins",
        r.prize_coin_unit AS "prizeCoinUnit",
        r.prize_pool_max_coins AS "prizePoolMaxCoins",
        r.prize_calculation_version AS "prizeCalculationVersion",
        r.payout_curve AS "payoutCurve",
        r.powerups_enabled AS "powerupsEnabled",
        r.powerup_step_interval AS "powerupStepInterval",
        r.exit_actions_enabled AS "exitActionsEnabled",
        r.max_participants AS "maxParticipants",
        r.is_team_race AS "isTeamRace",
        r.team_size AS "teamSize",
        r.team_a_name AS "teamAName",
        r.team_b_name AS "teamBName",
        r.team_pool_mult_bps AS "teamPoolMultBps",
        r.team_payout_version AS "teamPayoutVersion",
        r.team_winner_reward_coins AS "teamWinnerRewardCoins",
        r.seed_id AS "seedId",
        r.creation_source AS "creationSource",
        r.start_policy AS "startPolicy",
        r.created_at AS "createdAt",
        r.accepted_count::int AS "acceptedCount",
        COALESCE(parts.rows, '[]'::jsonb) AS participants
 FROM candidates r
      LEFT JOIN LATERAL (
        SELECT
          JSONB_AGG(
            JSONB_BUILD_OBJECT(
              'userId', rp.user_id,
              'status', UPPER(rp.status::text),
              'buyInStatus', UPPER(rp.buy_in_status::text),
              'buyInAmount', rp.buy_in_amount,
              'team', CASE WHEN rp.team IS NULL THEN NULL ELSE UPPER(rp.team::text) END,
              'totalSteps', rp.total_steps,
              'forfeitedAt', rp.forfeited_at,
              'totalsUpdatedAt', rp.totals_updated_at
            )
            ORDER BY rp.joined_at ASC
          ) AS rows
        FROM race_participants rp
        WHERE rp.race_id = r.id
      ) parts ON TRUE
 ORDER BY r.created_at DESC, r.id ASC