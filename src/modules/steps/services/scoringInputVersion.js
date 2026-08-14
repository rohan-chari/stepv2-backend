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

module.exports = { bumpScoringInputVersion, bumpManyScoringInputVersions };
