const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { before, after, beforeEach, describe, it } = require('node:test');
const { prisma, cleanDatabase, createTestUser, startServer, request } = require('./setup');

const headers = { 'X-Client-Features': 'impact_summaries,impact_summary_expiry_v1,simple_event_recap_v1' };
let server;
let now = new Date('2026-09-11T22:40:00.000Z');
async function api(token, method = 'GET', body, path = '/home/event-recap', features = headers) {
  const response = await request(server.baseUrl, method, path, { token, body, headers: features });
  return { status: response.status, body: await response.json() };
}
async function candidate(userId, changes = {}) {
  const event = await prisma.globalStepEvent.create({ data: {
    startsAt: new Date('2026-09-11T22:00:00Z'), endsAt: new Date('2026-09-11T22:30:00Z'),
    multiplier: 2, scheduleMode: 'LOCAL_ENTITLEMENTS', eventDay: randomUUID(), ...changes.event,
  } });
  const entitlement = await prisma.globalStepEventEntitlement.create({ data: {
    eventId: event.id, userId, timezone: 'America/New_York', localDate: '2026-09-11',
    startsAt: event.startsAt, endsAt: event.endsAt, scheduleRevision: 3,
    startOutcome: 'ACTIVATED_ON_TIME', startProcessedAt: event.startsAt, ...changes.entitlement,
  } });
  await prisma.$executeRawUnsafe(`UPDATE global_step_event_entitlements SET
    recap_race_count=$2, recap_count_policy_version=1, recap_window_revision=schedule_revision WHERE id=$1`,
  entitlement.id, changes.raceCount ?? 3);
  return { event, entitlement, input: { eventId: event.id, revision: 3, rawSteps: 1000 } };
}

// A-only retained-schema fixture: run before final drop, never skip conditionally.
describe('retained legacy personal-data cascade', () => {
  before(async () => { server = await startServer({ now: () => now }); });
  after(async () => { await server.close(); });
  beforeEach(async () => { now = new Date('2026-09-11T22:40:00Z'); await cleanDatabase(); });

  it('account deletion removes retained personal capture descendants without touching another account', async () => {
    const accounts = [await createTestUser(), await createTestUser()];
    const owners = [];
    for (const account of accounts) {
      const { event, input } = await candidate(account.user.id);
      await api(account.token, 'POST', input);
      const workId = randomUUID(), ownerId = randomUUID(); owners.push(ownerId);
      await prisma.$executeRawUnsafe(`INSERT INTO global_event_summary_work(id,event_id,user_id,expires_at)
        VALUES($1,$2,$3,$4)`, workId, event.id, account.user.id, now);
      await prisma.$executeRawUnsafe(`INSERT INTO durable_global_event_capture_requests
        (id,work_id,user_id,context,context_digest,expires_at) VALUES($1::uuid,$2,$3,'{}',$4,$5)`,
      ownerId, workId, account.user.id, 'test-only', now);
      await prisma.$executeRawUnsafe(`INSERT INTO durable_capture_score_owners(id,live_request_id) VALUES($1::uuid,$1::uuid)`, ownerId);
      await prisma.$executeRawUnsafe(`INSERT INTO durable_capture_score_plans(request_id,race_id,plan_key,metadata,metadata_digest,point_count)
        VALUES($1::uuid,'synthetic-race','plan','{}','test-only',1000)`, ownerId);
      await prisma.$executeRawUnsafe(`INSERT INTO durable_capture_score_points(request_id,race_id,plan_key,position,time_ms,payload,payload_digest)
        SELECT $1::uuid,'synthetic-race','plan',i,i,'{}','test-only' FROM generate_series(1,1000)i`, ownerId);
      await prisma.$executeRawUnsafe(`INSERT INTO durable_capture_score_progress(request_id,race_id,state,state_digest)
        VALUES($1::uuid,'synthetic-race','{}','test-only')`, ownerId);
      await prisma.$executeRawUnsafe(`INSERT INTO durable_capture_score_transfers(request_id,race_id,effect_id,starts_ms,payload,payload_digest)
        VALUES($1::uuid,'synthetic-race','effect',0,'{}','test-only')`, ownerId);
    }
    const countJournal = async () => prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM durable_capture_fact_journal');
    const beforeJournal = await countJournal();
    const deleted = await request(server.baseUrl, 'DELETE', '/auth/account', { token: accounts[0].token });
    assert.equal(deleted.status, 204);
    assert.equal(await prisma.user.count({ where: { id: accounts[0].user.id } }), 0);
    assert.equal(await prisma.eventRecap.count({ where: { userId: accounts[0].user.id } }), 0);
    assert.equal(await prisma.user.count({ where: { id: accounts[1].user.id } }), 1);
    for (const table of ['durable_capture_score_owners','durable_capture_score_plans','durable_capture_score_points',
      'durable_capture_score_progress','durable_capture_score_transfers']) {
      const column = table === 'durable_capture_score_owners' ? 'id' : 'request_id';
      const rows = await prisma.$queryRawUnsafe(`SELECT ${column}::text AS owner,count(*)::int AS n FROM ${table} GROUP BY ${column}`);
      assert.equal(rows.some(row => row.owner === owners[0]), false, table);
      assert.equal(rows.some(row => row.owner === owners[1]), true, table);
    }
    assert.deepEqual(await countJournal(), beforeJournal);
    assert.equal((await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM global_event_summary_work'))[0].n, 1);
  });
});
