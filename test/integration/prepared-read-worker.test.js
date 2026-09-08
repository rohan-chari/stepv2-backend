const assert = require('node:assert/strict');
const { before, beforeEach, it } = require('node:test');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = '0';
process.env.RACE_RESOLVE_DEBOUNCE_MS = '0';
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require('./setup');
// Worker entry point is the real consumer of the HTTP-enqueued job.
const { buildRaceResolutionWorkerV2 } = require('../../src/modules/races/jobs/raceResolutionQueueV2');
let baseUrl;
before(async () => { baseUrl = (await getSharedServer()).baseUrl; });
beforeEach(cleanDatabase);
it('reuses named reads while HTTP intake, worker transactions and old-client progress retain values', async (t) => {
  const seen = [];
  const original = Client.prototype.query;
  t.mock.method(Client.prototype, 'query', function (...args) {
    if (args[0]?.text?.startsWith('/* steps:prepared-read:v1 */')) seen.push(args[0]);
    return original.apply(this, args);
  });
  for (const steps of [50, 175]) {
    const account = await createTestUser();
    const now = Date.now();
    const race = await prisma.race.create({ data: {
      creatorId: account.user.id, name: 'Prepared worker', status: 'ACTIVE',
      targetSteps: 100000, maxParticipants: 10, powerupsEnabled: false, timezone: 'UTC',
      startedAt: new Date(now - 7200000), endsAt: new Date(now + 86400000),
    } });
    await prisma.raceParticipant.create({ data: { raceId: race.id, userId: account.user.id,
      status: 'ACCEPTED', joinedAt: new Date(now - 7200000) } });
    const accepted = await request(baseUrl, 'POST', '/steps/sync-v2', {
      token: account.token, headers: { 'Idempotency-Key': randomUUID(), 'X-Timezone': 'UTC' },
      body: { date: new Date(now).toISOString().slice(0, 10), steps, samples: [{
        periodStart: new Date(now - 3600000).toISOString(),
        periodEnd: new Date(now - 1800000).toISOString(), steps,
      }] },
    });
    assert.equal(accepted.status, 202);
    assert.ok(await buildRaceResolutionWorkerV2({ bootAt: 0 }).processOne({ raceId: race.id }));
    const response = await request(baseUrl, 'GET', `/races/${race.id}/progress`, { token: account.token });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.progress.participants.find(row => row.userId === account.user.id).totalSteps, steps);
  }
  assert.ok(seen.length > 0, 'worker must execute selected reads');
  assert.ok(seen.every(q => /^steps_read_v1_[a-f0-9]{48}$/.test(q.name)), 'selected adapter queries must be named');
  const first = seen[0];
  assert.ok(seen.some(q => q !== first && q.text === first.text && q.name === first.name), 'same SQL reuses its name');
});
