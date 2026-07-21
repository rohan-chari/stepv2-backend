// One-time realignment of next_box_at_steps to the NEW raw-walked-steps basis.
//
// After the raw-steps deploy, box progress = baseAdjusted (real walked steps) +
// bonus high-water. Players whose next_box was previously ratcheted up by a
// buff/2x-window/spike are stranded above their raw steps. This realigns next_box
// down to the next interval boundary above their raw box-effective.
//
// SAFE: box-effective is computed from REAL walked steps via the app's own
// calculateBaseAdjusted, so new_next_box > box_effective => 0 immediate roll, and
// any later roll is for steps actually walked (never phantom). Asserted per row.
//
// MUST be run AFTER `pm2 restart 3` (raw-steps code live). Running it while the
// box-immune gate is still live could roll buffed steps. DRY by default.
//
//   node scripts/realign-nextbox-rawsteps.js          # DRY RUN (read-only)
//   node scripts/realign-nextbox-rawsteps.js --apply    # write + commit
const fs = require("fs");
const APPLY = process.argv.includes("--apply");

// Point the app's Prisma at PROD before requiring db/models. dotenv won't
// override an already-set env var, so this wins.
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

(async () => {
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}  (DB: ${prodUrl.replace(/:[^:@/]+@/, ":***@").split("?")[0]})\n`);
  const cands = await prisma.$queryRawUnsafe(`
    SELECT rp.id, rp.user_id AS "userId", rp.joined_at AS "joinedAt",
           rp.bonus_steps AS "bonusSteps", rp.max_bonus_steps AS "maxBonusSteps",
           rp.next_box_at_steps AS "nextBox", r.started_at AS "startedAt",
           r.powerup_step_interval AS intvl, u.display_name AS name, r.name AS race
      FROM race_participants rp
      JOIN races r ON r.id = rp.race_id
      JOIN users u ON u.id = rp.user_id
     WHERE r.status='active' AND r.powerups_enabled AND r.powerup_step_interval>0
       AND rp.status='accepted' AND rp.next_box_at_steps>0`);

  const toFix = [];
  for (const c of cands) {
    const intvl = Number(c.intvl), nb = Number(c.nextBox);
    const { baseAdjusted } = await calculateBaseAdjusted({
      participant: { userId: c.userId, joinedAt: c.joinedAt },
      raceStartedAt: c.startedAt,
      timeZone: "UTC",
      stepsModel: Steps,
      stepSampleModel: StepSample,
      now: new Date(),
    });
    const boxEff = computeBoxEffectiveSteps({
      baseAdjusted,
      bonusSteps: Number(c.bonusSteps) || 0,
      maxBonusSteps: Number(c.maxBonusSteps) || 0,
    });
    if (nb - boxEff <= intvl) continue; // within one interval -> fine
    const newNb = (Math.floor(boxEff / intvl) + 1) * intvl;
    if (!(newNb > boxEff)) throw new Error(`ABORT ${c.name}: new ${newNb} !> boxEff ${boxEff}`);
    if (!(newNb < nb)) continue;
    toFix.push({ id: c.id, name: c.name, race: c.race, baseAdjusted, boxEff, nb, newNb, intvl });
  }

  toFix.sort((a, b) => b.nb - b.boxEff - (a.nb - a.boxEff));
  for (const f of toFix) {
    console.log(`${f.name} / ${f.race}: raw=${f.baseAdjusted} boxEff=${f.boxEff} next_box ${f.nb} -> ${f.newNb} (gap ${f.nb - f.boxEff} -> ${f.newNb - f.boxEff})`);
  }
  console.log(`\nStranded on raw basis: ${toFix.length}`);
  if (!toFix.length) { await prisma.$disconnect(); return; }
  console.log("Rollback SQL:\nBEGIN;");
  toFix.forEach((f) => console.log(`  UPDATE race_participants SET next_box_at_steps=${f.nb} WHERE id='${f.id}';`));
  console.log("COMMIT;");

  if (!APPLY) { console.log("\nDRY RUN — re-run with --apply once 572e483 is restarted on prod."); await prisma.$disconnect(); return; }
  let n = 0;
  for (const f of toFix) {
    n += await prisma.$executeRawUnsafe(`UPDATE race_participants SET next_box_at_steps=$1 WHERE id=$2 AND next_box_at_steps=$3`, f.newNb, f.id, f.nb);
  }
  console.log(`\nAPPLIED: ${n}/${toFix.length} committed.`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error("FAILED:", e.message); try { await prisma.$disconnect(); } catch {} process.exit(1); });
