// Managed raw-SQL review maintenance. The manifest survives CLI exit and can
// replay cache recovery without repeating destructive database operations.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Client } = require('pg');
const redis = require('../src/shared/cache/redisCache');
const derived = require('../src/shared/cache/derivedCache');
const keys = require('../src/shared/cache/cacheKeys');
const efficiency = require('../src/shared/cache/cacheEfficiencyInvalidation');
const CAP = 5000;
function targetIdentity() {
  const url = new URL(process.env.DATABASE_URL);
  const cache = new URL(process.env.REDIS_URL);
  const identity = { database: `${url.hostname}:${url.port || 5432}${url.pathname}`, redis: `${cache.protocol}//${cache.hostname}:${cache.port || 6379}${cache.pathname || '/0'}`, prefix: process.env.CACHE_ENV_PREFIX || '' };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
function clientForTarget() {
  const url = new URL(process.env.DATABASE_URL);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  url.searchParams.delete('sslmode');
  return new Client({ connectionString: url.toString(), ...(local ? {} : { ssl: { rejectUnauthorized: false } }) });
}
async function capture(client) {
  const result = await client.query(`
    WITH review AS (SELECT id FROM users WHERE is_review_account=true OR apple_id='review-account-v1'),
    affected_races AS (
      SELECT id FROM races WHERE creator_id IN (SELECT id FROM review)
      UNION SELECT race_id FROM race_participants WHERE user_id IN (SELECT id FROM review)
    ), affected_users AS (
      SELECT id FROM review
      UNION SELECT requester_id FROM friendships WHERE addressee_id IN (SELECT id FROM review)
      UNION SELECT addressee_id FROM friendships WHERE requester_id IN (SELECT id FROM review)
      UNION SELECT user_id FROM race_participants WHERE race_id IN (SELECT id FROM affected_races)
    )
    SELECT json_build_object(
      'users',(SELECT coalesce(json_agg(id),'[]') FROM (SELECT id FROM affected_users LIMIT ${CAP + 1}) q),
      'races',(SELECT coalesce(json_agg(q),'[]') FROM (SELECT id,updated_at AS "resultVersion" FROM races WHERE id IN (SELECT id FROM affected_races) LIMIT ${CAP + 1}) q),
      'participants',(SELECT coalesce(json_agg(q),'[]') FROM (SELECT id,race_id AS "raceId",user_id AS "userId" FROM race_participants WHERE race_id IN (SELECT id FROM affected_races) LIMIT ${CAP + 1}) q),
      'dates',(SELECT coalesce(json_agg(q),'[]') FROM (SELECT user_id AS "userId",date::text AS date FROM steps WHERE user_id IN (SELECT id FROM review) UNION SELECT user_id,claimed_date FROM step_milestone_claims WHERE user_id IN (SELECT id FROM review) LIMIT ${CAP + 1}) q)
    ) AS manifest`);
  const value = result.rows[0].manifest;
  if (Object.values(value).some(rows => rows.length > CAP)) throw new Error('Review maintenance identity cap exceeded; no changes committed');
  return value;
}
function merge(before, after) {
  return Object.fromEntries(Object.keys(before).map(name => [name,
    [...new Map([...before[name], ...after[name]].map(row => [JSON.stringify(row), row])).values()],
  ]));
}
async function invalidate(manifest) {
  const { users, races, participants, dates } = manifest;
  const entries = [
    ...users.flatMap(identity => ['list', 'invites', 'summary', 'entitlement', 'presentation'].map(domain => ({ domain, identity }))),
    ...races.flatMap(row => ['race-meta', 'race-members', 'event'].map(domain => ({ domain, identity: row.id }))),
    ...races.map(row => ({ domain: 'slots', identity: `race:${row.id}` })),
    ...participants.map(row => ({ domain: 'slots', identity: `participant:${row.id}` })),
    ...dates.map(row => ({ domain: 'milestones', identity: `${row.userId}:${row.date}` })),
  ];
  const results = [await efficiency.advance(entries)];
  // Keep concurrency bounded even if review users joined ordinary races.
  for (let offset = 0; offset < users.length; offset += 32) {
    const batch = users.slice(offset, offset + 32);
    results.push(...await Promise.all(batch.map(async id => {
      const values = await Promise.all([
        require('../src/modules/users/services/authMeCache').invalidate(id),
        require('../src/modules/social/services/friendsTopologyCache').invalidateUserSafe(id),
        require('../src/modules/social/services/userPresentationCache').invalidate(id),
        ...[[keys.userInventory(id), keys.PREFIX.USER_INVENTORY], [keys.userRecentMints(id), keys.PREFIX.USER_RECENT_MINTS], [keys.homeImpactSummary(id), keys.PREFIX.HOME_IMPACT_SUMMARY], [keys.homeActiveGlobalEvent(id), keys.PREFIX.HOME_ACTIVE_GLOBAL_EVENT]].map(([key, prefix]) => derived.invalidate({ keys: [key], prefix })),
      ]);
      return values.every(value => value !== false);
    })));
  }
  await require('../src/modules/races/services/raceListCache').invalidateUsers(users);
  for (const row of races) {
    results.push(await require('../src/modules/races/services/raceProgressSnapshot').invalidateRaceProgress(row.id));
    results.push(await require('../src/modules/social/services/raceMessagesCache').invalidateRace(row.id));
    results.push(await derived.invalidate({ keys: [keys.completedRaceSummary(row.id, new Date(row.resultVersion).toISOString())], prefix: keys.PREFIX.COMPLETED_RACE_SUMMARY }));
  }
  for (const row of dates) results.push(await require('../src/modules/steps/services/dailyStepsCache').invalidate(row.userId, row.date));
  return results.every(value => value !== false) && ![...Object.values(keys.PREFIX), efficiency.PREFIX].some(prefix => derived.isBypassed(prefix));
}
async function recover(manifestPath) {
  const stored = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (stored.schema !== 1 || stored.target !== targetIdentity()) throw new Error('Recovery manifest does not match database/Redis namespace target');
  if (!redis.isEnabled()) throw new Error('REDIS_URL is required for managed review maintenance');
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await invalidate(stored.identities)) {
      await fs.unlink(manifestPath);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Database phase may have committed; cache recovery incomplete. Replay only: node scripts/review-cache-maintenance.js --replay ${manifestPath}`);
}
async function runPhase(label, operation) {
  if (!process.env.DATABASE_URL || !redis.isEnabled()) throw new Error('DATABASE_URL and matching REDIS_URL/CACHE_ENV_PREFIX are required');
  const ping = await redis.evalLua('return 1');
  if (!ping.ok) throw new Error('Target Redis unavailable; no database changes attempted');
  const client = clientForTarget();
  await client.connect();
  let manifestPath;
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL app.cache_efficiency_managed = '1'");
    const before = await capture(client);
    await operation(client);
    const identities = merge(before, await capture(client));
    const directory = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'bara-cache-recovery');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    manifestPath = path.join(directory, `${label}-${randomUUID()}.json`);
    await fs.writeFile(manifestPath, JSON.stringify({ schema: 1, target: targetIdentity(), identities }), { mode: 0o600, flag: 'wx' });
    await client.query('COMMIT');
    committed = true;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    // A COMMIT acknowledgement can be lost. Retain any written manifest even
    // on error; replay is harmless after rollback and necessary after commit.
    if (manifestPath) error.message += `; recovery manifest: ${manifestPath}`;
    throw error;
  } finally { await client.end(); }
  if (committed) await recover(manifestPath);
}
async function runSqlPhase(label, filename) {
  const sql = (await fs.readFile(filename, 'utf8')).replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
  return runPhase(label, client => client.query(sql));
}
module.exports = { runPhase, runSqlPhase, recover };
if (require.main === module) {
  require('dotenv').config();
  const args = process.argv.slice(2);
  (async () => {
    if (args.length !== 2 || args[0] !== '--replay') throw new Error('Usage: node scripts/review-cache-maintenance.js --replay <manifest>');
    await recover(args[1]);
    console.log('Review cache recovery complete.');
  })().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
    await redis.close(); await require('../src/db').prisma.$disconnect();
      process.exit(process.exitCode || 0);
  });
}
