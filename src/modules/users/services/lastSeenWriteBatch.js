const BATCH_SIZE = 256;
const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");

const UPDATE_SQL = `
  WITH input_rows AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS input(
      "requestIndex" integer,
      id text,
      "lastSeenAt" timestamptz,
      "lastAppVersion" text
    )
  ), input AS (
    SELECT DISTINCT ON (id) id,"lastSeenAt","lastAppVersion"
      FROM input_rows
     ORDER BY id,"requestIndex" DESC
  )
  UPDATE users AS existing
     SET last_seen_at = input."lastSeenAt",
         last_app_version = COALESCE(input."lastAppVersion", existing.last_app_version)
    FROM input
   WHERE existing.id = input.id`;

function createLastSeenWriteBatch() {
  const states = new WeakMap();

  function write({ prisma, id, fields }) {
    let state = states.get(prisma);
    if (!state) {
      state = { pending: [], draining: false };
      states.set(prisma, state);
    }

    const promise = new Promise((resolve, reject) => {
      state.pending.push({ id, fields, resolve, reject });
    });

    scheduleBoundedBatchDrain(state, async (requests) => {
      for (let offset = 0; offset < requests.length; offset += BATCH_SIZE) {
        const page = requests.slice(offset, offset + BATCH_SIZE);
        const payload = page.map((request, requestIndex) => ({
          requestIndex,
          id: request.id,
          lastSeenAt: new Date(request.fields.lastSeenAt).toISOString(),
          lastAppVersion: request.fields.lastAppVersion ?? null,
        }));
        await prisma.$queryRawUnsafe(UPDATE_SQL, JSON.stringify(payload));
        for (const request of page) request.resolve();
      }
    });

    return promise;
  }

  return { write };
}

const lastSeenWriteBatch = createLastSeenWriteBatch();

module.exports = {
  BATCH_SIZE,
  UPDATE_SQL,
  createLastSeenWriteBatch,
  lastSeenWriteBatch,
};
