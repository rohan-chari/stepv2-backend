// Box-IMMUNE-aware deflation of inflated next_box_at_steps.
//
// Post box-immunity change, the roll gate + countdown use box-immune effective
// steps (Leg Cramp + Wrong Turn added back). A player is "stuck at one interval"
// only when next_box sits MORE than one interval above their box-IMMUNE
// effective. For those, deflate next_box to the next threshold above box-immune
// effective: new = (floor(boxImmune/intvl)+1)*intvl -> always > boxImmune, so the
// gate (which uses boxImmune) mints ZERO immediately. Players whose box-immune
// effective is already within one interval of next_box are FIXED by the deploy
// alone and left untouched.
//
//   node scripts/deflate-stuck-boximmune.js          # DRY RUN
//   node scripts/deflate-stuck-boximmune.js --apply    # write + commit
const fs = require("fs");
const { Client } = require("pg");
const APPLY = process.argv.includes("--apply");
const url = fs.readFileSync(__dirname + "/../.env", "utf8")
  .match(/^PROD_DATABASE_URL=(.+)$/m)[1].trim().replace(/^"|"$/g, "").replace(/[?&]sslmode=[^&]*/g, "");

function sumWindow(samples, startMs, endMs) {
  let total = 0;
  for (const s of samples) {
    const ss = new Date(s.period_start).getTime(), se = new Date(s.period_end).getTime();
    const dur = se - ss; if (dur <= 0) continue;
    const od = Math.min(se, endMs) - Math.max(ss, startMs); if (od <= 0) continue;
    total += od >= dur ? s.steps : Math.round(s.steps * (od / dur));
  }
  return total;
}

(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });
  await c.connect();
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);
  // Candidate set: inflated vs DEBUFF-SENSITIVE effective (superset; box-immune is >=).
  const { rows: cands } = await c.query(`
    SELECT rp.id, rp.user_id, u.display_name, r.name AS race, r.powerup_step_interval AS intvl,
           (rp.total_steps + GREATEST(0, rp.max_bonus_steps - rp.bonus_steps))::bigint AS eff,
           rp.next_box_at_steps AS next_box
      FROM race_participants rp JOIN races r ON r.id=rp.race_id JOIN users u ON u.id=rp.user_id
     WHERE r.status='active' AND r.powerups_enabled AND r.powerup_step_interval>0
       AND rp.status='accepted' AND rp.next_box_at_steps>0
       AND (rp.next_box_at_steps - (rp.total_steps + GREATEST(0, rp.max_bonus_steps - rp.bonus_steps))) > r.powerup_step_interval
     ORDER BY (rp.next_box_at_steps - (rp.total_steps + GREATEST(0, rp.max_bonus_steps - rp.bonus_steps))) DESC`);

  const toFix = [];
  for (const p of cands) {
    const { rows: effects } = await c.query(
      `SELECT type, starts_at, expires_at FROM race_active_effects WHERE target_participant_id=$1 AND type IN ('leg_cramp','wrong_turn')`, [p.id]);
    const { rows: samples } = await c.query(`SELECT period_start, period_end, steps FROM step_samples WHERE user_id=$1`, [p.user_id]);
    let legCramp = 0, reversed = 0;
    for (const e of effects) {
      const w = sumWindow(samples, new Date(e.starts_at).getTime(), (e.expires_at ? new Date(e.expires_at) : new Date()).getTime());
      if (e.type === "leg_cramp") legCramp += w; else reversed += w;
    }
    const intvl = Number(p.intvl), nb = Number(p.next_box), eff = Number(p.eff);
    const boxImmune = eff + legCramp + 2 * reversed;
    const stuck = nb - boxImmune > intvl;
    const newNb = (Math.floor(boxImmune / intvl) + 1) * intvl;
    const tag = stuck ? `STILL STUCK -> deflate ${nb}->${newNb}` : "fixed by deploy (leave)";
    console.log(`${p.display_name} / ${p.race}: next_box=${nb} boxImmune=${boxImmune} (debuffEff=${eff}, +legCramp ${legCramp} +2x reversed ${reversed}) => ${tag}`);
    if (stuck) {
      if (!(newNb > boxImmune)) throw new Error(`ABORT ${p.display_name}: new ${newNb} !> boxImmune ${boxImmune}`);
      if (!(newNb < nb)) { console.log(`  (skip: ${newNb} !< ${nb})`); continue; }
      toFix.push({ id: p.id, name: p.display_name, race: p.race, oldNb: nb, newNb });
    }
  }

  console.log(`\nStill-stuck (need deflation): ${toFix.length}`);
  if (!toFix.length) { await c.end(); return; }
  console.log("Rollback SQL:\nBEGIN;");
  toFix.forEach((f) => console.log(`  UPDATE race_participants SET next_box_at_steps=${f.oldNb} WHERE id='${f.id}';`));
  console.log("COMMIT;");
  if (!APPLY) { console.log("\nDRY RUN — re-run with --apply to commit."); await c.end(); return; }
  await c.query("BEGIN");
  let n = 0;
  for (const f of toFix) {
    const r = await c.query(`UPDATE race_participants SET next_box_at_steps=$2 WHERE id=$1 AND next_box_at_steps=$3`, [f.id, f.newNb, f.oldNb]);
    n += r.rowCount;
  }
  await c.query("COMMIT");
  console.log(`\nAPPLIED: ${n}/${toFix.length} committed.`);
  await c.end();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
