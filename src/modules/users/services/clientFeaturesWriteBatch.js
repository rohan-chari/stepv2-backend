const { targetWindows } = require('../../races/services/seededChallengeEnrollment');
const BATCH_SIZE = 256;
const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");

const UPDATE_SQL = `
  WITH input_rows AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS input(
      "requestIndex" integer,
      id text,
      features text[],
      "requestedAt" timestamptz,
      windows jsonb
    )
  ), input AS (
    SELECT input_rows.id, array_agg(DISTINCT feature ORDER BY feature) AS features
      FROM input_rows
      CROSS JOIN LATERAL unnest(input_rows.features) AS feature
     GROUP BY input_rows.id
  )
  , updated AS (UPDATE users AS existing
     SET client_features = ARRAY(
           SELECT DISTINCT feature
           FROM unnest(existing.client_features || input.features) feature
           ORDER BY feature
         ),
         client_features_at = clock_timestamp()
    FROM input
   WHERE existing.id=input.id
     AND NOT existing.client_features @> input.features
  RETURNING existing.id, existing.auto_join_featured_races, existing.is_review_account
  )
  INSERT INTO seeded_challenge_enrollment_requests
    (id,user_id,seed_id,window_start,window_end,source,requested_at,state,available_at,attempts)
  SELECT gen_random_uuid()::text,u.id,s.id,w."windowStart",w."windowEnd",'CAPABILITY',i."requestedAt",'PENDING',i."requestedAt",0
    FROM updated u JOIN input_rows i ON i.id=u.id
    CROSS JOIN LATERAL jsonb_to_recordset(i.windows) AS w(cadence text,"windowStart" timestamptz,"windowEnd" timestamptz)
    JOIN race_seeds s ON upper(s.cadence::text)=w.cadence AND s.active AND s.kind IN ('DAILY_10K','WEEKLY_50K')
   WHERE u.auto_join_featured_races AND NOT u.is_review_account
     AND 'seeded_race_buckets'=ANY(i.features)
  ON CONFLICT (user_id,seed_id,window_start) DO NOTHING`;

function createClientFeaturesWriteBatch({
  drainDelayMs = 10,
} = {}) {
  const states = new WeakMap();
  function write({ prisma, id, features, requestedAt = new Date() }) {
    let state = states.get(prisma);
    if (!state) {
      state = { pending: [], draining: false };
      states.set(prisma, state);
    }
    const promise = new Promise((resolve, reject) => {
      state.pending.push({ id, features, requestedAt, windows: targetWindows(requestedAt), resolve, reject });
    });
    scheduleBoundedBatchDrain(state, async (requests) => {
      for (let offset = 0; offset < requests.length; offset += BATCH_SIZE) {
        const page = requests.slice(offset, offset + BATCH_SIZE);
        const payload = page.map((request, requestIndex) => ({
          requestIndex,
          id: request.id,
          features: [...new Set(request.features || [])].sort(),
          ...(request.features?.includes("seeded_race_buckets") ? { requestedAt: request.requestedAt, windows: request.windows } : {}),
        }));
        await prisma.$queryRawUnsafe(UPDATE_SQL, JSON.stringify(payload));
        for (const request of page) request.resolve();
      }
    }, drainDelayMs);
    return promise;
  }
  return { write };
}

const clientFeaturesWriteBatch = createClientFeaturesWriteBatch();

module.exports = {
  BATCH_SIZE,
  UPDATE_SQL,
  createClientFeaturesWriteBatch,
  clientFeaturesWriteBatch,
};
