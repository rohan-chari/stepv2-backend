const crypto = require("node:crypto");
const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");

const BATCH_SIZE = 64;
const MAX_ACTIVE_INSTALLATIONS = 10;

const LOCK_SQL = `
  WITH locked AS MATERIALIZED (
    SELECT pg_advisory_xact_lock(hashtext($2),hashtext(identity)) AS acquired
      FROM jsonb_array_elements_text($1::jsonb) identity
     ORDER BY identity
  )
  SELECT COUNT(*)::integer AS locked FROM locked`;

const INSERT_SQL = `
  WITH input AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS registration(
      "requestIndex" integer,id text,"userId" text,token text,platform text,
      "installationId" text,"providerEnvironment" text,"now" timestamptz,
      "unchangedAfter" timestamptz,
      "adminMetricsOpenCapable" boolean,"adminMetricsOpenEpochId" text
    )
  ), ranked AS (
    SELECT input.*,
      ROW_NUMBER() OVER (PARTITION BY platform,token ORDER BY "requestIndex") AS token_rank,
      ROW_NUMBER() OVER (
        PARTITION BY platform,"installationId" ORDER BY "requestIndex"
      ) AS installation_rank,
      ROW_NUMBER() OVER (PARTITION BY "userId" ORDER BY "requestIndex") AS user_rank
      FROM input
  ), unchanged AS (
    SELECT DISTINCT ON (ranked."requestIndex")
      ranked."requestIndex",existing.*
      FROM ranked
      JOIN device_tokens existing
        ON existing.user_id=ranked."userId"
       AND existing.token=ranked.token
       AND existing.platform=ranked.platform
       AND existing.installation_id IS NOT DISTINCT FROM ranked."installationId"
       AND existing.provider_environment IS NOT DISTINCT FROM ranked."providerEnvironment"
     WHERE existing.last_registered_at>=ranked."unchangedAfter"
       AND existing.status='ACTIVE'
       AND (
         NOT ranked."adminMetricsOpenCapable" OR (
           existing.admin_metrics_open_capable=TRUE
           AND existing.admin_metrics_open_epoch_id IS NOT DISTINCT FROM
             ranked."adminMetricsOpenEpochId"
         )
       )
     ORDER BY ranked."requestIndex",existing.updated_at DESC,existing.id DESC
  ), refreshed AS (
    UPDATE device_tokens existing
       SET last_registered_at=ranked."now",
           updated_at=ranked."now",
           admin_metrics_open_capable=(
             existing.admin_metrics_open_capable OR ranked."adminMetricsOpenCapable"
           ),
           admin_metrics_open_epoch_id=CASE
             WHEN ranked."adminMetricsOpenCapable"
               THEN ranked."adminMetricsOpenEpochId"
             ELSE existing.admin_metrics_open_epoch_id
           END
      FROM ranked
     WHERE ranked.token_rank=1
       AND (ranked."installationId" IS NULL OR ranked.installation_rank=1)
       AND existing.user_id=ranked."userId"
       AND existing.token=ranked.token
       AND existing.platform=ranked.platform
       AND existing.installation_id IS NOT DISTINCT FROM ranked."installationId"
       AND existing.provider_environment IS NOT DISTINCT FROM ranked."providerEnvironment"
       AND existing.status='ACTIVE'
       AND (
         existing.last_registered_at<ranked."unchangedAfter"
         OR (
           ranked."adminMetricsOpenCapable" AND (
             existing.admin_metrics_open_capable IS NOT TRUE
             OR existing.admin_metrics_open_epoch_id IS DISTINCT FROM
               ranked."adminMetricsOpenEpochId"
           )
         )
       )
    RETURNING ranked."requestIndex",existing.*
  ), eligible AS (
    SELECT ranked.* FROM ranked
     WHERE token_rank=1
       AND ("installationId" IS NULL OR installation_rank=1)
       AND NOT EXISTS (
         SELECT 1 FROM device_tokens existing
          WHERE existing.platform=ranked.platform AND existing.token=ranked.token
       )
       AND ("installationId" IS NULL OR NOT EXISTS (
         SELECT 1 FROM device_tokens existing
          WHERE existing.platform=ranked.platform
            AND existing.installation_id=ranked."installationId"
       ))
       AND user_rank + (
         SELECT COUNT(*) FROM device_tokens existing
          WHERE existing.user_id=ranked."userId"
            AND (existing.status='ACTIVE' OR existing.status IS NULL)
       ) <= $2
  ), inserted AS (
    INSERT INTO device_tokens(
      id,user_id,token,platform,installation_id,provider_environment,
      last_registered_at,status,status_reason,status_changed_at,
      ownership_generation,admin_metrics_open_capable,
      admin_metrics_open_epoch_id,created_at,updated_at
    )
    SELECT id,"userId",token,platform,"installationId","providerEnvironment",
      "now",'ACTIVE',NULL,"now",1,"adminMetricsOpenCapable",
      CASE WHEN "adminMetricsOpenCapable" THEN "adminMetricsOpenEpochId" ELSE NULL END,
      "now","now"
      FROM eligible
    ON CONFLICT (user_id,token) DO NOTHING
    RETURNING *
  ), resolved AS (
    SELECT unchanged."requestIndex",to_jsonb(unchanged) - 'requestIndex' AS row
      FROM unchanged
    UNION ALL
    SELECT refreshed."requestIndex",to_jsonb(refreshed) - 'requestIndex' AS row
      FROM refreshed
    UNION ALL
    SELECT input."requestIndex",to_jsonb(inserted) AS row
      FROM input JOIN inserted ON inserted.id=input.id
  )
  SELECT "requestIndex",row FROM resolved`;

