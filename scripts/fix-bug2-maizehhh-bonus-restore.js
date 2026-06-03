#!/usr/bin/env node
/**
 * One-off prod remediation for Bug 2 ("sent backwards").
 *
 * Step-steal powerups (Red Card / Shortcut / Pinecone / Trail Mine) subtract
 * from bonusSteps with no floor, so a heavily-targeted player's bonusSteps can
 * go deeply negative — and since total = walking + bonus, that negative value
 * erases genuinely-walked steps from their leaderboard position.
 *
 * This restores the affected player's POSITION by flooring negative bonusSteps
 * at 0 (penalties consume the bonus buffer but never real walked steps) and
 * adjusting total_steps to match (total -> total - bonus, i.e. + |bonus|).
 *
 * It does NOT touch the box-progress gap (that is the permanent code fix:
 * max_box_progress_steps), and it does NOT change maxBonusSteps (so the
 * box-progress anchor is unaffected — see racePowerupStateSync).
 *
 * Scope: a single user, ACTIVE races only, rows with bonus_steps < 0.
 * Completed races (frozen leaderboards / settled payouts) are never touched.
 *
 * Usage:
 *   node scripts/fix-bug2-maizehhh-bonus-restore.js            # DRY RUN (no writes)
 *   node scripts/fix-bug2-maizehhh-bonus-restore.js --apply    # apply the UPDATE
 *
 * Reversibility: in --apply mode it prints a ready-to-run rollback SQL block
 * with the exact prior values before committing.
 */

const { Client } = require("pg");
require("dotenv").config();

// Maizehhh (display_name "Maizehhh"). Keyed by id to avoid name ambiguity.
const TARGET_USER_ID = "420b657e-9786-4dde-9217-2988a28bc185";

const APPLY = process.argv.includes("--apply");

async function main() {
  const connectionString = process.env.PROD_DATABASE_URL;
  if (!connectionString) {
    console.error("Missing PROD_DATABASE_URL in .env");
    process.exit(1);
  }

  // Strip sslmode from the URL: newer pg treats sslmode=require as verify-full,
  // which rejects DigitalOcean's self-signed CA chain. The explicit ssl object
  // below governs instead (matches how psql connected with sslmode=require).
  const url = new URL(connectionString);
  url.searchParams.delete("sslmode");

  const client = new Client({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
    statement_timeout: 20000,
  });
  await client.connect();

  try {
    // Confirm the target user.
    const userRes = await client.query(
      "SELECT id, display_name FROM users WHERE id = $1",
      [TARGET_USER_ID]
    );
    if (userRes.rows.length === 0) {
      console.error(`User ${TARGET_USER_ID} not found. Aborting.`);
      process.exit(1);
    }
    console.log(
      `Target user: ${userRes.rows[0].display_name} (${userRes.rows[0].id})`
    );
    console.log(`Mode: ${APPLY ? "APPLY (writes enabled)" : "DRY RUN (no writes)"}\n`);

    // Affected rows: ACTIVE races, negative bonus.
    const rows = (
      await client.query(
        `SELECT rp.id AS participant_id, r.name, r.status,
                rp.total_steps, rp.bonus_steps, rp.max_bonus_steps, rp.next_box_at_steps
           FROM race_participants rp
           JOIN races r ON r.id = rp.race_id
          WHERE rp.user_id = $1
            AND r.status = 'active'
            AND rp.bonus_steps < 0
          ORDER BY r.name`,
        [TARGET_USER_ID]
      )
    ).rows;

    if (rows.length === 0) {
      console.log("No active races with negative bonus_steps. Nothing to do.");
      return;
    }

    console.log("Planned changes (floor negative bonus -> 0, restore position):\n");
    for (const row of rows) {
      const newTotal = row.total_steps - row.bonus_steps; // bonus is negative -> adds |bonus|
      console.log(`  Race: ${row.name}  (participant ${row.participant_id})`);
      console.log(
        `    total_steps : ${row.total_steps}  ->  ${newTotal}   (+${-row.bonus_steps})`
      );
      console.log(`    bonus_steps : ${row.bonus_steps}  ->  0`);
      console.log(
        `    max_bonus_steps ${row.max_bonus_steps} and next_box_at_steps ${row.next_box_at_steps} : UNCHANGED\n`
      );
    }

    if (!APPLY) {
      console.log("DRY RUN — no changes written. Re-run with --apply to commit.");
      return;
    }

    // Reversibility: print rollback SQL with the exact prior values.
    console.log("Rollback SQL (run to undo this remediation):");
    console.log("BEGIN;");
    for (const row of rows) {
      console.log(
        `  UPDATE race_participants SET total_steps = ${row.total_steps}, bonus_steps = ${row.bonus_steps} WHERE id = '${row.participant_id}';`
      );
    }
    console.log("COMMIT;\n");

    await client.query("BEGIN");
    let applied = 0;
    for (const row of rows) {
      // Re-guard on bonus_steps < 0 so a concurrent change can't be clobbered.
      const res = await client.query(
        `UPDATE race_participants
            SET total_steps = total_steps - bonus_steps,
                bonus_steps = 0
          WHERE id = $1 AND bonus_steps < 0`,
        [row.participant_id]
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
