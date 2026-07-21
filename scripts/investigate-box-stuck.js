// READ-ONLY investigation of one participant's box countdown vs raw steps.
//   node scripts/investigate-box-stuck.js "<displayName>" "<raceName>"
const fs = require("fs");
const prodUrl = fs
  .readFileSync(__dirname + "/../.env", "utf8")
  .match(/^PROD_DATABASE_URL=(.+)$/m)[1]
  .trim()
  .replace(/^"|"$/g, "");
process.env.DATABASE_URL = prodUrl;

const { prisma } = require("../src/db");
const { Steps } = require("../src/modules/steps/models/steps");
const { StepSample } = require("../src/modules/steps/models/stepSample");
const { calculateBaseAdjusted } = require("../src/modules/races/services/raceStateResolution");
const { computeBoxEffectiveSteps } = require("../src/modules/powerups/boxSteps");

const NAME = process.argv[2] || "shreyt29";
const RACE = process.argv[3] || "RACE ME";

(async () => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT rp.id, rp.user_id AS "userId", rp.joined_at AS "joinedAt", rp.total_steps AS "totalSteps",
            rp.bonus_steps AS "bonusSteps", rp.max_bonus_steps AS "maxBonusSteps",
            rp.next_box_at_steps AS "nextBox", r.id AS "raceId", r.name AS "raceName",
            r.started_at AS "startedAt", r.powerup_step_interval AS intvl, r.powerups_enabled AS "puEnabled"
       FROM race_participants rp JOIN races r ON r.id=rp.race_id JOIN users u ON u.id=rp.user_id
      WHERE u.display_name=$1 AND r.status='active'
      ORDER BY (r.name=$2) DESC, r.started_at DESC`,
    NAME, RACE
  );
  if (!rows.length) { console.log(`participant '${NAME}' not found in any active race`); await prisma.$disconnect(); return; }

  console.log(`=== ${NAME} — active races (target race '${RACE}' first) ===\n`);
  for (const p of rows) {
    const intvl = Number(p.intvl), nb = Number(p.nextBox);
    console.log(`RACE "${p.raceName}" (started ${new Date(p.startedAt).toISOString()})  next_box=${nb}  intvl=${intvl}  powerups=${p.puEnabled}`);
    console.log(`  leaderboard total_steps ${p.totalSteps}; bonus ${p.bonusSteps} / maxBonus ${p.maxBonusSteps}`);
    for (const tz of ["UTC", "America/New_York", "America/Chicago", "America/Los_Angeles"]) {
      const { baseAdjusted } = await calculateBaseAdjusted({
        participant: { userId: p.userId, joinedAt: p.joinedAt },
        raceStartedAt: p.startedAt, timeZone: tz,
        stepsModel: Steps, stepSampleModel: StepSample, now: new Date(),
      });
      const boxEff = computeBoxEffectiveSteps({ baseAdjusted, bonusSteps: Number(p.bonusSteps) || 0, maxBonusSteps: Number(p.maxBonusSteps) || 0 });
      const countdown = Math.max(0, Math.min(nb - boxEff, intvl));
      console.log(`    tz=${tz.padEnd(20)} baseAdjusted=${baseAdjusted}  boxEff=${boxEff}  gap=${nb - boxEff}  DISPLAYED=${countdown}${countdown === intvl ? "  <-- FLAT" : ""}`);
    }
    console.log("");
  }

  const target = rows.find((r) => r.raceName === RACE) || rows[0];
  const fx = await prisma.$queryRawUnsafe(
    `SELECT type, status, starts_at, expires_at FROM race_active_effects
      WHERE target_participant_id=$1 ORDER BY starts_at DESC LIMIT 12`, target.id);
  console.log(`effects on '${NAME}' in "${target.raceName}" (newest first):`);
  fx.forEach((f) => console.log(`    ${f.type} [${f.status}] ${new Date(f.starts_at).toISOString().slice(5,16)} -> ${f.expires_at ? new Date(f.expires_at).toISOString().slice(5,16) : "—"}`));

  const daily = await prisma.$queryRawUnsafe(
    `SELECT date, steps FROM steps WHERE user_id=$1 ORDER BY date DESC LIMIT 6`, target.userId);
  console.log(`\n  recent daily 'steps' rows:`);
  daily.forEach((d) => console.log(`    ${d.date} : ${d.steps}`));

  await prisma.$disconnect();
})().catch(async (e) => { console.error("FAILED:", e.message); try { await prisma.$disconnect(); } catch {} process.exit(1); });
