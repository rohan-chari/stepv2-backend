const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");

const BATCH_SIZE = 256;

function createRaceLaunchAuxiliaryBatch() {
  const states = new WeakMap();
  function loadReviewOpportunities({ prisma, userId, raceIds, now = new Date() }) {
    let queue = states.get(prisma);
    if (!queue) {
      queue = { pending: [], draining: false };
      states.set(prisma, queue);
    }
    const promise = new Promise((resolve, reject) => {
      queue.pending.push({ userId, raceIds: [...new Set(raceIds || [])], now, resolve, reject });
    });
    scheduleBoundedBatchDrain(queue, async (requests) => {
      for (let offset = 0; offset < requests.length; offset += BATCH_SIZE) {
        const page = requests.slice(offset, offset + BATCH_SIZE);
        const userIds = [...new Set(page.map((request) => request.userId))];
        const allRaceIds = [...new Set(page.flatMap((request) => request.raceIds))];
        if (allRaceIds.length === 0) {
          for (const request of page) request.resolve([]);
          continue;
        }
        const oldest = new Date(Math.min(...page.map((request) => request.now.getTime())));
        const rows = await prisma.appReviewPromptAttempt.findMany({
          where: {
            userId: { in: userIds },
            claimedAt: null,
            expiresAt: { gt: oldest },
            raceId: { in: allRaceIds },
          },
          select: {
            userId: true,
            opportunityId: true,
            raceId: true,
            expiresAt: true,
          },
        });
        for (const request of page) {
          const allowed = new Set(request.raceIds);
          request.resolve((rows || []).filter((row) =>
            row.userId === request.userId && allowed.has(row.raceId) &&
            new Date(row.expiresAt) > request.now));
        }
      }
    });
    return promise;
  }
  return { loadReviewOpportunities };
}

const raceLaunchAuxiliaryBatch = createRaceLaunchAuxiliaryBatch();

module.exports = {
  BATCH_SIZE,
  createRaceLaunchAuxiliaryBatch,
  raceLaunchAuxiliaryBatch,
};
