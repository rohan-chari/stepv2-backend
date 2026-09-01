const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");

const WRITE_SQL = `
  WITH requested AS (
    SELECT "userId", MAX(at) AS at
      FROM jsonb_to_recordset($1::jsonb) AS request(
        "userId" text,
        at timestamptz
      )
     GROUP BY "userId"
  )
  UPDATE users
     SET last_step_sync_at = GREATEST(
       COALESCE(users.last_step_sync_at, '-infinity'::timestamptz),
       requested.at
     )
    FROM requested
   WHERE users.id = requested."userId"`;

function createLastStepSyncWriteBatch() {
  const states = new WeakMap();

  function stamp({ prisma, userId, at = new Date() }) {
    let queue = states.get(prisma);
    if (!queue) {
      queue = { pending: [], draining: false };
      states.set(prisma, queue);
    }
    const promise = new Promise((resolve, reject) => {
      queue.pending.push({ userId, at, resolve, reject });
    });
    scheduleBoundedBatchDrain(queue, async (requests) => {
      const latestByUserId = new Map();
      for (const request of requests) {
        const current = latestByUserId.get(request.userId);
        if (!current || new Date(request.at) > new Date(current.at)) {
          latestByUserId.set(request.userId, request);
        }
      }
      const payload = [...latestByUserId.values()]
        .sort((left, right) => left.userId.localeCompare(right.userId))
        .map((request) => ({
          userId: request.userId,
          at: new Date(request.at).toISOString(),
        }));
      await prisma.$executeRawUnsafe(WRITE_SQL, JSON.stringify(payload));
      for (const request of requests) request.resolve();
    });
    return promise;
  }

  return { stamp };
}

const lastStepSyncWriteBatch = createLastStepSyncWriteBatch();

module.exports = {
  WRITE_SQL,
  createLastStepSyncWriteBatch,
  lastStepSyncWriteBatch,
};
