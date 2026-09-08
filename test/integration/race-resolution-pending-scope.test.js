const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { before, beforeEach, it } = require('node:test');
// Exercise permanent worker planning rather than legacy node-test defaults.
const runnerContext = process.env.NODE_TEST_CONTEXT;
delete process.env.NODE_TEST_CONTEXT;
process.env.NODE_ENV = 'test';
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = '0';
const database = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(database.hostname) && database.pathname.endsWith('_test'), 'local test database required');
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require('./setup');
const { buildRaceResolutionWorkerV2 } = require('../../src/modules/races/jobs/raceResolutionQueueV2');
// App-setting defaults are captured at construction; preserve node:test's own
// reporting context after the real application has been initialized.
if (runnerContext != null) process.env.NODE_TEST_CONTEXT = runnerContext;
const { buildRaceResolutionPostTaskRunner } = require('../../src/modules/races/jobs/raceResolutionPostTaskRunner');
const { raceResolutionPostTaskHandoff } = require('../../src/modules/races/services/raceResolutionPostTaskHandoff');
const queuedHandoff = Object.assign((...args) => raceResolutionPostTaskHandoff(...args), raceResolutionPostTaskHandoff, { async resumeDurable() {} });
const redisCache = require('../../src/shared/cache/redisCache');
let baseUrl;
before(async () => { baseUrl = (await getSharedServer()).baseUrl; });
beforeEach(cleanDatabase);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(powerupsEnabled = false) {
  const users = [];
  for (let i = 0; i < 10; i++) users.push(await createTestUser({ displayName: `Pending Scope ${i}` }));
  const now = Date.now();
  const race = await prisma.race.create({ data: {
    creatorId: users[0].user.id, name: 'Pending scope', status: 'ACTIVE', targetSteps: 1000000,
    maxParticipants: 10, powerupsEnabled, timezone: 'UTC',
    startedAt: new Date(now - 7200000), endsAt: new Date(now + 86400000),
  } });
  await prisma.raceParticipant.createMany({ data: users.map(u => ({ raceId: race.id, userId: u.user.id,
    status: 'ACCEPTED', joinedAt: new Date(now - 7200000) })) });
  async function sync(index, steps) {
    const response = await request(baseUrl, 'POST', '/steps/sync-v2', {
      token: users[index].token, headers: { 'Idempotency-Key': randomUUID(), 'X-Timezone': 'UTC' },
      body: { date: new Date(now - 1800000).toISOString().slice(0,10), steps, samples: [{
        periodStart: new Date(now - 3600000).toISOString(), periodEnd: new Date(now - 1800000).toISOString(), steps,
      }] },
    });
    assert.equal(response.status, 202, await response.text());
  }
  const queue = () => prisma.raceResolutionJobV2.findUniqueOrThrow({ where: { raceId: race.id } });
  async function drain(worker = buildRaceResolutionWorkerV2({ bootAt: 0, raceResolutionPostTaskHandoff: queuedHandoff })) {
    const deadline = Date.now() + 45000;
    do {
      await worker.processOne({ raceId: race.id });
      if ((await queue()).state === 'SUCCEEDED') return;
      await delay(50);
    } while (Date.now() < deadline);
    assert.fail('queue did not drain');
  }
  for (let i = 0; i < 10; i++) await sync(i, 50);
  await drain();
  const members = await prisma.raceParticipant.findMany({ where: { raceId: race.id } });
  assert.ok(members.every(p => p.rawSteps === 50 && p.totalSteps === 50));
  async function assertScores(expected) {
    // Read before public progress can calculate a fresh response and hide a stale projection.
    const saved = await prisma.raceParticipant.findMany({ where: { raceId: race.id } });
    for (let i = 0; i < users.length; i++) {
      const row = saved.find(p => p.userId === users[i].user.id);
      assert.equal(row.rawSteps, expected[i] ?? 50, `persisted raw score for uploader ${i}`);
      assert.equal(row.totalSteps, expected[i] ?? 50, `persisted adjusted score for uploader ${i}`);
    }
    const response = await request(baseUrl, 'GET', `/races/${race.id}/progress`, { token: users[0].token });
    assert.equal(response.status, 200);
    const body = await response.json();
    for (let i = 0; i < users.length; i++) assert.equal(
      body.progress.participants.find(p => p.userId === users[i].user.id).totalSteps, expected[i] ?? 50);
  }
  return { users, race, members, sync, queue, drain, assertScores };
}
it('HTTP corrections arriving during another uploader claim retain every pending participant', { timeout: 90000 }, async () => {
  const f = await fixture();
  await f.sync(2, 60);
  let injected = false, pending;
  await f.drain(buildRaceResolutionWorkerV2({ bootAt: 0, async beforeWriteTransaction() {
    if (injected) return;
    injected = true;
    await f.sync(0, 61);
    await f.sync(1, 62);
    pending = await f.queue();
  } }));
  assert.ok(injected);
  await f.assertScores([61, 62, 60]);
  for (const i of [0, 1]) assert.ok(pending.dirtyParticipantIds.includes(
    f.members.find(p => p.userId === f.users[i].user.id).id), `pending scope retains uploader ${i}`);
});
it('a queued partial envelope from an older writer cannot omit an HTTP uploader from scoring', { timeout: 90000 }, async () => {
  const f = await fixture();
  await f.sync(0, 61);
  await f.sync(1, 62);
  // Reproduce the durable envelope older workers could leave behind. The
  // authoritative input and triggering users still come from real HTTP intake.
  await prisma.raceResolutionJobV2.update({ where: { raceId: f.race.id }, data: {
    dirtyParticipantIds: [f.members.find(p => p.userId === f.users[1].user.id).id],
  } });
  await f.drain();
  await f.assertScores([61, 62]);
});

