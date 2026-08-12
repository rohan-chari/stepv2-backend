// READ-ONLY: raw steps per participant, split by team, for "runners hi".
const fs = require("fs");
const prodUrl = fs.readFileSync(__dirname + "/../.env", "utf8")
  .match(/^PROD_DATABASE_URL=(.+)$/m)[1].trim().replace(/^"|"$/g, "");
process.env.DATABASE_URL = prodUrl;

const { prisma } = require("../src/db");

const RACE_ID = "bdec7e3f-ddc0-4d70-8d34-4637293705e7";

(async () => {
  const race = await prisma.$queryRawUnsafe(
    `SELECT id, name, is_team_race AS "isTeamRace" FROM races WHERE id = $1`,
    RACE_ID
  );
  console.log("RACE:", race);

  const rows = await prisma.$queryRawUnsafe(
    `SELECT u.display_name AS "displayName", rp.team, rp.raw_steps AS "rawSteps",
            rp.total_steps AS "totalSteps", rp.bonus_steps AS "bonusSteps"
       FROM race_participants rp JOIN users u ON u.id = rp.user_id
      WHERE rp.race_id = $1
      ORDER BY rp.team NULLS LAST, rp.raw_steps DESC NULLS LAST`,
    RACE_ID
  );
  console.log("PARTICIPANTS:");
  for (const r of rows) {
    console.log(`  [${r.team || "NO_TEAM"}] ${r.displayName}: raw=${r.rawSteps} total=${r.totalSteps} bonus=${r.bonusSteps}`);
  }

  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
