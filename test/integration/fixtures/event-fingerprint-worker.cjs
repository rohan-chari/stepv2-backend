// Exercise the worker's public tick in a separate process with real services.
process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
const { reads } = require('./observe-event-fingerprint.cjs');
const { prisma } = require('../../../src/db');
const { buildRaceResolutionWorkerV2 } = require('../../../src/modules/races/jobs/raceResolutionQueueV2');
const queries = [];
prisma.$on('query', event => queries.push(event.query));
(async () => {
  const count = await buildRaceResolutionWorkerV2({ bootAt: 0 }).tick();
  await new Promise((resolve, reject) => process.send({ count, reads, queries }, error => error ? reject(error) : resolve()));
  await prisma.$disconnect();
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
