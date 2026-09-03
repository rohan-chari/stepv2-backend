const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");

const BATCH_SIZE = 64;

function normalizedResultVersion(race) {
  if (race?.status !== "COMPLETED") return "";
  const parsed = race.updatedAt instanceof Date
    ? race.updatedAt
    : new Date(race?.updatedAt);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "invalid";
}

// A batch shares the SQL result computed by its first request. Completed
// summaries are versioned by races.updated_at, so status and result version
// are part of the identity: a repair that lands between two concurrent reads
// must never let the newer read join the older result's queue.
function raceSqlSummaryBatchKey(races = []) {
  return races
    .filter((race) => race?.id)
    .map((race) => [race.id, race.status || "", normalizedResultVersion(race)].join("\u001f"))
    .sort()
    .join("\u0000");
}

function createRaceSqlSummaryReadBatch() {
  const states = new WeakMap();
  function load({ prisma, raceSetKey, userId, execute }) {
    let queues = states.get(prisma);
    if (!queues) {
      queues = new Map();
      states.set(prisma, queues);
    }
    let queue = queues.get(raceSetKey);
    if (!queue) {
      queue = { pending: [], draining: false };
      queues.set(raceSetKey, queue);
    }
    const promise = new Promise((resolve, reject) => {
      queue.pending.push({ userId, execute, resolve, reject });
    });
    scheduleBoundedBatchDrain(queue, async (requests) => {
      for (let offset = 0; offset < requests.length; offset += BATCH_SIZE) {
        const page = requests.slice(offset, offset + BATCH_SIZE);
        const userIds = [...new Set(page.map((request) => request.userId))];
        const rows = await page[0].execute(userIds);
        const byUserId = new Map(userIds.map((id) => [id, []]));
        for (const row of rows || []) {
          byUserId.get(row.viewerUserId)?.push(row);
        }
        for (const request of page) {
          request.resolve(byUserId.get(request.userId) || []);
        }
      }
    });
    return promise;
  }
  return { load };
}

const raceSqlSummaryReadBatch = createRaceSqlSummaryReadBatch();

module.exports = {
  BATCH_SIZE,
  createRaceSqlSummaryReadBatch,
  raceSqlSummaryBatchKey,
  raceSqlSummaryReadBatch,
};
