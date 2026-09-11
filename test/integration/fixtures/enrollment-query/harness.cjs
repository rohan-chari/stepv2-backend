const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');

// Validate before loading src/db (and therefore before dotenv can supply defaults).
function assertLocalTestDatabase() {
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'local test DB required');
  assert.match(decodeURIComponent(url.pathname), /_test$/, 'disposable _test DB required');
  assert.equal(process.env.NODE_ENV, 'test', 'explicit NODE_ENV=test required before dotenv');
  assert.equal(process.env.REDIS_URL, '', 'explicit REDIS_URL= required so dotenv cannot load remote Redis');
  return url;
}
assertLocalTestDatabase();
process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
const { prisma } = require('../../../../src/db');
const { cleanDatabase } = require('../../setup');
const { buildLocalGlobalStepEventTick, firstSafeLocalEventDay,
  EXPECTED_LOGICAL_OWNERS, GENERATION_CAPABILITIES } = require('../../../../src/modules/steps');
const baseline = readFileSync(join(__dirname, 'baseline.sql'), 'utf8').trim();
const candidate = `WITH active_users AS MATERIALIZED (
  SELECT DISTINCT participant.user_id
    FROM races race
    JOIN race_participants participant ON participant.race_id = race.id
   WHERE race.status = 'active'
     AND participant.status = 'accepted'
     AND participant.forfeited_at IS NULL
     AND participant.finished_at IS NULL
     AND ($3::text IS NULL OR participant.user_id > $3)
), enrollment_candidates AS MATERIALIZED (
  SELECT active.user_id FROM active_users active
   WHERE NOT EXISTS (
     SELECT 1 FROM global_step_event_entitlements entitlement
      WHERE entitlement.event_id = $1 AND entitlement.user_id = active.user_id
   )
   ORDER BY active.user_id LIMIT $2
)
SELECT person.id, person.timezone,
       person.global_event_timezone AS "globalEventTimezone"
  FROM enrollment_candidates candidate
  JOIN users person ON person.id = candidate.user_id
 ORDER BY person.id`;
const NOW = new Date('2098-01-01T00:00:00Z');
let observed = null;
prisma.$on('query', event => { if (observed) observed.push(event); });
const isCandidateQuery = event => event.query.includes('WITH') &&
  event.query.includes('enrollment_candidates') && !event.query.startsWith('EXPLAIN');

async function readyGeneration(now = NOW) {
  await prisma.globalStepEventCronOwner.createMany({ data: EXPECTED_LOGICAL_OWNERS.map(id => ({
    ownerId: `fixture:${id}`, logicalOwnerId: id, bootId: 'fixture', role: id.split(':')[0],
    generation: 2, localAware: true, capabilities: GENERATION_CAPABILITIES,
    heartbeatAt: now, expiresAt: new Date(+now + 3600_000),
  })), skipDuplicates: true });
  await prisma.globalStepEventGenerationState.upsert({ where: { id: 1 },
    create: { id: 1, readySince: new Date(+now - 120_000) },
    update: { readySince: new Date(+now - 120_000) } });
}

async function parents(now = NOW) {
  const day = firstSafeLocalEventDay(now);
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const events = [];
  for (const eventDay of [day, next.toISOString().slice(0, 10)]) {
    events.push(await prisma.globalStepEvent.create({ data: {
      id: `enrollment-${eventDay}`, eventDay, scheduleMode: 'LOCAL_ENTITLEMENTS',
      startsAt: new Date(`${eventDay}T00:00:00Z`),
      endsAt: new Date(`${eventDay}T23:59:00Z`),
      localStartMinute: 600, durationMinutes: 30, schedulePolicyVersion: 2,
      multiplier: 2,
    } }));
  }
  return events;
}

function entitlement(event, userId, extra = {}) {
  return { eventId: event.id, userId, timezone: 'UTC', localDate: event.eventDay,
    startsAt: new Date(`${event.eventDay}T10:00:00Z`),
    endsAt: new Date(`${event.eventDay}T10:30:00Z`), ...extra };
}

async function tick({ now = NOW, freezeBudget = false } = {}) {
  const realNow = Date.now;
  if (freezeBudget) Date.now = () => +now;
  observed = [];
  const start = performance.now();
  try {
    const result = await buildLocalGlobalStepEventTick({ now: () => now,
      logger: { log() {}, error(...args) { throw new Error(args.join(' ')); } } })();
    const events = observed;
    return { result, elapsedMs: performance.now() - start, events,
      pages: events.filter(isCandidateQuery), queryCount: events.length,
      counts: Object.fromEntries(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH', 'BEGIN', 'COMMIT', 'ROLLBACK', 'OTHER']
        .map(kind => [kind, events.filter(e => { const verb = e.query.trim().split(/\s+/)[0];
          return kind === 'OTHER' ? !['SELECT','INSERT','UPDATE','DELETE','WITH','BEGIN','COMMIT','ROLLBACK'].includes(verb) : verb === kind; }).length])) };
  } finally { observed = null; Date.now = realNow; }
}

