const BATCH_SIZE = 128;
// A launch wave hits several independently batched endpoints at once. Keep each
// batcher to one database page in flight so those endpoints share the bounded
// HTTP pool instead of collectively filling it and creating a waiter cascade.
const BATCH_CONCURRENCY = 1;
const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");

function createRaceListReadBatch() {
  const states = new WeakMap();
  function loadRows({ prisma, userId, select }) {
    let state = states.get(prisma);
    if (!state) {
      state = { pending: [], draining: false };
      states.set(prisma, state);
    }
    const promise = new Promise((resolve, reject) => {
      state.pending.push({ userId, select, resolve, reject });
    });
    scheduleBoundedBatchDrain(state, async (requests) => {
          const pages = [];
          for (let offset = 0; offset < requests.length; offset += BATCH_SIZE) {
            pages.push(requests.slice(offset, offset + BATCH_SIZE));
          }
          let nextPage = 0;
          await Promise.all(Array.from(
            { length: Math.min(BATCH_CONCURRENCY, pages.length) },
            async () => {
            for (;;) {
              const index = nextPage++;
              if (index >= pages.length) return;
              const page = pages[index];
            const userIds = [...new Set(page.map((request) => request.userId))];
            const rows = await prisma.raceParticipant.findMany({
              where: { userId: { in: userIds }, status: { not: "DECLINED" } },
              select: { ...page[0].select, userId: true },
            });
            const grouped = new Map(userIds.map((id) => [id, []]));
            for (const row of rows || []) grouped.get(row.userId)?.push(row);
            for (const request of page) {
              request.resolve(grouped.get(request.userId) || []);
            }
            }
          }));
    });
    return promise;
  }
  return { loadRows };
}

const raceListReadBatch = createRaceListReadBatch();

module.exports = {
  BATCH_CONCURRENCY, BATCH_SIZE, createRaceListReadBatch, raceListReadBatch,
};
