#!/usr/bin/env node
/**
 * One-off prod remediation: restore box-progress high-water (max_box_progress_steps)
 * for participants whose anchor was seeded BELOW their true earned peak.
 *
 * Context: the box-progress anchor (Bug 2 fix) prevents FUTURE backslide, but it
 * was seeded from each participant's CURRENT (possibly already debuffed) effective
 * steps when 1.1.7 deployed. Participants who had been dragged down by Leg Cramp
 * (freeze) / Wrong Turn (reverse) before the deploy keep a residual gap and must
 * re-walk ground they already covered.
 *
 * Fix: set max_box_progress_steps = the participant's HIGHEST actually-earned box
 * threshold (MAX(race_powerups.earned_at_steps)) when that exceeds the current
 * anchor. This is a value their effective steps demonstrably reached (a box was
 * earned there), so it can NEVER grant an unearned box — it only removes the
 * debuff-induced re-walk. GREATEST guard means box progress only ever increases.
 *
 * Scope: ACTIVE, powerups-enabled races only.
 *   default            -> Maizehhh only (the reported user)
 *   --all              -> every affected participant
 *
 * Usage:
 *   node scripts/fix-bug2-box-anchor-restore.js                 # DRY RUN (Maizehhh)
 *   node scripts/fix-bug2-box-anchor-restore.js --apply         # apply (Maizehhh)
 *   node scripts/fix-bug2-box-anchor-restore.js --all           # DRY RUN (everyone)
 *   node scripts/fix-bug2-box-anchor-restore.js --all --apply   # apply (everyone)
 */

const { Client } = require("pg");
require("dotenv").config();

const MAIZEHHH_USER_ID = "420b657e-9786-4dde-9217-2988a28bc185";
const APPLY = process.argv.includes("--apply");
const ALL = process.argv.includes("--all");

async function main() {
  const connectionString = process.env.PROD_DATABASE_URL;
  if (!connectionString) {
    console.error("Missing PROD_DATABASE_URL in .env");
    process.exit(1);
  }
  const url = new URL(connectionString);
  url.searchParams.delete("sslmode"); // explicit ssl object governs (DO self-signed CA)

  const client = new Client({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
    statement_timeout: 30000,
  });
  await client.connect();

  try {
    console.log(`Scope: ${ALL ? "ALL affected participants" : "Maizehhh only"}`);
    console.log(`Mode:  ${APPLY ? "APPLY (writes enabled)" : "DRY RUN (no writes)"}\n`);

    const params = [];
    let userFilter = "";
    if (!ALL) {
      params.push(MAIZEHHH_USER_ID);
      userFilter = "AND rp.user_id = $1";
    }

    // Affected = active powerup-race participants whose box anchor sits below the
    // last threshold they DEMONSTRABLY crossed = (next_box_at_steps - interval).
    // next_box_at_steps only advances by crossing a threshold (earned OR forfeited
    // when inventory was full), and is only ever reduced by Trail Magnet, so
    // (next_box - interval) is a safe lower bound on their true peak effective
    // steps — and strictly below next_box, so it can NEVER trigger an unearned box.
    // Excludes box-inactive rows (next_box_at_steps = 0, or no interval).
    const rows = (
      await client.query(
        `SELECT rp.id AS participant_id, u.display_name, r.name AS race_name,
                rp.next_box_at_steps,
                r.powerup_step_interval AS interval,
                COALESCE(rp.max_box_progress_steps, 0) AS cur_anchor,
                (rp.next_box_at_steps - r.powerup_step_interval) AS earned_peak
           FROM race_participants rp
           JOIN races r ON r.id = rp.race_id
           JOIN users u ON u.id = rp.user_id
          WHERE r.status = 'active'
            AND r.powerups_enabled
            AND r.powerup_step_interval > 0
            AND rp.next_box_at_steps > 0
            AND COALESCE(rp.max_box_progress_steps, 0) < (rp.next_box_at_steps - r.powerup_step_interval)
            ${userFilter}
          ORDER BY u.display_name, r.name`,
        params
      )
    ).rows;

    if (rows.length === 0) {
      console.log("No participants with an under-seeded box anchor. Nothing to do.");
      return;
    }

    console.log(`Restoring box anchor to true earned peak (${rows.length} row(s)):\n`);
    for (const row of rows) {
      console.log(`  ${row.display_name} — ${row.race_name} (participant ${row.participant_id})`);
      console.log(
        `    max_box_progress_steps: ${row.cur_anchor} -> ${row.earned_peak}   (next box at ${row.next_box_at_steps}; steps-to-next ${row.next_box_at_steps - row.earned_peak})\n`
      );
    }

    if (!APPLY) {
      console.log("DRY RUN — no changes written. Re-run with --apply to commit.");
      return;
    }

    console.log("Rollback SQL (undo):");
    console.log("BEGIN;");
    for (const row of rows) {
      const prev = row.cur_anchor === 0 ? "NULL" : row.cur_anchor;
      console.log(
        `  UPDATE race_participants SET max_box_progress_steps = ${prev} WHERE id = '${row.participant_id}';`
      );
    }
    console.log("COMMIT;\n");

    await client.query("BEGIN");
    let applied = 0;
    for (const row of rows) {
      const res = await client.query(
        `UPDATE race_participants
            SET max_box_progress_steps = GREATEST(COALESCE(max_box_progress_steps, 0), $2)
          WHERE id = $1 AND COALESCE(max_box_progress_steps, 0) < $2`,
        [row.participant_id, row.earned_peak]
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
