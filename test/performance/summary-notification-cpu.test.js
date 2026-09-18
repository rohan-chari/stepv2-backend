const assert = require('node:assert/strict');
const { before, beforeEach, it } = require('node:test');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { setTimeout: delay } = require('node:timers/promises');
const target = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
assert.match(target.pathname, /_test$/);
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = '0';
process.env.RACE_RESOLVE_DEBOUNCE_MS = '0';
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require('./setup');
const { buildRaceResolutionWorkerV2 } = require('../../src/modules/races/jobs/raceResolutionQueueV2');
const { scheduleDomainEventProjection, buildDomainEventProjectionJob } = require('../../src/modules/domainEvents/jobs/domainEventProjection');
const { appSettings } = require('../../src/shared/config/appSettings');
let baseUrl;
before(async () => { baseUrl = (await getSharedServer()).baseUrl; });
beforeEach(cleanDatabase);

it('ordinary HTTP step sync resolves for old clients without waking unrelated summaries', async () => {
  await appSettings.setFlag('raceResolutionPostTasksV1Enabled', true);
  const account = await createTestUser();
  const now = Date.now();
  const race = await prisma.race.create({ data: {
    creatorId: account.user.id, name: 'No summary wake', status: 'ACTIVE',
    targetSteps: 100000, maxParticipants: 10, powerupsEnabled: false, timezone: 'UTC',
    startedAt: new Date(now - 7200000), endsAt: new Date(now + 86400000),
  } });
  await prisma.raceParticipant.create({ data: { raceId: race.id, userId: account.user.id,
    status: 'ACCEPTED', joinedAt: race.startedAt } });
  const wakes = [];
  const worker = buildRaceResolutionWorkerV2({ bootAt: 0,
    publishDurableQueueWakeup: async queue => { wakes.push(queue); return true; },
  });
  for (const steps of [50, 175]) {
    const accepted = await request(baseUrl, 'POST', '/steps/sync-v2', {
      token: account.token, headers: { 'Idempotency-Key': randomUUID(), 'X-Timezone': 'UTC' },
      body: { date: new Date(now).toISOString().slice(0, 10), steps, samples: [{
        periodStart: new Date(now - 3600000).toISOString(),
        periodEnd: new Date(now - 1800000).toISOString(), steps,
      }] },
    });
    assert.equal(accepted.status, 202);
    assert.ok(await worker.processRace({ raceId: race.id }));
    const response = await request(baseUrl, 'GET', `/races/${race.id}/progress`, { token: account.token });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).progress.participants.find(p => p.userId === account.user.id).totalSteps, steps);
  }
  assert.ok(wakes.includes('post-task'), 'committed downstream handoffs remain awake');
  assert.equal(wakes.filter(q => q === 'summary').length, 0, 'ordinary commits must not trigger empty summary drains');
});

it('HTTP notifications remain recipient-correct and idempotent while queue statements reuse names', async t => {
  await appSettings.setFlag('apiInboxV1Enabled', true);
  const seen = [];
  const original = Client.prototype.query;
  t.mock.method(Client.prototype, 'query', function (...args) {
    const q = args[0];
    if (q?.text && /WITH (?:projection_lane|stranded_candidates|candidate_ids) AS MATERIALIZED/.test(q.text) &&
        /domain_event_outbox/.test(q.text)) seen.push(q);
    return original.apply(this, args);
  });
  const sender = await createTestUser();
  const recipients = [await createTestUser(), await createTestUser()];
  for (const recipient of recipients) {
    const response = await request(baseUrl, 'POST', '/friends/request', {
      token: sender.token, body: { addresseeId: recipient.user.id },
    });
    assert.equal(response.status, 201);
    const scheduled = scheduleDomainEventProjection({ logger: { log() {}, error() {} } });
    try {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !(await prisma.inboxAlert.count({ where: { userId: recipient.user.id } }))) await delay(20);
      await scheduled.coordinator.whenIdle();
      for (let replay = 0; replay < 8; replay++) await scheduled.tick(); // reuse beyond initial custom plans
      assert.equal(await prisma.inboxAlert.count({ where: { userId: recipient.user.id, type: 'FRIEND_REQUEST_SENT' } }), 1);
      assert.equal(await prisma.inboxDeliveryOutbox.count({ where: { alert: { userId: recipient.user.id } } }), 1);
      const inbox = await request(baseUrl, 'GET', '/inbox/alerts', { token: recipient.token, headers: { 'X-Client-Features': 'inbox_v1' } });
      assert.equal(inbox.status, 200);
      assert.equal((await inbox.json()).alerts.filter(a => a.type === 'FRIEND_REQUEST_SENT').length, 1);
    } finally { await scheduled.stop(); }
  }
  assert.ok(seen.some(q => q.text.includes('projection_lane')), 'real scheduler checks its next deadline');
  assert.ok(seen.some(q => q.text.includes('stranded_candidates')), 'real projector claims notifications');
  assert.ok(seen.every(q => /^steps_query_v1_[a-f0-9]{48}$/.test(q.name)), 'selected notification queue statements must be named');
  const claims = seen.filter(q => q.text.includes('stranded_candidates'));
  assert.ok(claims.length >= 2);
  assert.equal(new Set(claims.map(q => q.name)).size, 1, 'new bind values reuse the SQL identity');
});


it('a failed prepared claim rolls back and a later worker delivers exactly once', async t => {
  await appSettings.setFlag('apiInboxV1Enabled', true);
  const sender = await createTestUser();
  const recipient = await createTestUser();
  const response = await request(baseUrl, 'POST', '/friends/request', {
    token: sender.token, body: { addresseeId: recipient.user.id },
  });
  assert.equal(response.status, 201);
  const original = Client.prototype.query;
  let injected = 0;
  t.mock.method(Client.prototype, 'query', function (...args) {
    const result = original.apply(this, args);
    if (args[0]?.text?.includes('WITH stranded_candidates AS MATERIALIZED') && !injected) {
      return result.then(value => {
        assert.ok(value.rowCount > 0, 'fault occurs after PostgreSQL claims real work');
        injected++;
        throw Object.assign(new Error('injected post-claim failure'), { code: '40001' });
      });
    }
    return result;
  });
  const run = buildDomainEventProjectionJob({ logger: { log() {}, error() {} } });
  await assert.rejects(run(), /injected post-claim failure/);
  assert.equal(injected, 1);
  assert.equal(await prisma.inboxAlert.count({ where: { userId: recipient.user.id } }), 0);
  const pending = await prisma.domainEventNotificationProjection.findMany({ where: { recipientUserId: recipient.user.id } });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'PENDING', 'rolled-back lease leaves work claimable');
  await run();
  await run();
  const inbox = await request(baseUrl, 'GET', '/inbox/alerts', { token: recipient.token, headers: { 'X-Client-Features': 'inbox_v1' } });
  assert.equal(inbox.status, 200);
  assert.equal((await inbox.json()).alerts.filter(a => a.type === 'FRIEND_REQUEST_SENT').length, 1);
  assert.equal(await prisma.inboxDeliveryOutbox.count({ where: { alert: { userId: recipient.user.id } } }), 1);
});
