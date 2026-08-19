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

module.exports = {
  bumpScoringInputVersion,
  bumpManyScoringInputVersions,
  materializeAndReadScoringInputVersion,
};
