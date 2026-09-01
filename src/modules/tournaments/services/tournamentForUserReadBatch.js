const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");

const BATCH_SIZE = 256;

function createTournamentForUserReadBatch() {
  const states = new WeakMap();
  function load({ prisma, userId, include }) {
    let queue = states.get(prisma);
    if (!queue) {
      queue = { pending: [], draining: false };
      states.set(prisma, queue);
    }
    const promise = new Promise((resolve, reject) => {
      queue.pending.push({ userId, include, resolve, reject });
    });
    scheduleBoundedBatchDrain(queue, async (requests) => {
      for (let offset = 0; offset < requests.length; offset += BATCH_SIZE) {
        const page = requests.slice(offset, offset + BATCH_SIZE);
        const ids = [...new Set(page.map((request) => request.userId))];
        const rows = await prisma.tournament.findMany({
          where: {
            status: { not: "CANCELLED" },
            participants: {
              some: {
                userId: { in: ids },
                status: { in: ["ACCEPTED", "INVITED"] },
              },
            },
          },
          include: page[0].include,
          orderBy: { createdAt: "desc" },
        });
        for (const request of page) {
          request.resolve((rows || []).filter((tournament) =>
            (tournament.participants || []).some((participant) =>
              participant.userId === request.userId && (
                participant.status === "ACCEPTED" ||
                (participant.status === "INVITED" && tournament.status === "PENDING")
              ))));
        }
      }
    });
    return promise;
  }
  return { load };
}

const tournamentForUserReadBatch = createTournamentForUserReadBatch();

module.exports = {
  BATCH_SIZE,
  createTournamentForUserReadBatch,
  tournamentForUserReadBatch,
};
