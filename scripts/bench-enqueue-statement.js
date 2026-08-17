// Micro-benchmark for the race-resolution enqueue upsert.
//
// This statement is the hottest one in the backend (81-89% of database busy time
// under load; see docs/resolution-enqueue-cost-requirements.md), so proposals to
// make it cheaper need a measurement rather than an estimate. Reasoning about
// jsonb cost has already produced one wrong answer: change 3.2 "compute the
// guard once instead of three times" was expected to cut the guard's cost ~3x
// and measured 9% SLOWER.
//
// Method: capture the exact SQL enqueueMany issues, then run it LOOPS times
// inside a single server-side plpgsql loop. That removes the round trip, Prisma
// marshalling, and per-call EXPLAIN overhead — all of which are larger than the
// effect being measured. (Per-call `EXPLAIN ANALYZE` was tried first and its
// variance exceeded the signal; it reported a 41% win where the loop shows a 9%
// loss. Do not trust it for changes this small.)
//
// Usage — against the INTEGRATION database, never prod or staging:
//
//   DATABASE_URL=postgresql://…/steps-tracker-integration \
//     node scripts/bench-enqueue-statement.js
//
// Env:
//   PARTICIPANTS  size of the stored dirty scope (default 900). This is the
//                 knob that matters: the guard scales with it, and a busy race
//                 is where the cost lives.
//   LOOPS         executions per trial (default 400)
//   TRIALS        trials, median reported (default 5)
//   VARIANT       full (default) | nocaps | noguard
//                 nocaps  neutralises only the DISTINCT cap counts — the delta
//                         is the ceiling for change 3.3.
//                 noguard neutralises the whole validation guard — the delta is
//                         the guard's total share of the statement.
//
// To compare a proposed rewrite: run it, `git stash` or check out the original,
// run again, compare medians. Only trust deltas well outside trial spread.
const { prisma } = require("../src/db");
const {
  RaceResolutionJobV2,
} = require("../src/modules/races/models/raceResolutionJobV2");

const LOOPS = Number(process.env.LOOPS || 400);
const TRIALS = Number(process.env.TRIALS || 5);
const PARTICIPANTS = Number(process.env.PARTICIPANTS || 900);
const VARIANT = process.env.VARIANT || "full";

function assertNotProduction() {
  const url = process.env.DATABASE_URL || "";
  if (!/integration|_test|localhost|127\.0\.0\.1/.test(url)) {
    throw new Error(
      "refusing to run: DATABASE_URL does not look like a local/test database"
    );
  }
}

// Neutralise only the two DISTINCT cap counts, keeping the base conditions.
function stripCapChecks(sql) {
  const re = /\(SELECT COUNT\(\*\) FROM \(\s*SELECT DISTINCT value[\s\S]*?\) \w+_scope\) > \d+/g;
  const hits = sql.match(re);
  if (!hits) throw new Error("VARIANT=nocaps: cap checks not found");
  console.error(`nocaps: neutralised ${hits.length} cap check(s)`);
  return sql.replace(re, "false");
}

// Neutralise every guard condition, keeping the three scope merges. Handles both
// the shipped shape (one CASE per column) and a hoisted shape (one shared
// sub-SELECT), so it survives a rewrite of the statement.
function stripGuard(sql) {
  const hoisted = sql.indexOf("-- Each flag is base OR");
  if (hoisted >= 0) {
    const open = sql.lastIndexOf("FROM (", hoisted);
    const close = sql.indexOf(") g", hoisted);
    if (open < 0 || close < 0) throw new Error("VARIANT=noguard: bounds not found");
    return (
      sql.slice(0, open) +
      "FROM (SELECT false AS participant_over, false AS powerup_over) g" +
      sql.slice(close + ") g".length)
    );
  }
  // Shipped shape: every guard is the WHEN of a CASE whose THEN is a constant.
  const stripped = stripCapChecks(sql).replace(
    /WHEN jsonb_typeof\(race_resolution_jobs_v2\.dirty_reasons\)[\s\S]*?THEN/g,
    "WHEN false THEN"
  );
  if (stripped === sql) throw new Error("VARIANT=noguard: guard not found");
  return stripped;
}

