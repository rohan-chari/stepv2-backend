// READ-ONLY: for given (displayName, raceName) pairs, compare the OLD clamp
// (debuff-sensitive effective) vs the NEW clamp (Leg Cramp + Wrong Turn immune)
// so we can see whether the box-immunity deploy un-sticks "steps to next box".
const fs = require("fs");
const { Client } = require("pg");
const url = fs
  .readFileSync(__dirname + "/../.env", "utf8")
  .match(/^PROD_DATABASE_URL=(.+)$/m)[1]
  .trim()
  .replace(/^"|"$/g, "")
  .replace(/[?&]sslmode=[^&]*/g, "");

const TARGETS = [
  { name: "Nathan", race: "RACE-ally motivated" },
  { name: "shreyt29", race: "RACE ME" },
  { name: "Nathan", race: "RACE ME" },
];

// prorated overlap sum, mirrors StepSample.sumStepsInWindow
function sumWindow(samples, startMs, endMs) {
  let total = 0;
  for (const s of samples) {
    const ss = new Date(s.period_start).getTime();
    const se = new Date(s.period_end).getTime();
    const dur = se - ss;
    if (dur <= 0) continue;
    const os = Math.max(ss, startMs);
    const oe = Math.min(se, endMs);
    const od = oe - os;
    if (od <= 0) continue;
    total += od >= dur ? s.steps : Math.round(s.steps * (od / dur));
  }
  return total;
}

(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 30000 });
  await c.connect();
  for (const t of TARGETS) {
    const { rows: prows } = await c.query(
      `SELECT rp.id, rp.user_id, r.powerup_step_interval AS intvl,
              (rp.total_steps + GREATEST(0, rp.max_bonus_steps - rp.bonus_steps))::bigint AS eff,
              rp.next_box_at_steps AS next_box
         FROM race_participants rp JOIN races r ON r.id=rp.race_id JOIN users u ON u.id=rp.user_id
        WHERE u.display_name=$1 AND r.name=$2 AND r.status='active'`,
      [t.name, t.race]
    );
    if (!prows.length) { console.log(`\n${t.name} / ${t.race}: not found`); continue; }
    const p = prows[0];
    const { rows: effects } = await c.query(
      `SELECT type, starts_at, expires_at FROM race_active_effects
        WHERE target_participant_id=$1 AND type IN ('leg_cramp','wrong_turn')`,
      [p.id]
    );
    const { rows: samples } = await c.query(
      `SELECT period_start, period_end, steps FROM step_samples WHERE user_id=$1`,
      [p.user_id]
    );
    let legCramp = 0, reversed = 0;
    for (const e of effects) {
      const s = new Date(e.starts_at).getTime();
      const en = (e.expires_at ? new Date(e.expires_at) : new Date()).getTime();
      const w = sumWindow(samples, s, en);
      if (e.type === "leg_cramp") legCramp += w;
      else reversed += w;
    }
    const eff = Number(p.eff);
    const boxImmune = eff + legCramp + 2 * reversed;
    const intvl = Number(p.intvl);
    const nb = Number(p.next_box);
    const oldClamp = Math.max(0, Math.min(nb - eff, intvl));
    const newClamp = Math.max(0, Math.min(nb - boxImmune, intvl));
    console.log(`\n${t.name} / ${t.race}  [intvl ${intvl}]`);
    console.log(`  next_box=${nb}`);
    console.log(`  debuff-sensitive effective=${eff}  -> OLD countdown shows ${oldClamp}${oldClamp === intvl ? "  (STUCK at interval)" : ""}`);
    console.log(`  legCrampFrozen=${legCramp}  wrongTurnReversed=${reversed}  (effects: ${effects.length})`);
    console.log(`  box-immune effective=${boxImmune}  -> NEW countdown shows ${newClamp}${newClamp === intvl ? "  (still stuck -> next_box truly inflated; deflation needed)" : "  (UN-STUCK by the deploy)"}`);
  }
  await c.end();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
