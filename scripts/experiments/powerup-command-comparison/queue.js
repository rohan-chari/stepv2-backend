// LOCAL EXPERIMENT ONLY. Not imported by application startup.
const { randomUUID, createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { prisma, runInPrismaTransaction, withPrismaSavepoint, withScopedPrismaClient } = require('../../../src/db');
const { usePowerup, refundRedeemedOnRejection, withPowerupRandom, withPowerupPostTasks } = require('../../../src/modules/powerups/commands/usePowerup');
const { RacePowerup } = require('../../../src/modules/powerups/models/racePowerup');
const { acquireRaceWriteFence } = require('../../../src/modules/races/services/raceWriteFence');
const { raceResolutionWorkBudget } = require('../../../src/modules/races/services/raceResolutionWorkBudget');
const { makeBatchClient, BATCH_TYPES } = require('./queueBatch');
const { enqueueRaceResolution } = require('../../../src/modules/races/services/enqueueRaceResolution');
const { repairRacePowerupInventory } = require('../../../src/modules/races/services/racePowerupInventoryRepair');
const { invalidateRaceProgress } = require('../../../src/modules/races/services/raceProgressSnapshot');
const BUSY = { error: 'Powerup service busy. Please try again.' };
function guard() {
  const u = new URL(process.env.DATABASE_URL);
  if (!['localhost', '127.0.0.1', '::1'].includes(u.hostname) || !decodeURIComponent(u.pathname).endsWith('_test')) throw new Error('Queue experiment requires localhost *_test database');
}
async function installQueueSchema() {
  guard();
  await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS experiment_powerup_admissions(race_id text PRIMARY KEY,next_sequence bigint NOT NULL DEFAULT 1)');
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS experiment_powerup_inboxes (
    race_id text PRIMARY KEY, next_sequence bigint NOT NULL DEFAULT 1,
    completed_sequence bigint NOT NULL DEFAULT 0, lease_token text, lease_until timestamptz)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS experiment_powerup_commands (
    id text PRIMARY KEY, race_id text NOT NULL, sequence bigint NOT NULL,
    user_id text NOT NULL, powerup_id text NOT NULL, payload jsonb NOT NULL, fingerprint text NOT NULL,
    accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 seconds',
    state text NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0, lease_token text,
    status int, body jsonb, applied_at timestamptz, started_at timestamptz, random_draws jsonb, force_boundary boolean NOT NULL DEFAULT false, UNIQUE(race_id,sequence))`);
  await prisma.$executeRawUnsafe('ALTER TABLE experiment_powerup_commands ADD COLUMN IF NOT EXISTS started_at timestamptz, ADD COLUMN IF NOT EXISTS random_draws jsonb, ADD COLUMN IF NOT EXISTS force_boundary boolean NOT NULL DEFAULT false');
  await prisma.$executeRawUnsafe("ALTER TABLE experiment_powerup_commands ADD COLUMN IF NOT EXISTS post_tasks jsonb NOT NULL DEFAULT '[]', ADD COLUMN IF NOT EXISTS post_done boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS post_token text, ADD COLUMN IF NOT EXISTS post_until timestamptz, ADD COLUMN IF NOT EXISTS post_attempts int NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS post_error text");
  await prisma.$executeRawUnsafe("CREATE UNIQUE INDEX IF NOT EXISTS experiment_powerup_inflight ON experiment_powerup_commands(powerup_id) WHERE state IN ('pending','running')");
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS experiment_powerup_pending ON experiment_powerup_commands(race_id,sequence,state)');
}
function canonical(value) {
  if (value instanceof Set) return [...value].sort().map(canonical);
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined && typeof value[k] !== 'function').map(k => [k, canonical(value[k])]));
  return value;
}
function response(result) {
  if (result?.scan) return { ok: true, scan: result.scan, result };
  return { result, ...(result?.activeImpactReceipt ? { activeImpactReceipt: result.activeImpactReceipt } : {}) };
}
function errorBody(error) { return { error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.powerupType ? { powerupType: error.powerupType } : {}) }; }
function commandRandom(id) {
  let seed = createHash('sha256').update(id).digest().readUInt32LE();
  return () => { seed += 0x6D2B79F5; let t = seed; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function unwrap(row) {
  if (row.status === 200) return row.body.result;
  const error = new Error(row.body.error); error.name = 'PowerupUseError'; error.statusCode = row.status;
  Object.assign(error, row.body); throw error;
}
function createPowerupCommandQueue({ mode = 'SINGLE', batchSize = 1, workBudget = raceResolutionWorkBudget, maxPending = 256, afterGameplayCommit = null } = {}) {
  guard();
  if (!['SINGLE', 'BATCH'].includes(mode) || ![1,4,8].includes(batchSize)) throw new Error('Invalid experiment arm');
  const metrics = { commands: 0, batches: 0, occupancies: [], sharedReads: 0, bulkFeedRows: 0, expired: 0, retries: 0, boundaries: 0 };
  async function enqueue(args) {
    const payload = canonical(args); const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return runInPrismaTransaction(async tx => {
      // Short global admission latch makes the configured bounded inbox exact.
      // It is independent of gameplay fences and never held while executing.
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(734221891)');
      const item = await tx.racePowerup.findUnique({ where: { id: payload.powerupId }, select: { userId: true, raceId: true } });
      if (!item) return { status: 404, body: { error: 'Powerup not found' } };
      if (item.userId !== payload.userId || item.raceId !== payload.raceId) return { status: 403, body: { error: 'This powerup does not belong to you' } };
      const existing = await tx.$queryRawUnsafe("SELECT * FROM experiment_powerup_commands WHERE powerup_id=$1 AND user_id=$2 ORDER BY accepted_at DESC,sequence DESC LIMIT 1", payload.powerupId, payload.userId);
      if (existing[0]) {
        const row = existing[0];
        if (['pending','running'].includes(row.state)) {
          if (row.fingerprint !== fingerprint) return { status: 409, body: { error: 'A different use of this powerup is already pending.' } };
          return row;
        }
        if (row.status === 200 && row.fingerprint === fingerprint) return row;
      }
      const [{ count }] = await tx.$queryRawUnsafe("SELECT count(*)::int AS count FROM experiment_powerup_commands WHERE state IN ('pending','running') OR (status=200 AND NOT post_done)");
      if (count >= maxPending) return { status: 503, body: BUSY };
      await tx.$executeRawUnsafe('INSERT INTO experiment_powerup_admissions(race_id) VALUES($1) ON CONFLICT DO NOTHING', payload.raceId);
      const [{ next_sequence: sequence }] = await tx.$queryRawUnsafe('UPDATE experiment_powerup_admissions SET next_sequence=next_sequence+1 WHERE race_id=$1 RETURNING next_sequence-1 AS next_sequence', payload.raceId);
      const [row] = await tx.$queryRawUnsafe('INSERT INTO experiment_powerup_commands(id,race_id,sequence,user_id,powerup_id,payload,fingerprint) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *', randomUUID(), payload.raceId, sequence, payload.userId, payload.powerupId, JSON.stringify(payload), fingerprint);
      return row;
    }, { timeout: 10000 });
  }
  async function wait(id) {
    // Poll without retaining a connection between reads; the durable row is
    // authoritative across two HTTP processes and a worker restart.
    for (;;) {
      const [row] = await prisma.$queryRawUnsafe('SELECT id,state,status,body,post_done FROM experiment_powerup_commands WHERE id=$1', id);
      if (!row) throw new Error('Command disappeared');
      if (row.status != null && (row.status !== 200 || row.post_done)) return row;
      await delay(20);
    }
  }
  async function execute(args) {
    const admitted = await enqueue(args);
    return unwrap(admitted.status != null && (admitted.status !== 200 || admitted.post_done) ? admitted : await wait(admitted.id));
  }
  async function claim() {
    return runInPrismaTransaction(async tx => {
      await tx.$executeRawUnsafe("INSERT INTO experiment_powerup_inboxes(race_id) SELECT DISTINCT race_id FROM experiment_powerup_commands WHERE state IN ('pending','running') ON CONFLICT DO NOTHING");
      const [lane] = await tx.$queryRawUnsafe(`SELECT i.* FROM experiment_powerup_inboxes i
        WHERE (lease_until IS NULL OR lease_until <= clock_timestamp()) AND EXISTS
        (SELECT 1 FROM experiment_powerup_commands c WHERE c.race_id=i.race_id AND c.state IN ('pending','running'))
        ORDER BY (SELECT min(accepted_at) FROM experiment_powerup_commands c WHERE c.race_id=i.race_id AND c.state IN ('pending','running'))
        FOR UPDATE OF i SKIP LOCKED LIMIT 1`);
      if (!lane) return null;
      const token = randomUUID();
      await tx.$executeRawUnsafe("UPDATE experiment_powerup_inboxes SET lease_token=$2,lease_until=clock_timestamp()+interval '40 seconds' WHERE race_id=$1", lane.race_id, token);
      // A running command's transaction either rolled back or committed its
      // durable terminal row. Only the former remains eligible for recovery.
      await tx.$executeRawUnsafe("UPDATE experiment_powerup_commands SET state='pending',lease_token=NULL WHERE race_id=$1 AND state='running'", lane.race_id);
      // Persist the execution attempt before gameplay begins. A process death
      // before commit must still count toward the poison-command limit.
      await tx.$executeRawUnsafe(`UPDATE experiment_powerup_commands SET attempts=attempts+1,state='running',lease_token=$2,started_at=coalesce(started_at,clock_timestamp())
        WHERE id=(SELECT id FROM experiment_powerup_commands WHERE race_id=$1 AND state='pending' ORDER BY sequence LIMIT 1)
        AND (expires_at>clock_timestamp() OR attempts>0)`, lane.race_id, token);
      return { raceId: lane.race_id, token };
    });
  }
  async function runClaim(lease) {
    const started = Date.now();
    const outcome = await runInPrismaTransaction(async tx => {
      await acquireRaceWriteFence(tx, lease.raceId);
      const [lane] = await tx.$queryRawUnsafe('SELECT *,lease_until > clock_timestamp() AS live FROM experiment_powerup_inboxes WHERE race_id=$1 FOR UPDATE', lease.raceId);
      if (!lane || lane.lease_token !== lease.token || !lane.live) throw new Error('Stale command lease');
      const rows = await tx.$queryRawUnsafe(`SELECT c.*,p.type::text AS type FROM experiment_powerup_commands c
        LEFT JOIN race_powerups p ON p.id=c.powerup_id WHERE c.race_id=$1 AND c.sequence>$2
        AND c.state IN ('pending','running') ORDER BY c.sequence LIMIT $3`, lease.raceId, lane.completed_sequence, mode === 'BATCH' ? batchSize : 1);
      if (!rows.length) { await tx.$executeRawUnsafe('UPDATE experiment_powerup_inboxes SET lease_token=NULL,lease_until=NULL WHERE race_id=$1', lease.raceId); return { size: 0 }; }
      const normalize = s => String(s || '').toUpperCase();
      const batchable = r => !r.force_boundary && BATCH_TYPES.has(normalize(r.type));
      const safe = mode === 'BATCH' && batchable(rows[0]);
      const boundaryIndex = rows.findIndex(r => !batchable(r));
      const selected = safe ? rows.slice(0, boundaryIndex < 0 ? rows.length : boundaryIndex) : rows.slice(0,1);
      if (safe) {
        // Acquire the complete batch dependency set before any command mutates
        // it, using the existing lifecycle -> item -> participant order.
        await tx.$queryRawUnsafe('SELECT id FROM races WHERE id=$1 FOR UPDATE', lease.raceId);
        await tx.$queryRawUnsafe('SELECT id FROM race_powerups WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', selected.map(r => r.powerup_id));
        await tx.$queryRawUnsafe('SELECT id FROM race_participants WHERE race_id=$1 AND user_id=ANY($2::text[]) ORDER BY user_id FOR UPDATE', lease.raceId, selected.map(r => r.user_id));
      }
      const batch = safe ? makeBatchClient(tx, metrics) : null;
      const client = batch?.client || tx;
      let cursor = BigInt(lane.completed_sequence), completed = 0; const resolutions = [];
      for (const row of selected) {
        if (BigInt(row.sequence) !== cursor + 1n) throw new Error('Noncontiguous command prefix');
        const changed = await tx.$queryRawUnsafe(`UPDATE experiment_powerup_commands SET state=CASE WHEN expires_at<=clock_timestamp() AND attempts=0 THEN 'expired' WHEN attempts>3 THEN 'failed' ELSE 'running' END,
          status=CASE WHEN expires_at<=clock_timestamp() AND attempts=0 THEN 503 WHEN attempts>3 THEN 500 ELSE NULL END,
          body=CASE WHEN expires_at<=clock_timestamp() AND attempts=0 THEN $3::jsonb WHEN attempts>3 THEN '{"error":"Internal server error"}'::jsonb ELSE NULL END,
          attempts=CASE WHEN state='running' THEN attempts ELSE attempts+1 END,started_at=coalesce(started_at,clock_timestamp()),lease_token=$2 WHERE id=$1 AND state IN ('pending','running') RETURNING *`, row.id, lease.token, JSON.stringify(BUSY));
        if (!changed.length) throw new Error('Command claim changed');
        let status = changed[0].status, body = changed[0].body; const draws = [], postTasks = [];
        if (status == null) {
          const checkpoint = batch?.checkpoint();
          try {
            const rng = commandRandom(row.id);
            const result = await withPowerupPostTasks((kind,args) => { postTasks.push({ kind,args }); }, () => withPowerupRandom(() => { const draw = rng(); draws.push(draw); return draw; }, () => withScopedPrismaClient(client, () => withPrismaSavepoint(() => usePowerup(row.payload)))));
            status = 200; body = response(result);
          } catch (error) {
            batch?.restore(checkpoint);
            postTasks.length = 0;
            if (error.name !== 'PowerupUseError') { error.queueCommandId = row.id; throw error; }
            // The failed command savepoint discards its partial overlay and
            // callbacks. Preserve the normal redeemed-item rejection refund.
            try { await withPrismaSavepoint(() => refundRedeemedOnRejection({ db: prisma, powerupModel: RacePowerup, ...row.payload })); } catch { /* Preserve the ordinary best-effort refund contract. */ }
            status = error.statusCode || 400; body = errorBody(error);
          }
        } else if (status === 503) metrics.expired++;
        resolutions.push(...postTasks.filter(task => task.kind === 'resolution'));
        const durablePosts = postTasks.filter(task => task.kind !== 'resolution');
        try {
          await tx.$executeRawUnsafe("UPDATE experiment_powerup_commands SET state='terminal',status=$2,body=$3::jsonb,applied_at=clock_timestamp(),random_draws=$5::jsonb,post_tasks=$6::jsonb,post_done=$7 WHERE id=$1 AND lease_token=$4", row.id, status, JSON.stringify(body), lease.token, JSON.stringify(draws), JSON.stringify(durablePosts), durablePosts.length === 0);
        } catch (error) { error.queueCommandId = row.id; throw error; }
        cursor = BigInt(row.sequence); completed++;
      }
      if (batch) await batch.flush();
      // Durable scoring handoff shares the exact gameplay/result commit. The
      // canonical enqueue knows how to merge triggers and publish after commit.
      for (const task of resolutions) await enqueueRaceResolution(task.args[0], tx);
      await tx.$executeRawUnsafe('UPDATE experiment_powerup_inboxes SET completed_sequence=$2,lease_token=NULL,lease_until=NULL WHERE race_id=$1 AND lease_token=$3', lease.raceId, cursor, lease.token);
      return { size: completed, boundary: !safe };
    }, { maxWait: 5000, timeout: 30000 });
    metrics.commands += outcome.size; metrics.batches++; metrics.occupancies.push(outcome.size);
    if (outcome.boundary) metrics.boundaries++;
    metrics.lastExecutionMs = Date.now() - started;
    if (afterGameplayCommit) await afterGameplayCommit(outcome);
    while (await finishOnePost(lease.raceId)) { /* drain this batch's response work */ }
    return outcome;
  }
  async function finishOnePost(raceId = null) {
    const token = randomUUID();
    const [row] = await prisma.$queryRawUnsafe(`UPDATE experiment_powerup_commands SET post_token=$1,post_until=clock_timestamp()+interval '40 seconds',post_attempts=post_attempts+1
      WHERE id=(SELECT id FROM experiment_powerup_commands WHERE status=200 AND NOT post_done AND ($2::text IS NULL OR race_id=$2)
      AND (post_until IS NULL OR post_until<=clock_timestamp()) ORDER BY accepted_at,sequence FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, token, raceId);
    if (!row) return false;
    try {
      await runInPrismaTransaction(async tx => {
        // Fenced recovery prevents an expired post owner from replaying the
        // canonical queued-box promotion after its replacement has run.
        await acquireRaceWriteFence(tx, row.race_id);
        const [owned] = await tx.$queryRawUnsafe('SELECT post_token,post_until>clock_timestamp() AS live,post_done FROM experiment_powerup_commands WHERE id=$1 FOR UPDATE', row.id);
        if (!owned || owned.post_token !== token || !owned.live || owned.post_done) throw new Error('Stale post lease');
        for (const task of row.post_tasks) {
          if (task.kind === 'inventory') await repairRacePowerupInventory(...task.args);
          else if (task.kind === 'invalidation') await invalidateRaceProgress(...task.args);
          else throw new Error('Unknown durable post task');
        }
        await tx.$executeRawUnsafe('UPDATE experiment_powerup_commands SET post_done=true,post_token=NULL,post_until=NULL,post_error=NULL WHERE id=$1 AND post_token=$2', row.id, token);
      }, { maxWait: 5000, timeout: 15000 });
    } catch (error) {
      await prisma.$executeRawUnsafe("UPDATE experiment_powerup_commands SET post_token=NULL,post_until=clock_timestamp()+interval '1 second',post_error=$3 WHERE id=$1 AND post_token=$2", row.id, token, error.message);
      metrics.lastPostError = error.message;
    }
    return true;
  }
  async function tick() {
    return workBudget.run('core', async () => {
      if (await finishOnePost()) return true;
      const lease = await claim(); if (!lease) return false;
      try { await runClaim(lease); }
      catch (error) {
        if (/Stale command lease/.test(error.message)) return false;
        metrics.retries++;
        // Failed gameplay transactions have no terminal result. Count attempts
        // durably only after rollback; the held lease prevents another owner
        // from admitting a retry until this fenced recovery completes.
        await runInPrismaTransaction(async tx => {
          await acquireRaceWriteFence(tx, lease.raceId);
          const [lane] = await tx.$queryRawUnsafe('SELECT * FROM experiment_powerup_inboxes WHERE race_id=$1 FOR UPDATE', lease.raceId);
          if (lane.lease_token !== lease.token) return;
          if (error.queueCommandId) await tx.$executeRawUnsafe("UPDATE experiment_powerup_commands SET force_boundary=true,attempts=attempts+CASE WHEN state='pending' THEN 1 ELSE 0 END WHERE id=$1", error.queueCommandId);
          await tx.$executeRawUnsafe("UPDATE experiment_powerup_commands SET state='pending',lease_token=NULL WHERE race_id=$1 AND state='running'", lease.raceId);
          await tx.$executeRawUnsafe('UPDATE experiment_powerup_inboxes SET lease_token=NULL,lease_until=NULL WHERE race_id=$1', lease.raceId);
        });
        metrics.lastError = error.message;
      }
      return true;
    });
  }
  async function snapshot() { return prisma.$queryRawUnsafe("SELECT CASE WHEN status=200 AND NOT post_done THEN 'post_pending' ELSE state END AS state,count(*)::int AS count FROM experiment_powerup_commands GROUP BY 1"); }
  return { enqueue, wait, execute, claim, runClaim, tick, metrics, snapshot };
}
module.exports = { installQueueSchema, createPowerupCommandQueue, BUSY };
