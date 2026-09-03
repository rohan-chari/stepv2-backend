const BATCH_SIZE = 256;
const crypto = require("node:crypto");
const defaultRedisCache = require("../../../shared/cache/redisCache");
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
    SELECT id,
           (array_agg("lastSeenAt" ORDER BY "requestIndex" DESC))[1] AS "lastSeenAt",
           (array_agg("lastAppVersion" ORDER BY "requestIndex" DESC)
             FILTER (WHERE "lastAppVersion" IS NOT NULL))[1] AS "lastAppVersion"
      FROM input_rows
     GROUP BY id
  )
  UPDATE users AS existing
     SET last_seen_at = input."lastSeenAt",
         last_app_version = COALESCE(input."lastAppVersion", existing.last_app_version)
    FROM input
   WHERE existing.id = input.id
     AND (existing.last_seen_at IS DISTINCT FROM input."lastSeenAt"
       OR (input."lastAppVersion" IS NOT NULL
         AND existing.last_app_version IS DISTINCT FROM input."lastAppVersion"))`;

const CLAIM_SQL = "return redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')";
const RELEASE_SQL = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0`;

async function admitted(redisCache, request) {
  const seen = new Date(request.fields.lastSeenAt);
  const state = `${seen.toISOString().slice(0, 10)}\u0000${request.fields.lastAppVersion || ""}`;
  const digest = crypto.createHash("sha256").update(state).digest("hex").slice(0, 24);
  const key = `v1:user-metadata:last-seen:${request.id}:${digest}`;
  const token = crypto.randomUUID();
  const claim = await redisCache.evalLua(
    CLAIM_SQL,
    [key],
    [token, 30_000],
    { genericError: true, opClass: "metadata-admission" },
  );
  if (!claim?.ok) return { admitted: true, key: null, token: null };
  return { admitted: claim.result === "OK", key, token };
}

async function releaseClaim(redisCache, decision) {
  if (!decision?.key || !decision.token) return;
  await redisCache.evalLua(
    RELEASE_SQL,
    [decision.key],
    [decision.token],
    { genericError: true, opClass: "metadata-admission-release" },
  );
}

function createLastSeenWriteBatch({
  redisCache = defaultRedisCache,
  drainDelayMs = 250,
} = {}) {
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
        const decisions = await Promise.all(page.map((request) => admitted(redisCache, request)));
        const payload = page.filter((request, index) => decisions[index].admitted)
          .map((request, requestIndex) => ({
          requestIndex,
          id: request.id,
          lastSeenAt: new Date(request.fields.lastSeenAt).toISOString(),
          lastAppVersion: request.fields.lastAppVersion ?? null,
        }));
        try {
          if (payload.length > 0) {
            await prisma.$queryRawUnsafe(UPDATE_SQL, JSON.stringify(payload));
          }
        } catch (error) {
          await Promise.allSettled(decisions.map(
            (decision) => releaseClaim(redisCache, decision),
          ));
          throw error;
        }
        for (let index = 0; index < page.length; index += 1) {
          page[index].resolve(decisions[index].admitted);
        }
      }
    }, drainDelayMs);

    return promise;
  }

  return { write };
}

const lastSeenWriteBatch = createLastSeenWriteBatch();

module.exports = {
  BATCH_SIZE,
  UPDATE_SQL,
  RELEASE_SQL,
  createLastSeenWriteBatch,
  lastSeenWriteBatch,
};
