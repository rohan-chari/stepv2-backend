const { prisma } = require("../src/db");
const {
  RaceEffectDeadline,
} = require("../src/modules/races/models/raceEffectDeadline");
async function main() {
  let afterId = "";
  let scanned = 0;
  for (;;) {
    const page = await RaceEffectDeadline.backfill({ afterId, limit: 100 });
    scanned += page.count;
    afterId = page.afterId;
    if (!page.count) break;
    await new Promise((r) => setImmediate(r));
  }
  const [counts] = await prisma.$queryRawUnsafe(
    `SELECT (SELECT count(*)::int FROM race_effect_deadlines) AS deadlines,(SELECT count(*)::int FROM race_active_effects e WHERE e.status='active_effect' AND e.expires_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM race_effect_deadlines d WHERE d.effect_id=e.id AND d.deadline_at=e.expires_at)) AS missing`,
  );
  console.log(
    JSON.stringify({
      event: "race_effect_deadline_backfill",
      scanned,
      ...counts,
    }),
  );
  if (counts.missing) throw new Error("deadline backfill invariant incomplete");
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
