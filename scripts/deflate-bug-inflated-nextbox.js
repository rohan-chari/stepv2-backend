#!/usr/bin/env node
/**
 * Targeted, debuff-SAFE remediation of bug-inflated next_box_at_steps.
 *
 * Only touches participants whose inflated gap CANNOT be explained by a legit
 * step-reducing effect — i.e. they have ZERO Leg Cramp / Wrong Turn / Campfire
 * Rest effects (the only effects that reduce effective box steps). With no such
 * effect, next_box sitting >1 interval above effective can only be the
 * anchor/step-spike ratchet bug. For these, deflating to the next real threshold
 * above effective:
 *   - mints ZERO boxes now: new_next_box > effective => roll condition
 *     (effective >= next_box) is false on the next sync (asserted per row);
 *   - restores honest earning: as the player walks REAL steps past new_next_box,
 *     un-rowed thresholds grant boxes (rowed ones skip via the P2002 pre-check).
 *
 * Players WITH any reducing effect are intentionally excluded: their gap may be
 * legitimate debuff-sensitivity, and deflating would erase an opponent's debuff
 * (or create phantom countdowns to already-owned boxes). Handle those manually.
 *
 * Usage:
 *   node scripts/deflate-bug-inflated-nextbox.js           # DRY RUN
 *   node scripts/deflate-bug-inflated-nextbox.js --apply    # write + commit
 */
const fs = require("fs");
const { Client } = require("pg");
const APPLY = process.argv.includes("--apply");
const url = fs
  .readFileSync(__dirname + "/../.env", "utf8")
  .match(/^PROD_DATABASE_URL=(.+)$/m)[1]
  .trim()
  .replace(/^"|"$/g, "")
  .replace(/[?&]sslmode=[^&]*/g, "");

(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 30000 });
  await c.connect();
  console.log(`Mode: ${APPLY ? "APPLY (writes enabled)" : "DRY RUN (no writes)"}\n`);
  const { rows } = await c.query(`
    SELECT rp.id AS participant_id, u.display_name, r.name AS race,
           r.powerup_step_interval AS intvl,
           (rp.total_steps + GREATEST(0, rp.max_bonus_steps - rp.bonus_steps))::bigint AS effective,
           rp.next_box_at_steps AS old_next_box,
           ((floor((rp.total_steps + GREATEST(0, rp.max_bonus_steps - rp.bonus_steps))::numeric / r.powerup_step_interval) + 1) * r.powerup_step_interval)::bigint AS new_next_box
      FROM race_participants rp
      JOIN races r ON r.id = rp.race_id
      JOIN users u ON u.id = rp.user_id
     WHERE r.status='active' AND r.powerups_enabled AND r.powerup_step_interval>0
       AND rp.status='accepted' AND rp.next_box_at_steps>0
       AND (rp.next_box_at_steps - (rp.total_steps + GREATEST(0, rp.max_bonus_steps - rp.bonus_steps))) > r.powerup_step_interval
       AND NOT EXISTS (
         SELECT 1 FROM race_active_effects rae
          WHERE rae.target_participant_id = rp.id
            AND rae.type IN ('leg_cramp','wrong_turn','campfire_rest'))
     ORDER BY (rp.next_box_at_steps - (rp.total_steps + GREATEST(0, rp.max_bonus_steps - rp.bonus_steps))) DESC`);

  if (!rows.length) {
    console.log("No debuff-free bug-inflated participants. Nothing to do.");
    await c.end();
    return;
  }

  // Hard safety gates before any write.
  for (const r of rows) {
    const eff = Number(r.effective), nn = Number(r.new_next_box), on = Number(r.old_next_box);
    if (!(nn > eff)) throw new Error(`ABORT ${r.display_name}: new_next_box ${nn} !> effective ${eff} (would mint immediately)`);
    if (!(nn < on)) throw new Error(`ABORT ${r.display_name}: new_next_box ${nn} !< old ${on} (not a deflation)`);
  }

  console.log(`Deflating ${rows.length} debuff-free bug-inflated participant(s):\n`);
  for (const r of rows) {
    console.log(`  ${r.display_name} — ${r.race}  [intvl ${r.intvl}]`);
    console.log(`    effective ${r.effective} | next_box ${r.old_next_box} -> ${r.new_next_box}  (gap ${r.old_next_box - r.effective} -> ${r.new_next_box - r.effective})  | immediate roll: ${Number(r.effective) >= Number(r.new_next_box) ? "WOULD MINT!" : "none (0 boxes)"}`);
  }

  console.log("\nRollback SQL:\nBEGIN;");
  for (const r of rows) console.log(`  UPDATE race_participants SET next_box_at_steps = ${r.old_next_box} WHERE id = '${r.participant_id}';`);
  console.log("COMMIT;");

  if (!APPLY) {
    console.log("\nDRY RUN — no changes written. Re-run with --apply to commit.");
    await c.end();
    return;
  }

  await c.query("BEGIN");
  let applied = 0;
  for (const r of rows) {
    const res = await c.query(
      `UPDATE race_participants SET next_box_at_steps = $2 WHERE id = $1 AND next_box_at_steps = $3`,
      [r.participant_id, r.new_next_box, r.old_next_box]
    );
    applied += res.rowCount;
  }
  await c.query("COMMIT");
  console.log(`\nAPPLIED: ${applied}/${rows.length} participant row(s) updated and committed.`);
  await c.end();
})().catch(async (e) => {
  console.error("FAILED (no commit):", e.message);
  process.exit(1);
});
