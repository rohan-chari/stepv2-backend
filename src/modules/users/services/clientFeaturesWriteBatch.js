const BATCH_SIZE = 256;
const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");

const UPDATE_SQL = `
  WITH input_rows AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS input(
      "requestIndex" integer,
      id text,
      features text[]
    )
  ), input AS (
    SELECT input_rows.id, array_agg(DISTINCT feature ORDER BY feature) AS features
      FROM input_rows
      CROSS JOIN LATERAL unnest(input_rows.features) AS feature
     GROUP BY input_rows.id
  )
  UPDATE users AS existing
     SET client_features = ARRAY(
           SELECT DISTINCT feature
           FROM unnest(existing.client_features || input.features) feature
           ORDER BY feature
         ),
         client_features_at = clock_timestamp()
    FROM input
   WHERE existing.id=input.id
     AND NOT existing.client_features @> input.features`;

function createClientFeaturesWriteBatch({
  drainDelayMs = 10,
} = {}) {
  const states = new WeakMap();
  function write({ prisma, id, features }) {
    let state = states.get(prisma);
    if (!state) {
      state = { pending: [], draining: false };
      states.set(prisma, state);
    }
    const promise = new Promise((resolve, reject) => {
      state.pending.push({ id, features, resolve, reject });
    });
    scheduleBoundedBatchDrain(state, async (requests) => {
      for (let offset = 0; offset < requests.length; offset += BATCH_SIZE) {
        const page = requests.slice(offset, offset + BATCH_SIZE);
        const payload = page.map((request, requestIndex) => ({
          requestIndex,
          id: request.id,
          features: [...new Set(request.features || [])].sort(),
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
