// READ-ONLY investigation of one participant's box countdown vs raw steps.
const fs = require("fs");
const prodUrl = fs
  .readFileSync(__dirname + "/../.env", "utf8")
  .match(/^PROD_DATABASE_URL=(.+)$/m)[1]
  .trim()
  .replace(/^"|"$/g, "");
process.env.DATABASE_URL = prodUrl;

const { prisma } = require("../src/db");
const { Steps } = require("../src/models/steps");
const { StepSample } = require("../src/models/stepSample");
const { calculateBaseAdjusted } = require("../src/services/raceStateResolution");
const { computeBoxEffectiveSteps } = require("../src/utils/boxSteps");

const NAME = "Sugaroro";
const RACE = "RACE ME";

(async () => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT rp.id, rp.user_id AS "userId", rp.joined_at AS "joinedAt", rp.total_steps AS "totalSteps",
            rp.bonus_steps AS "bonusSteps", rp.max_bonus_steps AS "maxBonusSteps",
            rp.next_box_at_steps AS "nextBox", r.started_at AS "startedAt", r.powerup_step_interval AS intvl
       FROM race_participants rp JOIN races r ON r.id=rp.race_id JOIN users u ON u.id=rp.user_id
      WHERE u.display_name=$1 AND r.name=$2 AND r.status='active'`,
    NAME, RACE
  );
  if (!rows.length) { console.log("participant not found"); await prisma.$disconnect(); return; }
  const p = rows[0];
  const intvl = Number(p.intvl), nb = Number(p.nextBox);

  console.log(`Sugaroro / RACE ME (race started ${new Date(p.startedAt).toISOString()})  next_box=${nb}`);
  console.log(`  leaderboard total_steps ${p.totalSteps}; bonus ${p.bonusSteps} / maxBonus ${p.maxBonusSteps}\n`);
  for (const tz of ["UTC", "America/New_York", "America/Chicago", "America/Los_Angeles"]) {
    const { baseAdjusted } = await calculateBaseAdjusted({
      participant: { userId: p.userId, joinedAt: p.joinedAt },
      raceStartedAt: p.startedAt, timeZone: tz,
      stepsModel: Steps, stepSampleModel: StepSample, now: new Date(),
    });
    const boxEff = computeBoxEffectiveSteps({ baseAdjusted, bonusSteps: Number(p.bonusSteps) || 0, maxBonusSteps: Number(p.maxBonusSteps) || 0 });
    const countdown = Math.max(0, Math.min(nb - boxEff, intvl));
    console.log(`  tz=${tz.padEnd(20)} baseAdjusted=${baseAdjusted}  boxEff=${boxEff}  gap=${nb - boxEff}  DISPLAYED=${countdown}${countdown === intvl ? "  <-- FLAT 2000" : ""}`);
  }
  console.log("");

  // recent raw samples (did raw steps actually rise lately?)
  const samples = await prisma.$queryRawUnsafe(
    `SELECT period_start AS s, period_end AS e, steps, recording_method AS m
       FROM step_samples WHERE user_id=$1 ORDER BY period_end DESC LIMIT 12`, p.userId);
  console.log(`\n  last 12 step_samples (newest first):`);
  samples.forEach((s) => console.log(`    ${new Date(s.s).toISOString().slice(5,16)}->${new Date(s.e).toISOString().slice(11,16)}  ${s.steps} steps  [${s.m}]`));

  // recent daily totals
  const daily = await prisma.$queryRawUnsafe(
    `SELECT date, steps FROM steps WHERE user_id=$1 ORDER BY date DESC LIMIT 6`, p.userId);
  console.log(`\n  recent daily 'steps' rows:`);
  daily.forEach((d) => console.log(`    ${d.date} : ${d.steps}`));

  // effects (buffs/debuffs) that explain total != raw
  const fx = await prisma.$queryRawUnsafe(
    `SELECT type, status, starts_at, expires_at FROM race_active_effects
      WHERE target_participant_id=$1 ORDER BY starts_at DESC LIMIT 12`, p.id);
  console.log(`\n  effects on this participant (newest first):`);
  fx.forEach((f) => console.log(`    ${f.type} [${f.status}] ${new Date(f.starts_at).toISOString().slice(5,16)} -> ${f.expires_at ? new Date(f.expires_at).toISOString().slice(5,16) : "—"}`));

  await prisma.$disconnect();
})().catch(async (e) => { console.error("FAILED:", e.message); try { await prisma.$disconnect(); } catch {} process.exit(1); });
