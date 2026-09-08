// Local experiment process entrypoint. No production environment is sourced.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const sourceRoot = path.resolve(process.argv[2]);
const role = process.argv[3];
const arm = process.argv[4];
const dbUrl = new URL(process.env.DATABASE_URL);
const redisUrl = new URL(process.env.REDIS_URL);
if (!['localhost', '127.0.0.1'].includes(dbUrl.hostname) || !dbUrl.pathname.endsWith('_test') ||
    dbUrl.port !== '55445' || redisUrl.hostname !== '127.0.0.1' || redisUrl.port !== '16389' ||
    fs.existsSync(path.join(sourceRoot, '.env'))) throw new Error('Dedicated local experiment environment required');
delete process.env.NODE_TEST_CONTEXT;
const fromSource = (name) => require(path.join(sourceRoot, name));
const { prisma, getDbPoolPressure } = fromSource('src/db');
let queries = 0;
prisma.$on('query', () => { queries += 1; });
const useModule = fromSource('src/modules/powerups/commands/usePowerup');
const originalUse = useModule.usePowerup;
useModule.usePowerup = (args) => originalUse({ ...args, onPerformanceContext(context) {
  process.send?.({ type: 'commandStart', powerupId: args.powerupId, raceId: args.raceId,
    at: Date.now(), monotonicNs: process.hrtime.bigint().toString(), ...context });
  args.onPerformanceContext?.(context);
} });
let queue;
if (arm === 'C' || arm === 'D') {
  const { createPowerupCommandQueue } = require('./queue');
  queue = createPowerupCommandQueue({ mode: arm === 'C' ? 'SINGLE' : 'BATCH', batchSize: arm === 'C' ? 1 : 4 });
}
const handles = [];
let server;
let stopping = false;
const loops = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startedAt = performance.now();
const cpuStarted = process.cpuUsage();
function metrics() {
  const cpu = process.cpuUsage(cpuStarted);
  return { type: 'metrics', role, at: Date.now(), elapsedMs: performance.now() - startedAt,
    queries, cpuMs: (cpu.user + cpu.system) / 1000, rss: process.memoryUsage().rss,
    pool: getDbPoolPressure(), queueMetrics: queue?.metrics,
    budget: role === 'worker' ? fromSource('src/modules/races/services/raceResolutionWorkBudget').raceResolutionWorkBudget.snapshot() : null };
}
async function main() {
  if (role === 'http') {
    server = await fromSource('test/integration/setup').startServer(queue ? { usePowerup: (args) => queue.execute(args) } : {});
  } else {
    handles.push(fromSource('src/modules/races/jobs/raceResolutionQueueV2').scheduleRaceResolutionWorkerV2());
    handles.push(fromSource('src/modules/races/jobs/raceResolutionPostTaskRunner').scheduleRaceResolutionPostTaskRunner());
    handles.push(fromSource('src/modules/races/jobs/racePlacementTransitionWorker').scheduleRacePlacementTransitionWorker());
    if (queue) for (let lane = 0; lane < 3; lane += 1) {
      loops.push((async () => {
        while (!stopping) {
          try { if (!await queue.tick()) await delay(50); }
          catch (error) { console.error('COMMAND_WORKER_ERROR', error); await delay(100); }
        }
      })());
    }
  }
  process.send?.({ type: 'ready', baseUrl: server?.baseUrl });
  const timer = setInterval(() => process.send?.(metrics()), 1000);
  process.on('message', async (message) => {
    if (message.type === 'sample') process.send?.({ ...metrics(), sampleId: message.sampleId });
    if (message.type !== 'stop' || stopping) return;
    stopping = true;
    clearInterval(timer);
    await Promise.allSettled(loops);
    for (const handle of handles) await handle?.stop?.();
    await server?.close();
    process.send?.(metrics());
    await prisma.$disconnect();
    process.exit(0);
  });
}
main().catch((error) => { console.error(error); process.exit(1); });
