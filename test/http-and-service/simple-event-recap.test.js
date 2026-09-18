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

describe('simple event recap public contract', () => {
  before(async () => { server = await startServer({ now: () => now }); });
  after(async () => { await server.close(); });
  beforeEach(async () => { now = new Date('2026-09-11T22:40:00Z'); await cleanDatabase(); });

  it('requires authentication and returns none for a user without an event', async () => {
    assert.equal((await api(null)).status, 401);
    const { token } = await createTestUser();
    assert.deepEqual(await api(token), { status: 200, body: { state: 'none' } });
  });
  it('returns a pending window, saves only raw steps times frozen count, and preserves first result', async () => {
    const { user, token } = await createTestUser({ coins: 789 });
    const { event, input } = await candidate(user.id);
    assert.deepEqual(await api(token), { status: 200, body: { state: 'pending', event: {
      id: event.id, revision: 3, startsAt: '2026-09-11T22:00:00.000Z', endsAt: '2026-09-11T22:30:00.000Z',
      expiresAt: '2026-09-12T04:00:00.000Z', raceCount: 3,
    } } });
    const saved = await api(token, 'POST', input);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.state, 'ready');
    assert.equal(saved.body.globalEventSummary.extraRaceSteps, 3000);
    assert.equal(saved.body.globalEventSummary.raceCount, 3);
    assert.equal(saved.body.globalEventSummary.validForMs, 19200000);
    assert.deepEqual(await api(token, 'POST', { ...input, rawSteps: 5000 }), saved);
    assert.deepEqual(await api(token), saved);
    assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).coins, 789);
    assert.equal(await prisma.step.count(), 0);
  });
  it('saves suppressed zero once and never displays it', async () => {
    const { user, token } = await createTestUser();
    const { input } = await candidate(user.id);
    assert.deepEqual(await api(token, 'POST', { ...input, rawSteps: 0 }), { status: 200, body: { state: 'none' } });
    assert.deepEqual(await api(token, 'POST', input), { status: 200, body: { state: 'none' } });
  });
  it('enforces input, ownership, end, revision and expiry', async () => {
    const { user, token } = await createTestUser();
    const other = await createTestUser();
    const { input } = await candidate(user.id);
    for (const rawSteps of [-1, 1.5, null, '1000', 2147483647]) {
      const result = await api(token, 'POST', { ...input, rawSteps });
      assert.equal(result.status, 400); assert.equal(result.body.code, 'INVALID_INPUT');
    }
    assert.equal((await api(other.token, 'POST', input)).status, 404);
    assert.equal((await api(token, 'POST', { ...input, revision: 2 })).body.code, 'EVENT_CHANGED');
    now = new Date('2026-09-11T22:10:00Z');
    assert.equal((await api(token, 'POST', input)).body.code, 'EVENT_NOT_READY');
    now = new Date('2026-09-12T04:00:00Z');
    assert.deepEqual((await api(token)).body, { state: 'none' });
    assert.equal((await api(token, 'POST', input)).body.code, 'EVENT_EXPIRED');
  });
  it('serializes concurrent devices and preserves owner-safe legacy acknowledgment', async () => {
    const { user, token } = await createTestUser();
    const other = await createTestUser();
    const { input } = await candidate(user.id);
    const results = await Promise.all([1000, 2000, 3000].map(rawSteps => api(token, 'POST', { ...input, rawSteps })));
    for (const result of results) assert.deepEqual(result, results[0]);
    const path = `/home/global-event-summaries/${results[0].body.globalEventSummary.id}/acknowledge`;
    assert.equal((await api(other.token, 'POST', {}, path)).status, 404);
    assert.deepEqual(await api(token, 'POST', {}, path), { status: 200, body: { acknowledged: true } });
    assert.equal((await api(token, 'POST', {}, path)).body.code, 'ALREADY_ACKNOWLEDGED');
    assert.deepEqual((await api(token, 'POST', input)).body, { state: 'none' });
  });
  it('never resurrects an older saved recap behind an unstamped or suppressed latest event', async () => {
    const { user, token } = await createTestUser();
    const first = await candidate(user.id);
    await api(token, 'POST', first.input);
    await candidate(user.id, { event: { startsAt: new Date('2026-09-11T22:01:00Z'), endsAt: new Date('2026-09-11T22:31:00Z') }, raceCount: 0 });
    const latest = await api(token);
    assert.equal(latest.body.state, 'pending');
    await api(token, 'POST', { eventId: latest.body.event.id, revision: 3, rawSteps: 1000 });
    assert.deepEqual((await api(token)).body, { state: 'none' });
    assert.deepEqual((await api(token, 'POST', first.input)).body, { state: 'none' });
  });
  it('terminates valid retired receipt IDs uniformly without work storage', async () => {
    const { token } = await createTestUser();
    assert.deepEqual(await api(token, 'GET', undefined, `/home/global-event-summary-work/${randomUUID()}`), {
      status: 200, body: { state: 'EXPIRED_UNDELIVERED', expiresAt: now.toISOString() },
    });
    assert.equal((await api(token, 'GET', undefined, '/home/global-event-summary-work/not-a-uuid')).status, 400);
  });
  it('legacy accepted samples finalize only with complete contiguous coverage; capable uploads do not', async () => {
    const { user, token } = await createTestUser();
    await candidate(user.id);
    const legacy = { 'X-App-Version': '2.3.13', 'X-Client-Features': 'impact_summaries,impact_summary_expiry_v1' };
    const samples = [
      { periodStart: '2026-09-11T22:00:00Z', periodEnd: '2026-09-11T22:10:00Z', steps: 100 },
      { periodStart: '2026-09-11T22:20:00Z', periodEnd: '2026-09-11T22:30:00Z', steps: 100 },
    ];
    assert.equal((await api(token, 'POST', { samples }, '/steps/samples', legacy)).status, 200);
    assert.equal((await api(token)).body.state, 'pending');
    const middle = { periodStart: '2026-09-11T22:10:00Z', periodEnd: '2026-09-11T22:20:00Z', steps: 100 };
    assert.equal((await api(token, 'POST', { samples: [middle] }, '/steps/samples')).status, 200);
    assert.equal((await api(token)).body.state, 'pending');
    assert.equal((await api(token, 'POST', { samples: [middle] }, '/steps/samples', legacy)).status, 200);
    assert.equal((await api(token)).body.globalEventSummary.extraRaceSteps, 900);
  });
  it('account deletion removes the caller recap and leaves another user intact', async () => {
    const accounts = await Promise.all([createTestUser(), createTestUser()]);
    for (const account of accounts) {
      const { input } = await candidate(account.user.id);
      assert.equal((await api(account.token, 'POST', input)).status, 200);
    }
    const deleted = await request(server.baseUrl, 'DELETE', '/auth/account', { token: accounts[0].token });
    assert.equal(deleted.status, 204);
    assert.equal(await prisma.eventRecap.count({ where: { userId: accounts[0].user.id } }), 0);
    assert.equal(await prisma.eventRecap.count({ where: { userId: accounts[1].user.id } }), 1);
  });
  it('old Home requires both original capabilities and returns unchanged positive expiry metadata', async () => {
    const { user, token } = await createTestUser();
    const { input } = await candidate(user.id, { event: {
      startsAt: new Date(Date.now() - 31 * 60000), endsAt: new Date(Date.now() - 60000),
    } });
    const saved = await api(token, 'POST', input);
    for (const features of ['', 'impact_summaries', 'impact_summary_expiry_v1']) {
      const response = await api(token, 'GET', undefined, '/home/race-card', { 'X-Client-Features': features });
      assert.equal(response.status, 200);
      assert.equal(response.body.globalEventSummary, undefined);
    }
    for (const features of ['impact_summaries,impact_summary_expiry_v1',
      'impact_summaries,impact_summary_expiry_v1,home_shell_v1']) {
      const response = await api(token, 'GET', undefined, '/home/race-card', { 'X-Client-Features': features });
      assert.equal(response.status, 200);
      assert.equal(response.body.globalEventSummary.id, saved.body.globalEventSummary.id);
      assert.equal(response.body.globalEventSummary.extraRaceSteps, 3000);
      assert.equal(response.body.globalEventSummary.expiresAt, '2026-09-12T04:00:00.000Z');
      assert.ok(response.body.globalEventSummary.validForMs > 0);
    }
  });
  it('legacy null-expiry and migrated suppressed evidence cannot render on either API', async () => {
    for (const fixture of [{ expiresAt: null, suppressed: false },
      { expiresAt: new Date('2026-09-12T04:00:00Z'), suppressed: true },
      { expiresAt: new Date('2026-09-11T22:39:00Z'), suppressed: false }]) {
      const { user, token } = await createTestUser();
      const { event } = await candidate(user.id);
      await prisma.eventRecap.create({ data: { eventId: event.id, userId: user.id,
        calculationVersion: 'LEGACY_SAVED', extraRaceSteps: 1500, raceCount: 1, ...fixture } });
      assert.deepEqual((await api(token)).body, { state: 'none' });
      assert.equal((await api(token, 'GET', undefined, '/home/race-card')).body.globalEventSummary, undefined);
    }
  });
  it('legacy sample adapter defers overlapping, open-bucket and over-limit inputs without treating missing data as zero', async () => {
    for (const mode of ['overlap', 'open', 'over-limit']) {
      const { user, token } = await createTestUser();
      await candidate(user.id);
      const start = Date.parse('2026-09-11T22:00:00Z');
      const samples = mode === 'over-limit'
        ? Array.from({ length: 1001 }, (_, i) => ({ userId: user.id,
          periodStart: new Date(start + Math.floor(i * 1800000 / 1001)),
          periodEnd: new Date(start + Math.floor((i + 1) * 1800000 / 1001)), steps: 1 }))
        : mode === 'open'
          ? [{ userId: user.id, periodStart: new Date(start), periodEnd: new Date('2026-09-11T22:50:00Z'), steps: 100 }]
          : [{ userId: user.id, periodStart: new Date(start), periodEnd: new Date(start + 1200000), steps: 100 },
            { userId: user.id, periodStart: new Date(start + 600000), periodEnd: new Date(start + 1800000), steps: 100 }];
      await prisma.stepSample.createMany({ data: samples });
      const response = await api(token, 'POST', { samples: [{ periodStart: '2026-09-11T21:00:00Z',
        periodEnd: '2026-09-11T21:01:00Z', steps: 1 }] }, '/steps/samples', {
        'X-Client-Features': 'impact_summaries,impact_summary_expiry_v1' });
      assert.equal(response.status, 200);
      assert.equal((await api(token)).body.state, 'pending', mode);
      assert.equal(await prisma.eventRecap.count({ where: { userId: user.id } }), 0, mode);
    }
  });
  it('a POST blocked behind an entitlement lock cannot save after local midnight', async () => {
    const { user, token } = await createTestUser();
    const { entitlement, input } = await candidate(user.id);
    now = new Date('2026-09-12T03:59:59.999Z');
    let release, locked;
    const acquired = new Promise(resolve => { locked = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const holder = prisma.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT id FROM global_step_event_entitlements WHERE id=$1 FOR UPDATE', entitlement.id);
      locked(); await hold;
    });
    await acquired;
    const pending = api(token, 'POST', input);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [row] = await prisma.$queryRawUnsafe(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF e%') AS waiting`);
        if (row.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(waiting, true, 'HTTP POST must reach the real blocked transaction');
      now = new Date('2026-09-12T04:00:00.000Z');
    } finally { release(); await holder; }
    const response = await pending;
    assert.equal(response.status, 410);
    assert.equal(response.body.code, 'EVENT_EXPIRED');
    assert.equal(await prisma.eventRecap.count({ where: { userId: user.id } }), 0);
  });
});
