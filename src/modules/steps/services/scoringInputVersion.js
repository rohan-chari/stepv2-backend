const crypto = require("node:crypto");

async function bumpScoringInputVersion(client, userId) {
  if (!client || !userId) return;
  await client.$executeRaw`
    INSERT INTO "user_scoring_input_versions" ("user_id", "generation", "updated_at")
    VALUES (${userId}, 1, CURRENT_TIMESTAMP)
    ON CONFLICT ("user_id") DO UPDATE SET
      "generation" = "user_scoring_input_versions"."generation" + 1,
      "updated_at" = CURRENT_TIMESTAMP
  `;
}

async function bumpManyScoringInputVersions(client, userIds) {
  const ids = [...new Set(userIds || [])].filter(
    (value) => typeof value === "string" && value.length > 0
  );
  if (!client || ids.length === 0) return;
  await client.$executeRawUnsafe(
    `INSERT INTO user_scoring_input_versions (user_id, generation, updated_at)
     SELECT user_id, 1, CURRENT_TIMESTAMP
     FROM unnest($1::text[]) AS source(user_id)
     ON CONFLICT (user_id) DO UPDATE SET
       generation = user_scoring_input_versions.generation + 1,
       updated_at = CURRENT_TIMESTAMP`,
    ids
  );
}

// Legacy rows predate generation tracking, and a sample reconciliation that
// keeps no incoming rows is intentionally a no-op. The uploader optimization
// therefore materializes the fence row before it captures inputs. INSERT is
// idempotent and does not advance an existing generation.
async function materializeAndReadScoringInputVersion(client, userId) {
  if (!client || !userId) return null;
  await client.$executeRaw`
    INSERT INTO "user_scoring_input_versions" ("user_id", "generation", "updated_at")
    VALUES (${userId}, 1, CURRENT_TIMESTAMP)
    ON CONFLICT ("user_id") DO NOTHING
  `;
  const rows = await client.$queryRaw`
    SELECT "generation"
    FROM "user_scoring_input_versions"
    WHERE "user_id" = ${userId}
  `;
  return rows[0]?.generation ?? null;
}

function stableValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function digestRows(rows) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(stableValue(rows)), "utf8")
    .digest("hex");
}

// Serialize no-op classification per user. The row lock makes daily and sample
// writers compare/update one canonical watermark without write skew. Database
// time is returned by the same read and is the only boundary clock used.
async function lockScoringInputState(client, userId) {
  const inserted = await client.$queryRawUnsafe(
    `INSERT INTO user_scoring_input_versions (user_id,generation,updated_at)
     VALUES ($1,1,CURRENT_TIMESTAMP) ON CONFLICT (user_id) DO NOTHING
     RETURNING user_id`,
    userId
  );
  const rows = await client.$queryRawUnsafe(
    `SELECT generation,
       source_queue_semantics_generation AS "sourceQueueSemanticsGeneration",
       scoring_watermark AS "scoringWatermark",
       next_sample_boundary_at AS "nextSampleBoundaryAt",
       (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::float8 AS "dbNowMs"
     FROM user_scoring_input_versions WHERE user_id=$1 FOR UPDATE`,
    userId
  );
  const row = rows[0] || {};
  return {
    ...row,
    dbNow: new Date(Number(row.dbNowMs)),
    inserted: inserted.length === 1,
  };
}

async function readCanonicalSampleInput(client, userId, dbNow = null) {
  const rows = await client.$queryRawUnsafe(
    `SELECT (EXTRACT(EPOCH FROM period_start) * 1000)::float8 AS "periodStartMs",
       (EXTRACT(EPOCH FROM period_end) * 1000)::float8 AS "periodEndMs", steps,
       source_name AS "sourceName", source_id AS "sourceId",
       source_device_id AS "sourceDeviceId", device_model AS "deviceModel",
       recording_method AS "recordingMethod", metadata
     FROM step_samples WHERE user_id=$1
     ORDER BY period_start, period_end, id`,
    userId
  );
  const clockRows = dbNow == null
    ? await client.$queryRawUnsafe(
      `SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::float8 AS "dbNowMs"`
    )
    : [{ dbNowMs: new Date(dbNow).getTime() }];
  const decisionTime = new Date(Number(clockRows[0]?.dbNowMs));
  const storageRows = rows.map((row) => ({
    ...row,
    periodStart: new Date(Number(row.periodStartMs)).toISOString(),
    periodEnd: new Date(Number(row.periodEndMs)).toISOString(),
    periodStartMs: undefined,
    periodEndMs: undefined,
  }));
  const scoringRows = storageRows.map((row) => ({
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    steps: Number(row.steps),
  }));
  const currentMs = new Date(decisionTime).getTime();
  const futureEnds = scoringRows
    .map((row) => new Date(row.periodEnd).getTime())
    .filter((value) => Number.isFinite(value) && value > currentMs);
  return {
    scoringWatermark: digestRows(scoringRows),
    storageWatermark: digestRows(storageRows),
    nextSampleBoundaryAt: futureEnds.length
      ? new Date(Math.min(...futureEnds))
      : null,
    canonicalCoverageThrough: scoringRows.length
      ? new Date(Math.max(...scoringRows.map((row) => new Date(row.periodEnd).getTime())))
      : null,
    dbNow: decisionTime,
  };
}

function scoringBoundaryIsSafe(state) {
  if (!state?.scoringWatermark) return false;
  if (!state.nextSampleBoundaryAt) return true;
  const boundary = new Date(state.nextSampleBoundaryAt).getTime();
  const dbNow = new Date(state.dbNow).getTime();
  return Number.isFinite(boundary) && Number.isFinite(dbNow) && dbNow < boundary;
}

async function persistScoringInputState(client, userId, state, next, scoringChanged) {
  await client.$executeRawUnsafe(
    `UPDATE user_scoring_input_versions
     SET generation = generation + $2::bigint,
         scoring_watermark=$3,
         next_sample_boundary_at=$4,
         updated_at=CURRENT_TIMESTAMP
     WHERE user_id=$1`,
    userId,
    scoringChanged && !state.inserted ? 1 : 0,
    next.scoringWatermark,
    next.nextSampleBoundaryAt
  );
}

async function stampSourceQueueSemanticsGeneration(client, userId, generation) {
  await client.$executeRawUnsafe(
    `UPDATE user_scoring_input_versions
     SET source_queue_semantics_generation=$2::bigint,
         updated_at=CURRENT_TIMESTAMP
     WHERE user_id=$1`,
    userId,
    String(generation)
  );
}

module.exports = {
  bumpScoringInputVersion,
  bumpManyScoringInputVersions,
  materializeAndReadScoringInputVersion,
  lockScoringInputState,
  readCanonicalSampleInput,
  scoringBoundaryIsSafe,
  persistScoringInputState,
  stampSourceQueueSemanticsGeneration,
};
