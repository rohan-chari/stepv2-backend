// One-time backfill: give in-flight USER-created races a canonical timezone.
//
// Why: the live placement-recompute cron scores user races (race.timezone NULL)
// in UTC, while the race screen scores them in the viewer's device tz. The two
// disagree at day boundaries, producing false "you slipped to 2nd" pushes while
// the screen still shows 1st. New races now persist the creator's tz at
// creation; this fixes races that were already created (and possibly running)
// before that change shipped.
//
// Scope: only NULL-timezone, non-seeded (seedId NULL) races that are still
// in-flight (PENDING or ACTIVE). Seeded races already carry a canonical tz.
// COMPLETED/CANCELLED races are settled and left untouched.
//
// We don't store each creator's historical device tz, so we backfill a single
// default zone (America/New_York — the app's own fallback in
// middleware/extractTimezone, and where most of the userbase already scored on
// the display path). Override with --tz=<IANA> if needed.
//
// Idempotent and safe to re-run: only touches rows whose timezone is still NULL.
// Dry-run by default — pass --apply to write.
//
//   node scripts/backfill-user-race-timezone.js            # preview
//   node scripts/backfill-user-race-timezone.js --apply    # write
//   node scripts/backfill-user-race-timezone.js --apply --tz=America/Chicago
require("dotenv").config();
const { prisma } = require("../src/db");

function parseArgs(argv) {
  const apply = argv.includes("--apply");
  const tzArg = argv.find((a) => a.startsWith("--tz="));
  const tz = tzArg ? tzArg.slice("--tz=".length) : "America/New_York";
  return { apply, tz };
}

function assertValidTimeZone(tz) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    console.error(`Invalid IANA timezone: "${tz}"`);
    process.exit(1);
  }
}

async function backfill() {
  const { apply, tz } = parseArgs(process.argv.slice(2));
  assertValidTimeZone(tz);

  const targets = await prisma.race.findMany({
    where: {
      timezone: null,
      seedId: null,
      status: { in: ["PENDING", "ACTIVE"] },
    },
    select: { id: true, name: true, status: true, startedAt: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(
    `${apply ? "[apply]" : "[dry-run]"} ${targets.length} in-flight user race(s) ` +
      `with NULL timezone -> "${tz}"`
  );
  for (const race of targets) {
    console.log(`  ${race.status.padEnd(7)} ${race.id}  ${race.name}`);
  }

  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to write.");
    return;
  }
  if (targets.length === 0) {
    console.log("\nNothing to backfill.");
    return;
  }

  const result = await prisma.race.updateMany({
    where: {
      timezone: null,
      seedId: null,
      status: { in: ["PENDING", "ACTIVE"] },
    },
    data: { timezone: tz },
  });
  console.log(`\nDone. ${result.count} race(s) updated.`);
}

backfill()
  .catch((error) => {
    console.error("Backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
