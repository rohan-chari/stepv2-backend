const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");

const BATCH_SIZE = 256;

function createLiveUserCreatedRaceReadBatch() {
  const states = new WeakMap();
  function hasLive({ prisma, userId }) {
    let queue = states.get(prisma);
    if (!queue) {
      queue = { pending: [], draining: false };
      states.set(prisma, queue);
    }
    const promise = new Promise((resolve, reject) => {
      queue.pending.push({ userId, resolve, reject });
    });
    scheduleBoundedBatchDrain(queue, async (requests) => {
      for (let offset = 0; offset < requests.length; offset += BATCH_SIZE) {
        const page = requests.slice(offset, offset + BATCH_SIZE);
        const ids = [...new Set(page.map((request) => request.userId))];
        const rows = await prisma.raceParticipant.findMany({
          where: {
            userId: { in: ids },
            status: "ACCEPTED",
            race: {
              creatorId: { not: null },
              status: { in: ["PENDING", "ACTIVE"] },
            },
          },
          select: { userId: true },
          distinct: ["userId"],
        });
        const found = new Set((rows || []).map((row) => row.userId));
        for (const request of page) request.resolve(found.has(request.userId));
      }
    });
    return promise;
  }
  return { hasLive };
}

const liveUserCreatedRaceReadBatch = createLiveUserCreatedRaceReadBatch();

module.exports = {
  BATCH_SIZE,
  createLiveUserCreatedRaceReadBatch,
  liveUserCreatedRaceReadBatch,
};
