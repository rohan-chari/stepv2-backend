#!/usr/bin/env node
/**
 * One-off prod remediation: re-home players who were enrolled into the WRONG
 * tier's cohort for the current ranked-v2 week.
 *
 * Context (the bug, fixed in computeRankedWeeks.js): the Monday rollover opened
 * & enrolled the new week ~18h BEFORE the prior week settled. Enrollment tiers
 * each player from User.rankedTierV2, so everyone the prior week promoted (or
 * demoted) at settlement was placed into their OLD tier's cohort for the whole
 * new week. They show e.g. "Promoted to Silver!" (banner, from rankedTierV2)
 * yet sit in a BRONZE cohort (the card) — the exact complaint reported.
 *
 * Affected (week 2 at time of writing): 14 users promoted Bronze->Silver at
 * week-1 settlement, all sitting in Bronze cohort ec7040cb. No Silver cohort
 * exists in week 2, so one must be created.
 *
 * Fix: for the current ACTIVE week, find every cohort member whose cohort tier
 * != their settled User.rankedTierV2, then move them into a correct-tier cohort
 * for that same week (reusing an existing same-tier cohort with headroom, or
 * creating one), carrying their accumulated weekly_steps. Provisional ranks for
 * the affected cohorts are recomputed authoritatively by the regular 5-min
 * computeRankedWeeks cron tick (it re-sums each week's steps). Steps are
 * preserved; no coins are touched.
 *
 * Idempotent: a second run finds no mismatches and does nothing.
 *
 * Usage:
 *   node scripts/fix-ranked-v2-stale-tier-cohorts.js              # DRY RUN
 *   node scripts/fix-ranked-v2-stale-tier-cohorts.js --apply      # apply moves
 */

const { Client } = require("pg");
const crypto = require("crypto");
require("dotenv").config();

const {
  COHORT_TARGET_SIZE,
} = require("../src/constants/rankedCohorts");

const APPLY = process.argv.includes("--apply");

// Mirrors chunkIntoCohorts() balancing in src/services/rankedCohorts.js: split
// into the fewest cohorts of <= COHORT_TARGET_SIZE, sizes as even as possible.
function chunkCount(n, target = COHORT_TARGET_SIZE) {
  return Math.max(1, Math.ceil(n / target));
}

