-- Ranked tier-threshold calibration (READ-ONLY; creates a TEMP table only).
--
-- Computes per-user Ranked Points (RP) over the most recent 30-day window using
-- the agreed formula, then reports the RP distribution and buckets eligible users
-- under candidate thresholds. See RANKED.md.
--
-- Run against STAGING (synced from prod), never prod directly:
--   STAGING_URL=$(node -e "require('dotenv').config({quiet:true});process.stdout.write(process.env.STAGING_DATABASE_URL||'')")
--   psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f scripts/ranked-calibration.sql
--
-- RP/day = milestone_pts (5k:+20, 10k:+30, 15k:+30, 20k:+20; cap 100)
--        + floor(steps/1000)
--        + streak_bonus (+5 per consecutive >=5k day, cap 50)
-- Eligible = at least one day >= 5,000 steps in the window. Review accounts excluded.

CREATE TEMP TABLE _calib AS
WITH bounds AS (
  SELECT (MAX(date) - INTERVAL '29 days')::date AS start_date FROM steps
),
days AS (
  SELECT s.user_id, s.date, s.steps
  FROM steps s JOIN users u ON u.id = s.user_id, bounds b
  WHERE u.is_review_account = false AND s.date >= b.start_date
),
flagged AS (
  SELECT user_id, date, steps, (steps >= 5000) AS active,
    (CASE WHEN steps>=5000 THEN 20 ELSE 0 END)+(CASE WHEN steps>=10000 THEN 30 ELSE 0 END)
   +(CASE WHEN steps>=15000 THEN 30 ELSE 0 END)+(CASE WHEN steps>=20000 THEN 20 ELSE 0 END) AS milestone_pts,
    FLOOR(steps/1000.0)::int AS volume_pts
  FROM days
),
islands AS (
  SELECT user_id, date, (date - (ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY date))::int) AS island
  FROM flagged WHERE active
),
streaks AS (
  SELECT user_id, date, ROW_NUMBER() OVER (PARTITION BY user_id, island ORDER BY date) AS streak_pos FROM islands
),
daily_rp AS (
  -- streak bonus only on active days; guard the NULL streak_pos explicitly
  -- (LEAST(50, NULL) returns 50 in Postgres, which would over-credit rest days).
  SELECT f.user_id, f.active,
    f.milestone_pts + f.volume_pts
    + (CASE WHEN s.streak_pos IS NOT NULL THEN LEAST(50, 5 * (s.streak_pos - 1)) ELSE 0 END) AS rp
  FROM flagged f LEFT JOIN streaks s USING (user_id, date)
)
SELECT user_id,
  SUM(rp)::int AS season_rp,
  SUM(CASE WHEN active THEN 1 ELSE 0 END)::int AS active_days,
  COUNT(*)::int AS days_with_steps,
  BOOL_OR(active) AS eligible
FROM daily_rp GROUP BY user_id;

\echo '--- WINDOW + COUNTS ---'
SELECT (SELECT (MAX(date) - INTERVAL '29 days')::date FROM steps) AS window_start,
       (SELECT MAX(date) FROM steps) AS window_end,
       count(*) AS users_with_steps_in_window,
       count(*) FILTER (WHERE eligible) AS eligible_users,
       count(*) FILTER (WHERE NOT eligible) AS unranked_below_5k
FROM _calib;

\echo '--- SEASON RP DISTRIBUTION (eligible users) ---'
SELECT count(*) AS eligible_users, min(season_rp) AS min_rp,
  round(percentile_cont(0.10) WITHIN GROUP (ORDER BY season_rp)) AS p10,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY season_rp)) AS p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY season_rp)) AS p50_median,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY season_rp)) AS p75,
  round(percentile_cont(0.90) WITHIN GROUP (ORDER BY season_rp)) AS p90,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY season_rp)) AS p95,
  round(percentile_cont(0.99) WITHIN GROUP (ORDER BY season_rp)) AS p99,
  max(season_rp) AS max_rp, round(avg(season_rp)) AS avg_rp
FROM _calib WHERE eligible;

\echo '--- TIER DISTRIBUTION (calibrated thresholds: Silver>=200, Gold>=550, Diamond>=1400) ---'
SELECT
  CASE WHEN season_rp >= 1400 THEN '4 Diamond'
       WHEN season_rp >=  550 THEN '3 Gold'
       WHEN season_rp >=  200 THEN '2 Silver'
       ELSE '1 Bronze' END AS tier,
  count(*) AS users,
  round(100.0*count(*)/sum(count(*)) OVER (), 1) AS pct,
  min(season_rp) AS lo_rp, max(season_rp) AS hi_rp
FROM _calib WHERE eligible GROUP BY 1 ORDER BY 1;
