// Local-only real HTTP/scheduled-worker replay. Never production.
const assert = require('node:assert/strict');
const { resolve, join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { Client } = require('pg');
const db = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(db.hostname));
assert.match(db.pathname, /_test$/);
assert.equal(process.env.NODE_ENV, 'test');
const redisUrl = new URL(process.env.REDIS_URL);
assert.ok(['localhost', '127.0.0.1'].includes(redisUrl.hostname));
assert.equal(redisUrl.pathname, '/15');
process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
process.env.CACHE_ENV_PREFIX = `test:deadline-loaded:${randomUUID()}:`;
const root = resolve(process.argv[2]);
const output = process.argv[3];
const population = Number(process.argv[4] || 100);
assert.ok([100, 1000].includes(population));
const { prisma, cleanDatabase, startServer, createTestUser, request } = require(join(root, 'test/integration/setup'));
const { scheduleRaceEffectDeadlineScheduler, scheduleRaceResolutionWorkerV2,
  scheduleRaceResolutionPostTaskRunner } = require(join(root, 'src/modules/races'));
const redisCache = require(join(root, 'src/shared/cache/redisCache'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const queries = [];
let phase = null;
prisma.$on('query', event => { if (phase) queries.push({ phase, sql: event.query, ms: event.duration }); });
async function bounded(items, action) {
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < items.length) await action(items[next++]);
  }));
}
async function until(check, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await sleep(25); }
  throw new Error('scheduled durable work did not converge');
}
(async () => {
  await cleanDatabase();
  const server = await startServer();
  const observer = new Client({ connectionString: db.toString() });
  await observer.connect();
  let scheduler, worker, post;
  try {
    // Local measurement-only audit survives effect/deadline deletion. Identical
    // overhead in both variants; it is never part of the application migration.
    await observer.query(`CREATE TABLE IF NOT EXISTS deadline_replay_observations(effect_id text PRIMARY KEY, latency_ms double precision);
      TRUNCATE deadline_replay_observations;
      CREATE OR REPLACE FUNCTION deadline_replay_observe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.dispatched_revision=NEW.revision AND NEW.dispatched_at IS NOT NULL THEN
          INSERT INTO deadline_replay_observations VALUES(NEW.effect_id,EXTRACT(EPOCH FROM(NEW.dispatched_at-NEW.deadline_at))*1000)
          ON CONFLICT(effect_id) DO UPDATE SET latency_ms=EXCLUDED.latency_ms;
        END IF; RETURN NEW; END $$;
      DROP TRIGGER IF EXISTS deadline_replay_observe ON race_effect_deadlines;
      CREATE TRIGGER deadline_replay_observe AFTER UPDATE ON race_effect_deadlines FOR EACH ROW EXECUTE FUNCTION deadline_replay_observe()`);
    const viewers = [];
    for (let i = 0; i < population; i++) viewers.push(await createTestUser({ timezone: 'UTC' }));
    const startedAt = new Date(Date.now() - 3600000);
    const endsAt = new Date(Date.now() + 86400000);
    const races = Array.from({ length: 10 }, (_, i) => ({ id: randomUUID(), creatorId: viewers[i].user.id,
      name: 'Local deadline replay', status: 'ACTIVE', targetSteps: 200000, timezone: 'UTC',
      startedAt, endsAt, powerupsEnabled: true, powerupStepInterval: 5000 }));
    await prisma.race.createMany({ data: races });
    const participants = viewers.map((viewer, i) => ({ id: randomUUID(), raceId: races[i % 10].id,
      userId: viewer.user.id, status: 'ACCEPTED', nextBoxAtSteps: 5000, joinedAt: startedAt }));
    await prisma.raceParticipant.createMany({ data: participants });
    const packs = participants.map(p => ({ id: randomUUID(), raceId: p.raceId, participantId: p.id,
      userId: p.userId, type: 'FANNY_PACK', rarity: 'RARE', status: 'HELD', earnedAtSteps: 0 }));
    await prisma.racePowerup.createMany({ data: packs });
    await bounded(viewers.map((viewer, i) => ({ viewer, pack: packs[i] })), async ({ viewer, pack }) => {
      const res = await request(server.baseUrl, 'POST', `/races/${pack.raceId}/powerups/${pack.id}/use`,
        { token: viewer.token, body: {} });
      assert.equal(res.status, 200);
    });
    phase = 'mixed_sync_deadline_workers';
    scheduler = scheduleRaceEffectDeadlineScheduler();
    worker = scheduleRaceResolutionWorkerV2({ bootAt: 0 });
    post = scheduleRaceResolutionPostTaskRunner();
    // Startup recovery is deliberately included in the mixed-work measurement.
    const deadline = new Date();
    await prisma.raceActiveEffect.updateMany({ where: { status: 'ACTIVE' }, data: { expiresAt: deadline } });
    const syncStarted = Date.now();
    await bounded(viewers, async viewer => {
      const now = Date.now();
      const res = await request(server.baseUrl, 'POST', '/steps/sync-v2', {
        token: viewer.token, headers: { 'Idempotency-Key': randomUUID(), 'X-Timezone': 'UTC' },
        body: { date: new Date(now).toISOString().slice(0, 10), steps: 100,
          samples: [{ periodStart: new Date(now - 1800000).toISOString(),
            periodEnd: new Date(now - 1500000).toISOString(), steps: 100 }] } });
      assert.equal(res.status, 202);
    });
    const syncElapsedMs = Date.now() - syncStarted;
    await until(async () => Number((await observer.query('SELECT count(*) AS n FROM deadline_replay_observations')).rows[0].n) === population);
    const dispatchMs = (await observer.query('SELECT latency_ms AS ms FROM deadline_replay_observations ORDER BY ms')).rows.map(row => Number(row.ms));
    phase = 'downstream_drain';
    await until(async () => Number((await observer.query("SELECT count(*) AS n FROM race_active_effects WHERE status='active_effect'")).rows[0].n) === 0);
    const queueState = async () => (await observer.query(`SELECT
      (SELECT count(*) FROM race_resolution_jobs_v2 WHERE state::text<>'succeeded' OR committed_generation<generation) AS jobs,
      (SELECT count(*) FROM race_resolution_post_tasks WHERE state IN ('queued','running')) AS tasks,
      (SELECT count(*) FROM race_progress_refresh_intents) AS refresh,
      (SELECT count(*) FROM race_snapshot_repair_intents WHERE terminal_at IS NULL) AS repairs,
      (SELECT count(*) FROM race_resolution_jobs_v2 j WHERE EXISTS (
        SELECT 1 FROM race_resolution_post_tasks t WHERE t.race_id=j.race_id AND t.source_generation>=j.committed_generation AND t.snapshot_state='succeeded'
        UNION ALL SELECT 1 FROM race_resolution_post_task_receipts t WHERE t.race_id=j.race_id AND t.source_generation>=j.committed_generation AND t.snapshot_state='succeeded')) AS published`)).rows[0];
    await until(async () => { const q = await queueState(); return ['jobs','tasks','refresh','repairs'].every(k => Number(q[k]) === 0) && Number(q.published) === 10; });
    const remainingQueues = await queueState();
    await worker.stop(); worker = null;
    await post.stop(); post = null;
    await scheduler.stop(); scheduler = null;
    phase = 'http_verify';
    for (let i = 0; i < viewers.length; i++) {
      for (const features of ['powerups3', 'powerups3,powerups4,powerups5']) {
        const res = await request(server.baseUrl, 'GET', `/races/${participants[i].raceId}/progress`, {
          token: viewers[i].token, headers: { 'X-Timezone': 'UTC', 'X-Client-Features': features } });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.progress.powerupData.powerupSlots, 3);
        assert.equal(body.progress.powerupData.activeEffects.length, 0);
        assert.equal(body.progress.participants.find(p => p.userId === viewers[i].user.id).totalSteps, 100);
      }
    }
    const counts = {};
    for (const q of queries) {
      const key = `${q.phase}:${q.sql.match(/^\s*(SELECT|UPDATE|INSERT|DELETE|BEGIN|COMMIT|ROLLBACK)/i)?.[1]?.toUpperCase() || 'OTHER'}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    writeFileSync(output, JSON.stringify({ population, races: 10, syncElapsedMs,
      dispatchMedianMs: dispatchMs[Math.floor(dispatchMs.length / 2)],
      dispatchP95Ms: dispatchMs[Math.ceil(dispatchMs.length * 0.95) - 1],
      counts, totalQueries: queries.length, remainingQueues, httpOutcomes: 'all old/current users: score100, slots3, no effects',
      note: 'Real HTTP activation/sync/progress and default scheduled workers with local Redis. Four concurrent HTTP requests overlap deadline/resolution/publication and startup recovery. Audit trigger adds one local measurement write per dispatch in both variants; observer/setup commands excluded, nested trigger statements not counted in application commands. Publication proven by successful current-generation task/receipt before HTTP verification. Local warm replay only.' }, null, 2) + '\n');
  } finally {
    await scheduler?.stop(); await worker?.stop(); await post?.stop();
    await observer.query('DROP TRIGGER IF EXISTS deadline_replay_observe ON race_effect_deadlines; DROP FUNCTION IF EXISTS deadline_replay_observe(); DROP TABLE IF EXISTS deadline_replay_observations');
    await redisCache.close();
    await observer.end(); await server.close(); await prisma.$disconnect();
  }
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
