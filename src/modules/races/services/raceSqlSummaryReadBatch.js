const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");

const BATCH_SIZE = 64;

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
  raceSqlSummaryReadBatch,
};
