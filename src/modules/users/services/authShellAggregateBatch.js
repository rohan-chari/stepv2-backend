const BATCH_SIZE = 256;
const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");

function createAuthShellAggregateBatch() {
  const states = new WeakMap();
  function load({ prisma, userId }) {
    let state = states.get(prisma);
    if (!state) {
      state = { pending: [], draining: false };
      states.set(prisma, state);
    }
    const promise = new Promise((resolve, reject) => {
      state.pending.push({ userId, resolve, reject });
    });
    scheduleBoundedBatchDrain(state, async (requests) => {
      for (let offset = 0; offset < requests.length; offset += BATCH_SIZE) {
            const page = requests.slice(offset, offset + BATCH_SIZE);
            const userIds = [...new Set(page.map((request) => request.userId))];
            const [heldRows, friendRows] = await Promise.all([
              prisma.raceParticipant.groupBy({
                by: ["userId"],
                where: { userId: { in: userIds }, buyInStatus: "HELD" },
                _sum: { buyInAmount: true },
              }),
              prisma.friendship.groupBy({
                by: ["addresseeId"],
                where: { addresseeId: { in: userIds }, status: "PENDING" },
                _count: { _all: true },
              }),
            ]);
            const heldByUser = new Map((heldRows || []).map((row) => [
              row.userId, Number(row._sum?.buyInAmount) || 0,
            ]));
            const friendsByUser = new Map((friendRows || []).map((row) => [
              row.addresseeId, Number(row._count?._all) || 0,
            ]));
            for (const request of page) {
              request.resolve({
                heldCoins: heldByUser.get(request.userId) || 0,
                incomingFriendRequests: friendsByUser.get(request.userId) || 0,
              });
            }
      }
    });
    return promise;
  }
  return { load };
}

const authShellAggregateBatch = createAuthShellAggregateBatch();

module.exports = {
  BATCH_SIZE, authShellAggregateBatch, createAuthShellAggregateBatch,
};
