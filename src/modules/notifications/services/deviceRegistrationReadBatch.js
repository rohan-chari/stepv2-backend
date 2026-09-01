const BATCH_SIZE = 32;
// Device registration runs alongside auth, home, races, and inbox at launch.
// Limit this batcher to one database page so aggregate endpoint concurrency
// remains below the worker's intentionally bounded HTTP connection pool.
const BATCH_CONCURRENCY = 1;
const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");

function identity(value) {
  return [
    value.userId, value.token, value.platform,
    value.installationId ?? "", value.providerEnvironment ?? "",
  ].join("\u0000");
}

function createDeviceRegistrationReadBatch() {
  const states = new WeakMap();
  function find({ prisma, where }) {
    let state = states.get(prisma);
    if (!state) {
      state = { pending: [], draining: false };
      states.set(prisma, state);
    }
    const promise = new Promise((resolve, reject) => {
      state.pending.push({ where, resolve, reject });
    });
    scheduleBoundedBatchDrain(state, async (pending) => {
        const pages = [];
        for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
          pages.push(pending.slice(offset, offset + BATCH_SIZE));
        }
        let nextPage = 0;
          await Promise.all(Array.from(
            { length: Math.min(BATCH_CONCURRENCY, pages.length) },
            async () => {
              for (;;) {
                const index = nextPage++;
                if (index >= pages.length) return;
                const page = pages[index];
                const rows = await prisma.deviceToken.findMany({
                  where: { OR: page.map((request) => request.where) },
                });
                const byIdentity = new Map((rows || []).map((row) => [identity(row), row]));
                for (const request of page) {
                  const row = byIdentity.get(identity(request.where)) || null;
                  request.resolve(
                    row && request.where.adminMetricsOpenCapable === true &&
                    (row.adminMetricsOpenCapable !== true ||
                      row.adminMetricsOpenEpochId !== request.where.adminMetricsOpenEpochId)
                      ? null
                      : row,
                  );
                }
              }
            },
          ));
    });
    return promise;
  }
  return { find };
}

const deviceRegistrationReadBatch = createDeviceRegistrationReadBatch();

module.exports = {
  BATCH_CONCURRENCY, BATCH_SIZE, createDeviceRegistrationReadBatch,
  deviceRegistrationReadBatch,
};
