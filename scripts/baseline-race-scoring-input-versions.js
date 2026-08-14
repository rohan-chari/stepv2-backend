require("dotenv").config();

const BATCH_SIZE = 500;

function databaseName(databaseUrl) {
  try {
    return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  } catch {
    return "";
  }
}

function assertBaselineAuthorized({ databaseUrl, env = process.env }) {
  if (env.RACE_SCORING_INPUT_BASELINE_DISABLED !== "false") {
    throw new Error("scoring-input baseline is disabled");
  }
  const name = databaseName(databaseUrl);
  if (!name) throw new Error("scoring-input baseline database URL is invalid");
  if (!name.endsWith("_test") && env.RACE_SCORING_INPUT_BASELINE_CONFIRM_DATABASE !== name) {
    throw new Error("scoring-input baseline requires exact database confirmation");
  }
  return name;
}

async function runBaseline({ prisma, logger = console, batchSize = BATCH_SIZE }) {
  let cursor = "";
  let inserted = 0;
  for (;;) {
    const sources = await prisma.$queryRawUnsafe(
      `SELECT user_id AS "userId"
       FROM (
         SELECT user_id FROM steps WHERE user_id > $1
         UNION
         SELECT user_id FROM step_samples WHERE user_id > $1
       ) source
       ORDER BY user_id ASC
       LIMIT $2`,
      cursor,
      batchSize
    );
    if (sources.length === 0) break;
    const ids = sources.map((row) => row.userId);
    inserted += await prisma.$executeRawUnsafe(
      `INSERT INTO user_scoring_input_versions (user_id, generation, updated_at)
       SELECT user_id, 1, CURRENT_TIMESTAMP
       FROM unnest($1::text[]) AS input(user_id)
       ON CONFLICT (user_id) DO NOTHING`,
      ids
    );
    cursor = ids.at(-1);
    logger.log(JSON.stringify({ event: "race_scoring_input_baseline_batch", rows: ids.length }));
  }

  const [proof] = await prisma.$queryRawUnsafe(
    `WITH source_users AS (
       SELECT user_id FROM steps
       UNION
       SELECT user_id FROM step_samples
     ), missing AS (
       SELECT source.user_id
       FROM source_users source
       LEFT JOIN user_scoring_input_versions version ON version.user_id = source.user_id
       WHERE version.user_id IS NULL
     ), active_missing AS (
       SELECT DISTINCT participant.user_id
       FROM race_participants participant
       JOIN races race ON race.id = participant.race_id
       JOIN source_users source ON source.user_id = participant.user_id
       LEFT JOIN user_scoring_input_versions version ON version.user_id = participant.user_id
       WHERE race.status = 'active'
         AND participant.status = 'accepted'
         AND version.user_id IS NULL
     )
     SELECT
       (SELECT COUNT(*)::int FROM missing) AS "missingSourceUsers",
       (SELECT COUNT(*)::int FROM active_missing) AS "missingActiveSourceUsers"`
  );
  if (proof.missingSourceUsers !== 0 || proof.missingActiveSourceUsers !== 0) {
    throw new Error("scoring-input baseline proof failed");
  }
  return { inserted, ...proof };
}

async function main() {
  const url = process.env.DATABASE_URL || "";
  const name = assertBaselineAuthorized({ databaseUrl: url });
  const { prisma } = require("../src/db");
  try {
    const result = await runBaseline({ prisma });
    console.log(JSON.stringify({ event: "race_scoring_input_baseline_complete", database: name, ...result }));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { BATCH_SIZE, databaseName, assertBaselineAuthorized, runBaseline };