async function main() {
  assertNotProduction();

  const race = await prisma.race.create({
    data: {
      creatorId: null,
      name: `bench-enqueue-${PARTICIPANTS}`,
      targetSteps: 0,
      isPublic: true,
      timeBased: true,
      timezone: "America/New_York",
      maxParticipants: 500,
      maxDurationDays: 1,
      status: "PENDING",
    },
    select: { id: true },
  });
  await RaceResolutionJobV2.enqueueMany({ raceIds: [race.id], now: new Date() });

  const stored = Array.from({ length: PARTICIPANTS }, (_, i) => `p-${i}`);
  const seed = () =>
    prisma.$queryRawUnsafe(
      `UPDATE race_resolution_jobs_v2
          SET dirty_reasons = '["STEP_SYNC"]'::jsonb,
              dirty_participant_ids = $2::jsonb,
              dirty_powerup_types = '["LEECH"]'::jsonb
        WHERE race_id = $1`,
      race.id,
      JSON.stringify(stored)
    );
  await seed();

  // Capture the real statement rather than duplicating it here, so the benchmark
  // can never drift from what the model actually issues.
  let captured = null;
  await RaceResolutionJobV2.enqueueMany(
    {
      raceIds: [race.id],
      now: new Date(),
      dirtyEnvelopeByRaceId: new Map([
        [
          race.id,
          {
            reason: "STEP_SYNC",
            priority: "IMMEDIATE",
            dirtyUserIds: [],
            dirtyParticipantIds: ["p-1"],
            powerupTypes: ["LEECH"],
          },
        ],
      ]),
    },
    {
      $queryRawUnsafe: async (sql, ...params) => {
        captured = { sql, params };
        return prisma.$queryRawUnsafe(sql, ...params);
      },
    }
  );
  if (!captured) throw new Error("did not capture the enqueue statement");

  let sql = captured.sql;
  if (VARIANT === "nocaps") sql = stripCapChecks(sql);
  else if (VARIANT === "noguard") sql = stripGuard(sql);
  else if (VARIANT !== "full") throw new Error(`unknown VARIANT: ${VARIANT}`);

  // A DO block takes no parameters, so inline both binds as dollar-quoted
  // literals. The tags must not collide with the jsonpath `$[*]` inside the SQL.
  const stamp = new Date(captured.params[1])
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");
  const inlined = sql
    .replace(/\$1::jsonb/g, `$payload$${captured.params[0]}$payload$::jsonb`)
    .replace(/\$2::timestamp/g, `$stamp$${stamp}$stamp$::timestamp`);

  const perStatement = [];
  for (let trial = 0; trial < TRIALS; trial += 1) {
    await seed();
    const t0 = process.hrtime.bigint();
    await prisma.$executeRawUnsafe(`
      DO $bench$
      DECLARE i int;
      BEGIN
        FOR i IN 1..${LOOPS} LOOP
          EXECUTE $stmt$${inlined}$stmt$;
        END LOOP;
      END
      $bench$;
    `);
    perStatement.push(Number(process.hrtime.bigint() - t0) / 1e6 / LOOPS);
  }

  perStatement.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      variant: VARIANT,
      participants: PARTICIPANTS,
      loops: LOOPS,
      trials: TRIALS,
      perStatementMedianMs: Number(perStatement[Math.floor(TRIALS / 2)].toFixed(4)),
      perStatementMinMs: Number(perStatement[0].toFixed(4)),
      perStatementMaxMs: Number(perStatement[perStatement.length - 1].toFixed(4)),
    })
  );

  await prisma.race.delete({ where: { id: race.id } });
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