function identitiesFor(registration) {
  const values = [
    `token:any:${registration.token}`,
    `token:${registration.platform}:${registration.token}`,
    `user:${registration.userId}`,
  ];
  if (registration.installationId) values.push(
    `installation:any:${registration.installationId}`,
    `installation:${registration.platform}:${registration.installationId}`,
  );
  return values;
}

function normalizeRow(result) {
  if (!result?.row) return result;
  const row = result.row;
  return {
    id: row.id,
    userId: row.user_id,
    token: row.token,
    platform: row.platform,
    createdAt: row.created_at ? new Date(row.created_at) : null,
    updatedAt: row.updated_at ? new Date(row.updated_at) : null,
    adminMetricsOpenCapable: row.admin_metrics_open_capable,
    adminMetricsOpenEpochId: row.admin_metrics_open_epoch_id,
    installationId: row.installation_id,
    lastRegisteredAt: row.last_registered_at
      ? new Date(row.last_registered_at)
      : null,
    lastProviderAcceptedAt: row.last_provider_accepted_at
      ? new Date(row.last_provider_accepted_at)
      : null,
    status: row.status,
    statusReason: row.status_reason,
    statusChangedAt: row.status_changed_at ? new Date(row.status_changed_at) : null,
    ownershipGeneration: row.ownership_generation,
    providerEnvironment: row.provider_environment,
  };
}

function createDeviceRegistrationCreateBatch() {
  const states = new WeakMap();
  function tryCreate({ prisma, registration }) {
    let state = states.get(prisma);
    if (!state) {
      state = { pending: [], draining: false };
      states.set(prisma, state);
    }
    const promise = new Promise((resolve, reject) => {
      state.pending.push({ registration, resolve, reject });
    });
    scheduleBoundedBatchDrain(state, async (pending) => {
          for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
            const page = pending.slice(offset, offset + BATCH_SIZE);
            const rows = await prisma.$transaction(async (tx) => {
              const identities = [...new Set(page.flatMap(({ registration }) =>
                identitiesFor(registration)))].sort();
              await tx.$queryRawUnsafe(
                LOCK_SQL, JSON.stringify(identities), "device-registration-batch",
              );
              const payload = page.map(({ registration }, requestIndex) => ({
                requestIndex,
                id: crypto.randomUUID(),
                ...registration,
                now: new Date(registration.now).toISOString(),
              }));
              return tx.$queryRawUnsafe(
                INSERT_SQL, JSON.stringify(payload), MAX_ACTIVE_INSTALLATIONS,
              );
            }, { timeout: 10_000, maxWait: 5_000 });
            const byIndex = new Map((rows || []).map((row) => [
              Number(row.requestIndex), normalizeRow(row),
            ]));
            for (let index = 0; index < page.length; index += 1) {
              page[index].resolve(byIndex.get(index) || null);
            }
          }
    });
    return promise;
  }
  return { tryCreate };
}

const deviceRegistrationCreateBatch = createDeviceRegistrationCreateBatch();

module.exports = {
  BATCH_SIZE,
  INSERT_SQL,
  LOCK_SQL,
  createDeviceRegistrationCreateBatch,
  deviceRegistrationCreateBatch,
};