async function main() {
  const connectionString = process.env.PROD_DATABASE_URL;
  if (!connectionString) {
    console.error("Missing PROD_DATABASE_URL in .env");
    process.exit(1);
  }
  const url = new URL(connectionString);
  url.searchParams.delete("sslmode"); // explicit ssl object governs (DO self-signed CA)

  const client = new Client({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
    statement_timeout: 30000,
  });
  await client.connect();

  try {
    console.log(`Mode: ${APPLY ? "APPLY (writes enabled)" : "DRY RUN (no writes)"}`);

    // The current ACTIVE week (the one whose cohorts are live right now).
    const { rows: weeks } = await client.query(
      `SELECT id, index FROM ranked_weeks
       WHERE status = 'active' AND starts_on <= now() AND ends_on > now()
       ORDER BY index DESC LIMIT 1`
    );
    if (weeks.length === 0) {
      console.log("No active ranked week right now — nothing to do.");
      return;
    }
    const week = weeks[0];
    console.log(`Active week: index ${week.index} (${week.id})\n`);

    // Members whose cohort tier disagrees with their settled tier.
    const { rows: affected } = await client.query(
      `SELECT m.id AS member_id, m.user_id, u.display_name,
              m.cohort_id AS from_cohort_id, c.tier AS from_tier,
              u.ranked_tier_v2 AS correct_tier, m.weekly_steps
       FROM ranked_cohort_members m
       JOIN ranked_cohorts c ON c.id = m.cohort_id
       JOIN users u ON u.id = m.user_id
       WHERE m.week_id = $1
         AND u.ranked_tier_v2 IS NOT NULL
         AND c.tier <> u.ranked_tier_v2
       ORDER BY u.ranked_tier_v2, m.weekly_steps DESC`,
      [week.id]
    );

    if (affected.length === 0) {
      console.log("No mis-tiered members — nothing to do.");
      return;
    }
    console.log(`${affected.length} mis-tiered member(s):`);
    for (const a of affected) {
      console.log(
        `  ${a.display_name.padEnd(20)} ${a.from_tier} cohort -> should be ${a.correct_tier}  (${a.weekly_steps} steps)`
      );
    }
    console.log("");

    // Group by the tier they SHOULD be in.
    const byTier = new Map();
    for (const a of affected) {
      if (!byTier.has(a.correct_tier)) byTier.set(a.correct_tier, []);
      byTier.get(a.correct_tier).push(a); // already steps-desc within tier
    }

    if (!APPLY) {
      console.log("Plan (per correct tier):");
      for (const [tier, members] of byTier) {
        const { rows: existing } = await client.query(
          `SELECT c.id, COUNT(m.id) AS size
             FROM ranked_cohorts c
             LEFT JOIN ranked_cohort_members m ON m.cohort_id = c.id
            WHERE c.week_id = $1 AND c.tier = $2
            GROUP BY c.id`,
          [week.id, tier]
        );
        const headroom = existing.reduce(
          (acc, c) => acc + Math.max(0, COHORT_TARGET_SIZE - Number(c.size)),
          0
        );
        const needNew = Math.max(0, chunkCount(members.length - headroom));
        console.log(
          `  ${tier}: move ${members.length} member(s). ` +
            `Existing ${tier} cohorts: ${existing.length} (headroom ${headroom}). ` +
            `Would create ~${headroom >= members.length ? 0 : needNew} new cohort(s).`
        );
      }
      console.log("\nDRY RUN — no changes written. Re-run with --apply.");
      return;
    }

    // ── APPLY ────────────────────────────────────────────────────────────────
    await client.query("BEGIN");
    // Same advisory lock the settlement CAS uses, so we never race a rollover.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('ranked-week-roll'))`
    );

    let moved = 0;
    const touchedCohorts = new Set();

    for (const [tier, members] of byTier) {
      // Reuse same-tier cohorts in this week that still have headroom, smallest
      // first; create new ones (<= COHORT_TARGET_SIZE) only as needed.
      const { rows: cohorts } = await client.query(
        `SELECT c.id, COUNT(m.id)::int AS size
           FROM ranked_cohorts c
           LEFT JOIN ranked_cohort_members m ON m.cohort_id = c.id
          WHERE c.week_id = $1 AND c.tier = $2
          GROUP BY c.id
          ORDER BY size ASC`,
        [week.id, tier]
      );
      const slots = cohorts.map((c) => ({
        id: c.id,
        room: COHORT_TARGET_SIZE - c.size,
      }));

      for (const m of members) {
        let slot = slots.find((s) => s.room > 0);
        if (!slot) {
          const id = crypto.randomUUID();
          await client.query(
            `INSERT INTO ranked_cohorts (id, week_id, tier, created_at)
             VALUES ($1, $2, $3, now())`,
            [id, week.id, tier]
          );
          slot = { id, room: COHORT_TARGET_SIZE };
          slots.push(slot);
          console.log(`  created ${tier} cohort ${id}`);
        }
        await client.query(
          `UPDATE ranked_cohort_members
              SET cohort_id = $1, tier = $2, updated_at = now()
            WHERE id = $3`,
          [slot.id, tier, m.member_id]
        );
        touchedCohorts.add(m.from_cohort_id);
        touchedCohorts.add(slot.id);
        slot.room -= 1;
        moved += 1;
        console.log(`  moved ${m.display_name} -> ${tier} cohort ${slot.id}`);
      }
    }

    await client.query("COMMIT");
    console.log(`\nApplied: moved ${moved} member(s).`);
    console.log(
      "Provisional ranks for the affected cohorts (the new ones and the ones " +
        "members left) are recomputed authoritatively by the running " +
        "computeRankedWeeks cron on its next tick (<= 5 min) — it re-sums the " +
        "week's steps, which a one-off SQL re-rank can't replicate safely."
    );
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    console.error("FAILED:", err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