// UUID-shaped, evenly interleaved deterministic IDs avoid favorable active/history ordering.
async function seedPerformance({ history = 30000, active = 1000, missing = 0, activeRaces = 3, historicalRaceSize = 100 } = {}) {
  await resetPerformance();
  const historicalUsers = 30000;
  await prisma.$executeRawUnsafe(`INSERT INTO users(id, timezone, global_event_timezone)
    SELECT md5('history-' || n)::uuid::text, 'UTC', 'UTC'
      FROM generate_series(1, $1::int) n`, historicalUsers);
  await prisma.$executeRawUnsafe(`INSERT INTO users(id, timezone, global_event_timezone)
    SELECT md5('active-' || n)::uuid::text, 'UTC', 'UTC'
      FROM generate_series(1, $1::int) n`, active);
  const rounds = Math.ceil(history / historicalRaceSize);
  const raceData = Array.from({ length: rounds }, (_, i) => ({ id: `history-race-${i}`,
    name: 'Historical benchmark', status: 'COMPLETED', targetSteps: 10000 }));
  raceData.push(...Array.from({ length: activeRaces }, (_, i) => ({ id: `active-race-${i}`, name: 'Active benchmark',
    status: 'ACTIVE', targetSteps: 10000, startedAt: new Date(+NOW - 3600_000),
    endsAt: new Date(+NOW + 7 * 86400000) })));
  await prisma.race.createMany({ data: raceData });
  // Enrollment triggers acquire transaction advisory locks per identity; bound fixture
  // writes too, instead of increasing production-like database lock capacity.
  for (let first = 1; first <= history; first += 1000) {
    await prisma.$executeRawUnsafe(`INSERT INTO race_participants(id,race_id,user_id,status)
      SELECT 'history-membership-' || n, 'history-race-' || ((n-1)/$3::int),
        md5('history-' || (((n-1)%30000)+1))::uuid::text, 'accepted'
      FROM generate_series($1::int, $2::int) n`, first, Math.min(history, first + 999), historicalRaceSize);
  }
  const memberships = Math.floor(active * 2.5);
  for (let first = 1; first <= memberships; first += 1000) {
    await prisma.$executeRawUnsafe(`INSERT INTO race_participants(id,race_id,user_id,status)
      SELECT 'active-membership-' || n, 'active-race-' || ((((n-1)%$1::int)+((n-1)/$1::int))%$4::int),
        md5('active-' || (((n-1)%$1::int)+1))::uuid::text, 'accepted'
      FROM generate_series($2::int, $3::int) n`, active, first, Math.min(memberships, first + 999), activeRaces);
  }
  const events = await parents();
  const activeUsers = await prisma.$queryRawUnsafe(`SELECT id FROM users
    WHERE id IN (SELECT md5('active-' || n)::uuid::text FROM generate_series(1,$1::int) n)
    ORDER BY id`, active);
  for (const event of events) {
    const rows = activeUsers.slice(missing).map(user => entitlement(event, user.id));
    for (let i = 0; i < rows.length; i += 1000) {
      await prisma.globalStepEventEntitlement.createMany({ data: rows.slice(i, i + 1000) });
    }
  }
  await readyGeneration();
  await analyze();
  return { events, activeUsers, dimensions: { history, historicalUsers, active,
    activeMemberships: Math.floor(active * 2.5), activeRaces, historicalRaces: rounds, missing } };
}

async function resetPerformance() {
  // A disposable benchmark has tens of thousands of fixture identities. TRUNCATE
  // avoids per-identity DELETE triggers and their transaction advisory lock set.
  await prisma.$executeRawUnsafe('TRUNCATE users, global_step_events, global_step_event_cron_owners, global_step_event_generation_state CASCADE');
  await cleanDatabase();
}

async function analyze() {
  for (const table of ['users', 'races', 'race_participants', 'global_step_event_entitlements']) {
    await prisma.$executeRawUnsafe(`ANALYZE ${table}`);
  }
}

function planMetrics(explain) {
  const root = explain.Plan;
  const visits = [];
  function walk(node) {
    if (node['Relation Name']) visits.push({ relation: node['Relation Name'], type: node['Node Type'],
      rows: node['Actual Rows'], loops: node['Actual Loops'],
      removed: (node['Rows Removed by Filter'] || 0) + (node['Rows Removed by Join Filter'] || 0) });
    for (const child of node.Plans || []) walk(child);
  }
  walk(root);
  return { planningMs: explain['Planning Time'], executionMs: explain['Execution Time'],
    hits: root['Shared Hit Blocks'] || 0, reads: root['Shared Read Blocks'] || 0,
    buffers: (root['Shared Hit Blocks'] || 0) + (root['Shared Read Blocks'] || 0),
    tempRead: root['Temp Read Blocks'] || 0, tempWritten: root['Temp Written Blocks'] || 0,
    rows: root['Actual Rows'], visits };
}

async function explain(sql, params) {
  assert.match(sql.trim(), /^WITH\b/);
  const rows = await prisma.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, ...params);
  return planMetrics(rows[0]['QUERY PLAN'][0]);
}

module.exports = { assertLocalTestDatabase, prisma, baseline, candidate, NOW, parents,
  readyGeneration, entitlement, tick, seedPerformance, explain, analyze, resetPerformance };
