const BATCH_SIZE = 256;
const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");

const INSERT_SQL = `
  WITH input AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS event(
      "requestIndex" integer,"eventIndex" integer,id text,"userId" text,
      "onboardingSessionId" text,name text,context jsonb,"appVersion" text,
      platform text,"occurredAt" timestamptz
    )
  ), ranked AS (
    SELECT input.*,ROW_NUMBER() OVER (
      PARTITION BY id ORDER BY "requestIndex","eventIndex"
    ) AS duplicate_rank FROM input
  ), inserted AS (
    INSERT INTO activation_events(
      id,user_id,onboarding_session_id,name,context,app_version,platform,
      occurred_at,created_at
    )
    SELECT id,"userId","onboardingSessionId",name,context,"appVersion",
           platform,"occurredAt",clock_timestamp()
      FROM ranked WHERE duplicate_rank=1
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  )
  SELECT ranked."requestIndex",COUNT(inserted.id) AS inserted
    FROM ranked
    LEFT JOIN inserted ON inserted.id=ranked.id AND ranked.duplicate_rank=1
   GROUP BY ranked."requestIndex"`;

function createActivationEventInsertBatch() {
  const states = new WeakMap();
  function insert({ prisma, data }) {
    let state = states.get(prisma);
    if (!state) {
      state = { pending: [], draining: false };
      states.set(prisma, state);
    }
    const promise = new Promise((resolve, reject) => {
      state.pending.push({ data, resolve, reject });
    });
    scheduleBoundedBatchDrain(state, async (requests) => {
      for (let offset = 0; offset < requests.length; offset += BATCH_SIZE) {
            const page = requests.slice(offset, offset + BATCH_SIZE);
            const payload = page.flatMap((request, requestIndex) =>
              request.data.map((event, eventIndex) => ({
                requestIndex,
                eventIndex,
                id: event.id,
                userId: event.userId,
                onboardingSessionId: event.onboardingSessionId ?? null,
                name: event.name,
                context: event.context || {},
                appVersion: event.appVersion,
                platform: event.platform,
                occurredAt: new Date(event.occurredAt).toISOString(),
              })));
            const rows = await prisma.$queryRawUnsafe(INSERT_SQL, JSON.stringify(payload));
            const insertedByRequest = new Map((rows || []).map((row) => [
              Number(row.requestIndex), Number(row.inserted) || 0,
            ]));
            for (let index = 0; index < page.length; index += 1) {
              page[index].resolve(insertedByRequest.get(index) || 0);
            }
      }
    });
    return promise;
  }
  return { insert };
}

const activationEventInsertBatch = createActivationEventInsertBatch();

module.exports = {
  BATCH_SIZE, INSERT_SQL, activationEventInsertBatch,
  createActivationEventInsertBatch,
};
