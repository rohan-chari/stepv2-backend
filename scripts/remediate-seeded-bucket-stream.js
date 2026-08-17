#!/usr/bin/env node
/**
 * One-off prod remediation for the seeded-bucket election ordering bug.
 *
 * Context (fixed in seededRaceRenewal.js step 3c): commit a5a3ddb moved the
 * legacy auto-enroll pass ahead of the durable mode stamp + bucket election.
 * On the single renewal tick that CREATES a window's upcoming race there is no
 * mode row yet, and readWindowMode's mixed-deploy default is LEGACY — so
 * enrollAutoJoinUsers skipped its capability exclusion and claimLegacyStream
 * wrote a write-once LEGACY ledger row for EVERY bucket-capable auto-join
 * account. electAutomatic then found them all taken and elected nobody.
 *
 * The code fix only helps windows created after it deploys. The ledger is
 * write-once, so every window already stamped before the fix stays wrong until
 * someone flips it. That is what this script does.
 *
 * Fix: for each capable auto-join user, call the SAME reconcileFeaturedUser()
 * the /races/featured endpoint calls. It runs under the window advisory lock
 * and applies the identical guards (window mode is BUCKET, boundary not
 * reached, no buckets finalized yet, membership is LEGACY, a legacy PENDING
 * participant row exists). No SQL approximation of that policy is used here.
 *
 * Scope: UPCOMING windows only. A window whose race has already started cannot
 * be re-bucketed — see the "today's race" note in the incident writeup.
 *
 * Idempotent: a second run finds every eligible member already on BUCKET and
 * moves nobody.
 *
 * Usage:
 *   node scripts/remediate-seeded-bucket-stream.js            # DRY RUN (reports only)
 *   node scripts/remediate-seeded-bucket-stream.js --apply    # perform the moves
 */

require("dotenv").config();

const APPLY = process.argv.includes("--apply");

const { prisma } = require("../src/db");
const {
  buildSeededRaceBuckets,
  upcomingWindowFor,
  BUCKET_FEATURE,
} = require("../src/modules/races/services/seededRaceBuckets");

const seededBuckets = buildSeededRaceBuckets({ prisma });

async function main() {
  const dbName = (process.env.DATABASE_URL || "").split("/").pop()?.split("?")[0];
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} against database "${dbName}"\n`);

  const seeds = await prisma.raceSeed.findMany({
    where: { active: true, kind: { in: ["DAILY_10K", "WEEKLY_50K"] } },
    orderBy: { kind: "asc" },
  });

  // Report the pre-state per upcoming window so the operator can sanity-check
  // the blast radius before applying.
  const windows = [];
  for (const seed of seeds) {
    const { windowStart, windowEnd } = upcomingWindowFor(seed, new Date());
    const mode = await prisma.seededRaceWindowModeRecord.findUnique({
      where: { seedId_windowStart: { seedId: seed.id, windowStart } },
      select: { mode: true },
    });
    const [legacy, bucket, finalized] = await Promise.all([
      prisma.seededRaceWindowMembership.count({
        where: { seedId: seed.id, windowStart, stream: "LEGACY" },
      }),
      prisma.seededRaceWindowMembership.count({
        where: { seedId: seed.id, windowStart, stream: "BUCKET" },
      }),
      prisma.seededRaceBucket.count({ where: { seedId: seed.id, windowStart } }),
    ]);
    windows.push({ seed, windowStart, windowEnd, mode: mode?.mode || "LEGACY", legacy, bucket, finalized });
    console.log(
      `${seed.kind.padEnd(11)} window ${windowStart.toISOString()} ` +
        `mode=${mode?.mode || "LEGACY"} legacy=${legacy} bucket=${bucket} finalizedBuckets=${finalized} ` +
        `startsIn=${Math.round((windowStart.getTime() - Date.now()) / 60000)}min`
    );
  }

  const blocked = windows.filter((row) => row.mode === "BUCKET" && row.finalized > 0);
  for (const row of blocked) {
    console.log(
      `\n! ${row.seed.kind}: ${row.finalized} bucket(s) already finalized for this window — ` +
        `reconcile is a no-op there by design (the plan is immutable once drawn).`
    );
  }

  const users = await prisma.user.findMany({
    where: { autoJoinFeaturedRaces: true, clientFeatures: { has: BUCKET_FEATURE } },
    select: { id: true, displayName: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\n${users.length} capable auto-join account(s) to evaluate.`);

  if (!APPLY) {
    // Count exactly who WOULD move, using the same predicate reconcileFeatured
    // uses: a LEGACY ledger row plus a live participant row in that window's
    // legacy PENDING race.
    let wouldMove = 0;
    for (const row of windows) {
      if (row.mode !== "BUCKET" || row.finalized > 0) continue;
      const count = await prisma.seededRaceWindowMembership.count({
        where: {
          seedId: row.seed.id,
          windowStart: row.windowStart,
          stream: "LEGACY",
          userId: { in: users.map((u) => u.id) },
        },
      });
      console.log(`  ${row.seed.kind}: ${count} capable account(s) stranded on LEGACY`);
      wouldMove += count;
    }
    console.log(`\nDRY RUN — would move up to ${wouldMove} membership(s). Re-run with --apply.`);
    return;
  }

  let moved = 0;
  let failed = 0;
  for (const user of users) {
    try {
      const count = await seededBuckets.reconcileFeaturedUser({
        userId: user.id,
        capable: true,
        autoJoinFeaturedRaces: true,
      });
      moved += count;
      if (count > 0) console.log(`  moved ${count} window(s) for ${user.displayName || user.id}`);
    } catch (error) {
      // Fail-open per user: one bad row must not strand the rest of the cohort.
      failed += 1;
      console.error(`  FAILED ${user.displayName || user.id}: ${error.message}`);
    }
  }
  console.log(`\nMoved ${moved} membership(s) to the BUCKET stream. ${failed} user(s) errored.`);

  for (const row of windows) {
    const [legacy, bucket] = await Promise.all([
      prisma.seededRaceWindowMembership.count({
        where: { seedId: row.seed.id, windowStart: row.windowStart, stream: "LEGACY" },
      }),
      prisma.seededRaceWindowMembership.count({
        where: { seedId: row.seed.id, windowStart: row.windowStart, stream: "BUCKET" },
      }),
    ]);
    console.log(`  post ${row.seed.kind}: legacy=${legacy} bucket=${bucket}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
