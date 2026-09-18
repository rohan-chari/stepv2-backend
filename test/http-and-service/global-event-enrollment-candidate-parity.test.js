const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const h = require('./fixtures/enrollment-query/harness.cjs');
const candidate = require('../../src/modules/steps/services/globalEventEnrollment').enrollIfGlobalEventActive;
const baseline = require(`${process.env.BASELINE_ENROLLMENT_ROOT}/src/modules/steps/services/globalEventEnrollment`).enrollIfGlobalEventActive;
const efficiency = require('../../src/shared/cache/cacheEfficiencyInvalidation');
const baselineEfficiency = require(`${process.env.BASELINE_ENROLLMENT_ROOT}/src/shared/cache/cacheEfficiencyInvalidation`);
const { acquireGlobalEnrollmentLock } = require('../../src/modules/steps/services/globalEventEnrollment');

const users = ['u-parity-1', 'u-parity-2'];
const norm = value => value instanceof Date ? value.toISOString() : value;

async function setup({ active = false, twoParents = true, states = {}, stale = false } = {}) {
  await h.resetPerformance();
  await h.prisma.user.createMany({ data: users.map(id => ({ id, timezone: 'UTC', globalEventTimezone: 'UTC' })) });
  await h.prisma.race.create({ data: { id: 'race-parity', name: 'parity', status: 'ACTIVE', targetSteps: 100, startedAt: new Date('2098-01-01T00:00:00Z'), endsAt: new Date('2098-01-10T00:00:00Z') } });
  await h.prisma.raceParticipant.createMany({ data: users.map(userId => ({ raceId: 'race-parity', userId, status: 'ACCEPTED' })) });
  const day = '2098-01-01';
  const parents = await Promise.all([0, 1].map(i => h.prisma.globalStepEvent.create({ data: {
    id: `parity-parent-${i}`, eventDay: i === 0 ? day : '2098-01-02', scheduleMode: 'LOCAL_ENTITLEMENTS',
    startsAt: new Date(`${i === 0 ? day : '2098-01-02'}T00:00:00Z`), endsAt: new Date(`${i === 0 ? day : '2098-01-02'}T23:59:00Z`),
    localStartMinute: i === 0 ? 600 : 1200, durationMinutes: 30, multiplier: 2,
  } })));
  if (!twoParents) await h.prisma.globalStepEvent.delete({ where: { id: parents[1].id } });
  const at = new Date(`${day}T${active ? '10:15' : '00:00'}:00Z`);
  for (const [key, state] of Object.entries(states)) {
    const [parentIndex, userIndex] = key.split(':').map(Number);
    const parent = parents[parentIndex];
    if (!parent || (!twoParents && parentIndex === 1)) continue;
    await h.prisma.globalStepEventEntitlement.create({ data: {
      eventId: parent.id, userId: users[userIndex], timezone: 'UTC', localDate: parent.eventDay,
      startsAt: new Date(stale ? '2097-12-31T10:00:00Z' : `${parent.eventDay}T${parentIndex === 0 ? '10:00' : '12:00'}:00Z`),
      endsAt: new Date(stale ? '2097-12-31T10:30:00Z' : `${parent.eventDay}T${parentIndex === 0 ? '10:30' : '12:30'}:00Z`),
      startOutcome: state,
    } });
  }
  if (active) {
    await h.prisma.globalStepEventCronOwner.updateMany({ data: { heartbeatAt: at, expiresAt: new Date(+at + 3600_000) } });
    await h.prisma.globalStepEventGenerationState.upsert({ where: { id: 1 }, create: { id: 1, readySince: null }, update: { readySince: null } });
  }
  return { at, parentIds: parents.filter((_, i) => twoParents || i === 0).map(x => x.id) };
}