for (const advanceDuringWrite of [false, true]) {
  it(`publication preserves its failed attempt when HTTP advances generation ${advanceDuringWrite ? 'during Redis writes' : 'before publication'}`, { timeout: 90000 }, async () => {
    const f = await fixture(true);
    const original = await prisma.raceResolutionPostTask.findFirstOrThrow({
      where: { raceId: f.race.id }, orderBy: { sourceGeneration: 'desc' },
    });
    assert.equal(original.snapshotState, 'pending');
    const realSetMany = redisCache.setManyJSON;
    let writes = 0, advanced = false;
    redisCache.setManyJSON = async (...args) => {
      writes++;
      const result = await realSetMany(...args);
      if (advanceDuringWrite && !advanced) { advanced = true; await f.sync(0, 61); }
      return result;
    };
    let clock = Date.now();
    const runner = buildRaceResolutionPostTaskRunner({ now: () => new Date(clock) });
    try {
      if (!advanceDuringWrite) await f.sync(0, 61);
      await runner.processTaskId(original.id);
      const deferred = await prisma.raceResolutionPostTask.findUniqueOrThrow({ where: { id: original.id } });
      assert.equal(deferred.state, 'succeeded_with_failures', 'an unproven replacement cannot make the attempted publication successful');
      assert.equal(deferred.snapshotState, 'failed_no_retry');
      assert.equal(deferred.snapshotErrorCode, 'SNAPSHOT_GENERATION_ADVANCED');
      assert.ok(deferred.snapshotAttemptId);
      if (advanceDuringWrite) assert.ok(advanced && writes > 0, 'generation must advance after real Redis writes');
      else assert.equal(writes, 0, 'stale generation must not start cache writes');
      const writesBeforeReclaim = writes;
      // A later runner must not repeat cache I/O or turn a historical
      // failure into success merely because a newer input exists.
      clock += 2000;
      await buildRaceResolutionPostTaskRunner({ now: () => new Date(clock) }).processTaskId(original.id);
      const waiting = await prisma.raceResolutionPostTask.findUniqueOrThrow({ where: { id: original.id } });
      assert.equal(waiting.snapshotState, 'failed_no_retry');
      assert.equal(waiting.snapshotAttemptId, deferred.snapshotAttemptId);
      assert.equal(writes, writesBeforeReclaim);
      await f.drain();
      const replacement = await prisma.raceResolutionPostTask.findFirstOrThrow({
        where: { raceId: f.race.id }, orderBy: { sourceGeneration: 'desc' },
      });
      assert.notEqual(replacement.id, original.id);
      clock = Date.now() + 4000;
      await runner.processTaskId(replacement.id);
      assert.equal((await prisma.raceResolutionPostTask.findUniqueOrThrow({ where: { id: replacement.id } })).snapshotState, 'succeeded');
      await runner.processTaskId(original.id);
      const retired = await prisma.raceResolutionPostTask.findUniqueOrThrow({ where: { id: original.id } });
      assert.equal(retired.snapshotState, 'failed_no_retry');
      assert.equal(retired.state, 'succeeded_with_failures');
      assert.equal(retired.snapshotAttemptId, deferred.snapshotAttemptId, 'replacement must not rewrite the historical attempt');
      const { RaceResolutionPostTask } = require('../../src/modules/races/models/raceResolutionPostTask');
      assert.equal(await RaceResolutionPostTask.hasSuccessfulPublication({ raceId: f.race.id, minimumGeneration: Number(original.sourceGeneration) + 1 }), true);
      await f.assertScores([61]);
    } finally { redisCache.setManyJSON = realSetMany; }
  });
}

it('a Redis write failure without newer input retains the generic publication error', { timeout: 90000 }, async () => {
  const f = await fixture(true);
  const task = await prisma.raceResolutionPostTask.findFirstOrThrow({
    where: { raceId: f.race.id }, orderBy: { sourceGeneration: 'desc' },
  });
  const realSetMany = redisCache.setManyJSON;
  let attempted = false;
  redisCache.setManyJSON = async () => { attempted = true; return { ok: false, count: 0 }; };
  try {
    await buildRaceResolutionPostTaskRunner().processTaskId(task.id);
    assert.ok(attempted, 'inject failure at the real projection write boundary');
    const failed = await prisma.raceResolutionPostTask.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(failed.snapshotState, 'failed_no_retry');
    assert.equal(failed.snapshotErrorCode, 'SNAPSHOT_NOT_PUBLISHED');
    assert.equal(Number((await f.queue()).generation), Number(task.sourceGeneration));
  } finally { redisCache.setManyJSON = realSetMany; }
});
