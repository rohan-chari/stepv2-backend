#!/usr/bin/env node
/**
 * One-off prod remediation: correct INFLATED next_box_at_steps caused by the
 * (now-reverted) maxBoxProgressSteps box anchor.
 *
 * Root cause: while the anchor was live, the box roll gated on
 * highWater = max(effectiveSteps, maxBoxProgressSteps). For backfilled/peaked
 * participants the anchor sat above their real effective steps, so the roll
 * advanced next_box_at_steps (and earned/forfeited boxes) BEYOND the steps they
 * had actually walked. After reverting to the honest (effective-based) counter,
 * those inflated thresholds surface as a huge "steps to next box" (e.g.
 * Nattybo7: effective 147,088 but next_box 160,000 -> 12,912 to go).
 *
 * Fix: for active powerup-race participants whose LAST crossed threshold
 * (next_box_at_steps - interval) sits ABOVE their current effective box steps,
 * reset next_box_at_steps to the next real threshold above their effective:
 *   next_box = (floor(effective / interval) + 1) * interval
 * This yields a sane countdown (< 1 interval). Already-earned box rows are left
 * intact; re-earning past thresholds is prevented by the (participant_id,
 * earned_at_steps) unique constraint + rollPowerup's P2002 handler. Fresh
 * participants (next_box == interval, effective ~0) are NOT matched.
 *
 * Usage:
 *   node scripts/fix-inflated-next-box.js            # DRY RUN
 *   node scripts/fix-inflated-next-box.js --apply     # apply
 */

const { Client } = require("pg");
require("dotenv").config();

const APPLY = process.argv.includes("--apply");

async function main() {
  const connectionString = process.env.PROD_DATABASE_URL;
  if (!connectionString) {
    console.error("Missing PROD_DATABASE_URL in .env");
    process.exit(1);
  }
  const url = new URL(connectionString);
  url.searchParams.delete("sslmode");
  const client = new Client({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
    statement_timeout: 30000,
  });
  await client.connect();

  try {
    console.log(`Mode: ${APPLY ? "APPLY (writes enabled)" : "DRY RUN (no writes)"}\n`);

    const rows = (
      await client.query(
        `SELECT rp.id AS participant_id, u.display_name, r.name AS race,
                r.powerup_step_interval AS intvl,
                (rp.total_steps + GREATEST(0, rp.max_bonus_steps - rp.bonus_steps)) AS effective,
                rp.next_box_at_steps AS old_next_box,
                ((rp.total_steps + GREATEST(0, rp.max_bonus_steps - rp.bonus_steps)) / r.powerup_step_interval + 1) * r.powerup_step_interval AS new_next_box
           FROM race_participants rp
           JOIN races r ON r.id = rp.race_id
           JOIN users u ON u.id = rp.user_id
          WHERE r.status = 'active' AND r.powerups_enabled
            AND r.powerup_step_interval > 0
            AND rp.next_box_at_steps > 0
            -- CONFIDENT-SPURIOUS only: gap > 2 intervals (4000) AND there is a box
            -- row above current effective that was rolled inside the anchor deploy
            -- window today (>15:00). This excludes normal small dips (gap ~1
            -- interval) and transient step crashes (no box rows above effective).
            AND (rp.next_box_at_steps - (rp.total_steps + GREATEST(0, rp.max_bonus_steps - rp.bonus_steps))) > 4000
            AND EXISTS (
              SELECT 1 FROM race_powerups pw
              WHERE pw.participant_id = rp.id
                AND pw.earned_at_steps IS NOT NULL
                AND pw.earned_at_steps > (rp.total_steps + GREATEST(0, rp.max_bonus_steps - rp.bonus_steps))
                AND pw.created_at > '2026-06-03 15:00'
            )
          ORDER BY (rp.next_box_at_steps - (rp.total_steps + GREATEST(0, rp.max_bonus_steps - rp.bonus_steps))) DESC`
      )
    ).rows;

    if (rows.length === 0) {
      console.log("No participants with an inflated next_box_at_steps. Nothing to do.");
      return;
    }

    console.log(`Correcting inflated next_box_at_steps (${rows.length} row(s)):\n`);
    for (const r of rows) {
      const oldGap = r.old_next_box - r.effective;
      const newGap = r.new_next_box - r.effective;
      console.log(`  ${r.display_name} — ${r.race}`);
      console.log(
        `    effective ${r.effective} | next_box ${r.old_next_box} -> ${r.new_next_box}   (gap ${oldGap} -> ${newGap})`
      );
    }

    if (!APPLY) {
      console.log("\nDRY RUN — no changes written. Re-run with --apply to commit.");
      return;
    }

    console.log("\nRollback SQL:");
    console.log("BEGIN;");
    for (const r of rows) {
      console.log(
        `  UPDATE race_participants SET next_box_at_steps = ${r.old_next_box} WHERE id = '${r.participant_id}';`
      );
    }
    console.log("COMMIT;\n");

    await client.query("BEGIN");
    let applied = 0;
    for (const r of rows) {
      const res = await client.query(
        `UPDATE race_participants SET next_box_at_steps = $2
          WHERE id = $1 AND next_box_at_steps = $3`,
        [r.participant_id, r.new_next_box, r.old_next_box]
      );
      applied += res.rowCount;
    }
    await client.query("COMMIT");
    console.log(`APPLIED: ${applied} participant row(s) updated and committed.`);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("Error (rolled back):", err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