async function snapshot(parentIds) {
  const entitlements = await h.prisma.globalStepEventEntitlement.findMany({ where: { eventId: { in: parentIds } }, orderBy: [{ eventId: 'asc' }, { userId: 'asc' }] });
  const byId = new Map(entitlements.map(row => [row.id, `${row.eventId}:${row.userId}`]));
  const events = await h.prisma.domainEventOutbox.findMany({ where: { eventType: { in: ['GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1', 'GLOBAL_STEP_EVENT_ACTIVATED_V1'] } }, orderBy: { eventKey: 'asc' } });
  const receipts = await h.prisma.domainEventReceipt.findMany({ orderBy: { eventKey: 'asc' } });
  return {
    entitlements: entitlements.map(row => ({ key: `${row.eventId}:${row.userId}`, timezone: row.timezone, localDate: row.localDate, startsAt: norm(row.startsAt), endsAt: norm(row.endsAt), startOutcome: row.startOutcome, scheduleRevision: row.scheduleRevision })),
    impacts: (await h.prisma.globalEventRaceImpact.findMany({ where: { eventId: { in: parentIds } }, orderBy: [{ eventId: 'asc' }, { userId: 'asc' }] })).map(row => `${row.eventId}:${row.raceId}:${row.userId}`),
    events: events.map(row => ({ key: row.eventKey.replace(/:[0-9a-f-]{36}(?::\d+)?$/, ':ENTITLEMENT'), type: row.eventType, payload: { ...row.payload, entitlementId: byId.get(row.aggregateId) || 'ENTITLEMENT' } })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    receipts: receipts.map(row => ({ key: row.eventKey.replace(/:[0-9a-f-]{36}(?::\d+)?$/, ':ENTITLEMENT'), type: row.eventType, aggregateType: row.aggregateType, replaySourceType: row.replaySourceType, replaySourceId: byId.get(row.replaySourceId) || 'ENTITLEMENT', state: row.receiptState })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

async function run(fn, options, replay = false) {
  const fixture = await setup(options);
  const invalidations = [];
  const original = efficiency.afterCommit;
  const baselineOriginal = baselineEfficiency.afterCommit;
  efficiency.afterCommit = async entries => invalidations.push(...entries);
  baselineEfficiency.afterCommit = async entries => invalidations.push(...entries);
  try {
    const invoke = () => h.prisma.$transaction(tx => fn(tx, { raceId: 'race-parity', userIds: users, at: fixture.at }), { timeout: 120000 });
    await invoke();
    if (replay) await invoke();
    return { state: await snapshot(fixture.parentIds), invalidations };
  } finally { efficiency.afterCommit = original; baselineEfficiency.afterCommit = baselineOriginal; }
}

async function runTimezoneRace(fn, mutationFirst) {
  const fixture = await setup({ active: true, twoParents: false });
  const invalidations = [];
  const original = efficiency.afterCommit;
  const baselineOriginal = baselineEfficiency.afterCommit;
  efficiency.afterCommit = async entries => invalidations.push(...entries);
  baselineEfficiency.afterCommit = async entries => invalidations.push(...entries);
  try {
    const mutate = () => h.prisma.$transaction(async tx => {
      await acquireGlobalEnrollmentLock(tx);
      await tx.user.updateMany({ where: { id: { in: users } }, data: { timezone: 'America/Los_Angeles' } });
    });
    if (mutationFirst) await mutate();
    else {
      let mutation;
      await h.prisma.$transaction(async tx => {
        await acquireGlobalEnrollmentLock(tx);
        mutation = mutate();
        await new Promise(resolve => setTimeout(resolve, 50));
        await fn(tx, { raceId: 'race-parity', userIds: users, at: fixture.at });
      }, { timeout: 120000 });
      await mutation;
    }
    if (mutationFirst) {
      await h.prisma.$transaction(tx => fn(tx, { raceId: 'race-parity', userIds: users, at: fixture.at }), { timeout: 120000 });
    }
    return { state: await snapshot(fixture.parentIds), users: await h.prisma.user.findMany({ where: { id: { in: users } }, orderBy: { id: 'asc' }, select: { id: true, timezone: true } }), invalidations };
  } finally { efficiency.afterCommit = original; baselineEfficiency.afterCommit = baselineOriginal; }
}

for (const mutationFirst of [true, false]) {
  test(`candidate parity: timezone mutation ${mutationFirst ? 'commits first' : 'enrollment lock first'}`, async () => {
    const before = await runTimezoneRace(baseline, mutationFirst);
    const after = await runTimezoneRace(candidate, mutationFirst);
    assert.deepEqual(after.state, before.state);
    assert.deepEqual(after.users, before.users);
    assert.deepEqual([...after.invalidations].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [...before.invalidations].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  });
}

async function runSerializableRetry(fn) {
  const fixture = await setup({ active: true, twoParents: false });
  const invoke = () => h.prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await tx.user.update({ where: { id: users[0] }, data: { timezone: 'UTC' } });
    return fn(tx, { raceId: 'race-parity', userIds: users, at: fixture.at });
  }, { timeout: 120000, isolationLevel: 'Serializable' });
  const outcomes = await Promise.allSettled([invoke(), invoke()]);
  const retried = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      assert.ok(outcome.reason.code === 'P2034' || outcome.reason.code === '40001' || /serializ/i.test(outcome.reason.message));
      retried.push(await invoke());
    }
  }
  return { state: await snapshot(fixture.parentIds), outcomes: outcomes.map(x => x.status), retries: retried.length };
}

test('candidate parity: serialization failure retries to one durable result', async () => {
  const before = await runSerializableRetry(baseline);
  const after = await runSerializableRetry(candidate);
  assert.ok(before.retries >= 1, `baseline did not exercise a serialization retry: ${JSON.stringify(before)}`);
  assert.ok(after.retries >= 1, `candidate did not exercise a serialization retry: ${JSON.stringify(after)}`);
  assert.deepEqual(after.state, before.state);
  assert.equal(after.state.entitlements.length, 2);
  assert.equal(after.state.impacts.length, 2);
  assert.equal(after.state.events.length, 2);
  assert.equal(after.state.receipts.length, 2);
});

const cases = [
  ['stale entitlement', { states: { '0:0': 'PENDING' }, active: true, stale: true }],
  ['SKIPPED_STALE', { states: { '0:0': 'SKIPPED_STALE' }, active: true }],
  ['existing ACTIVE', { states: { '0:0': 'ACTIVATED_ON_TIME' }, active: true }],
  ['existing SCHEDULED', { states: { '0:0': 'PENDING' }, active: false }],
  ['expired parent', { twoParents: false, active: false }],
  ['future parent', { twoParents: true, active: false }],
  ['mixed parent states', { states: { '0:0': 'SKIPPED_STALE', '1:1': 'ACTIVATED_ON_TIME' }, active: true }],
  ['scheduled receipt replay', { active: false }, true],
  ['late receipt replay', { active: true }, true],
  ['duplicate activation replay', { active: true }, true],
];

for (const [name, options, replay = false] of cases) {
  test(`candidate parity: ${name}`, async () => {
    const before = await run(baseline, options, replay);
    const after = await run(candidate, options, replay);
    assert.deepEqual(after.state, before.state);
    assert.deepEqual([...after.invalidations].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [...before.invalidations].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  });
}

after(async () => h.prisma.$disconnect());
