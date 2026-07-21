// One-time cutover for the midnight-aligned seeded-races feature.
//
// Before this feature, seeded daily/weekly races started at arbitrary, drifting
// times (now() + duration). After deploying it, the reconciler (seededRaceRenewal)
// creates midnight-ET-aligned races, but the CURRENTLY-RUNNING rolling race still
// ends at its old weird time. This script truncates each live seeded race to end
// at the next ET boundary (next midnight for daily, next Monday 00:00 for weekly)
// and stamps its canonical timezone, so the reconciler's first PENDING race begins
// exactly when the truncated race ends — no gap, one slightly-short transition
// race, then perfect alignment.
//
// Usage:
//   node scripts/cutover-seeded-races-to-midnight.js            # apply
//   node scripts/cutover-seeded-races-to-midnight.js --dry-run  # preview only
//
// Safe to run once after deploy. Idempotent: only ever SHORTENS endsAt toward the
// next boundary and sets timezone; a no-op once races are already aligned.

const { prisma: defaultPrisma } = require("../src/db");
const {
  nextMidnightNewYork,
  nextWeekStartNewYork,
} = require("../src/shared/time/week");

const SEED_TZ = "America/New_York";

function buildCutover(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());

  return async function cutover({ dryRun = false } = {}) {
    const nowDate = now();
    const seeds = await prisma.raceSeed.findMany({ where: { active: true } });

    const changes = [];
    for (const seed of seeds) {
      const boundary =
        seed.cadence === "WEEKLY"
          ? nextWeekStartNewYork(nowDate, SEED_TZ)
          : nextMidnightNewYork(nowDate, SEED_TZ);

      const live = await prisma.race.findMany({
        where: { seedId: seed.id, status: "ACTIVE" },
      });

      for (const race of live) {
        const update = {};
        const currentEnds = race.endsAt
          ? new Date(race.endsAt).getTime()
          : Infinity;
        // Only ever shorten toward the boundary, never extend a race.
        if (currentEnds > boundary.getTime()) update.endsAt = boundary;
        if (race.timezone !== SEED_TZ) update.timezone = SEED_TZ;

        if (Object.keys(update).length === 0) continue;

        changes.push({
          raceId: race.id,
          seedKind: seed.kind,
          newEndsAt: update.endsAt ? update.endsAt.toISOString() : undefined,
          setTimezone: update.timezone || undefined,
        });
        if (!dryRun) {
          await prisma.race.update({ where: { id: race.id }, data: update });
        }
      }
    }

    return changes;
  };
}

const cutover = buildCutover();

module.exports = { buildCutover, cutover, SEED_TZ };

if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run");
  cutover({ dryRun })
    .then((changes) => {
      if (changes.length === 0) {
        console.log("[cutover] nothing to change — seeded races already aligned");
      } else {
        for (const c of changes) {
          console.log(
            `[cutover]${dryRun ? " (dry-run)" : ""} ${c.seedKind} ${c.raceId} -> ` +
              `endsAt=${c.newEndsAt || "(unchanged)"} timezone=${c.setTimezone || "(unchanged)"}`
          );
        }
      }
      return defaultPrisma.$disconnect();
    })
    .catch(async (err) => {
      console.error("[cutover] failed:", err);
      await defaultPrisma.$disconnect();
      process.exit(1);
    });
}
