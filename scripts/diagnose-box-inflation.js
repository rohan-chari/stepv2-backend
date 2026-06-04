#!/usr/bin/env node
/**
 * READ-ONLY diagnostic for inflated next_box_at_steps across ALL active powerup
 * participants (not just the 06-03 anchor window). For each inflated participant
 * it reports whether deflation would be fully safe.
 *
 * effective box steps = total_steps + GREATEST(0, max_bonus_steps - bonus_steps)
 *   (matches getEffectiveBoxSteps: bonusAnchor=max(bonus,maxBonus); protected
 *    term = max(0, maxBonus - bonus)).
 *
 * "inflated" = next_box - effective > interval (countdown exceeds one interval).
 * new_next_box = (floor(effective/interval)+1)*interval  -> always > effective,
 *   so the next roll's condition (effective >= next_box) is FALSE => 0 immediate mint.
 *
 * Band = the crossed thresholds between new_next_box and next_box (exclusive of
 * next_box itself). If every band threshold has a GRANTED box row, deflation can
 * never re-grant (rollPowerup skips existing earned_at_steps). If band rows <
 * expected, some thresholds were forfeited/never-rowed -> walking past them after
 * deflation could RE-EARN them.
 */
const fs = require("fs");
const { Client } = require("pg");
const url = fs
  .readFileSync(__dirname + "/../.env", "utf8")
  .match(/^PROD_DATABASE_URL=(.+)$/m)[1]
  .trim()
  .replace(/^"|"$/g, "")
  .replace(/[?&]sslmode=[^&]*/g, "");

(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 30000 });
  await c.connect();
  const { rows } = await c.query(`
    WITH cand AS (
      SELECT rp.id AS participant_id, u.display_name, r.name AS race,
             r.powerup_step_interval AS intvl,
             (rp.total_steps + GREATEST(0, rp.max_bonus_steps - rp.bonus_steps))::bigint AS effective,
             rp.next_box_at_steps AS next_box
        FROM race_participants rp
        JOIN races r ON r.id = rp.race_id
        JOIN users u ON u.id = rp.user_id
       WHERE r.status='active' AND r.powerups_enabled AND r.powerup_step_interval>0
         AND rp.status='accepted' AND rp.next_box_at_steps>0
    )
    SELECT c.*,
      (c.next_box - c.effective) AS gap,
      (floor(c.effective::numeric / c.intvl) + 1) * c.intvl AS new_next_box,
      ((c.next_box - (floor(c.effective::numeric / c.intvl) + 1) * c.intvl) / c.intvl)::int AS expected_band_thresholds,
      (SELECT count(*) FROM race_powerups pw
         WHERE pw.participant_id = c.participant_id
           AND pw.earned_at_steps IS NOT NULL
           AND pw.earned_at_steps > c.effective
           AND pw.earned_at_steps < c.next_box) AS granted_rows_in_band,
      (SELECT count(*) FROM race_active_effects rae
         WHERE rae.target_participant_id = c.participant_id
           AND rae.type IN ('leg_cramp','wrong_turn')) AS debuff_total,
      (SELECT count(*) FROM race_active_effects rae
         WHERE rae.target_participant_id = c.participant_id
           AND rae.type IN ('leg_cramp','wrong_turn')
           AND rae.status = 'active_effect') AS debuff_active
    FROM cand c
    WHERE (c.next_box - c.effective) > c.intvl
    ORDER BY gap DESC`);

  if (!rows.length) {
    console.log("No participants with next_box inflated beyond one interval. Nothing to remediate.");
    await c.end();
    return;
  }

  console.log(`Inflated participants (gap > 1 interval): ${rows.length}\n`);
  let bug = 0,
    review = 0;
  for (const r of rows) {
    const covered = Number(r.granted_rows_in_band) >= Number(r.expected_band_thresholds);
    const hasDebuff = Number(r.debuff_total) > 0;
    // Classify: a Leg Cramp / Wrong Turn legitimately inflates the gap
    // (debuff-sensitive by design). With no such effect the gap is the
    // anchor/spike bug -> safe to deflate (mints 0 now; future grants are real steps).
    const cls = hasDebuff ? "NEEDS REVIEW (has debuff — gap may be legit)" : "BUG-INFLATED (safe to deflate)";
    if (hasDebuff) review++;
    else bug++;
    console.log(`  ${r.display_name} — ${r.race}  [intvl ${r.intvl}]  => ${cls}`);
    console.log(
      `    effective ${r.effective} | next_box ${r.next_box} -> ${r.new_next_box} | gap ${r.gap} (${(r.gap / r.intvl).toFixed(1)} intervals)`
    );
    console.log(
      `    band: ${r.granted_rows_in_band}/${r.expected_band_thresholds} thresholds rowed (${covered ? "fully covered" : "has forfeited gaps"}) | LegCramp+WrongTurn effects: ${r.debuff_total} total, ${r.debuff_active} active`
    );
  }
  console.log(`\nSummary: ${bug} bug-inflated (no debuff), ${review} need review (debuff present).`);
  console.log("Immediate mint on next sync = ZERO for ALL (new_next_box > effective). Deflating a bug-inflated player restores the honest sub-interval countdown; future boxes are earned on REAL walked steps.");
  await c.end();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
