const assert = require('node:assert/strict');
const { before, after, beforeEach, test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { prisma, cleanDatabase, createTestUser, startServer, request } = require('./setup');
const { processDueEntitlementBoundaries } = require('../../src/modules/steps/services/globalStepEventEntitlement');
const { cleanupExpiredEntitlements } = require('../../src/modules/steps/services/globalStepEventRetention');
let server;
const startsAt = new Date('2026-09-11T12:00:00Z');
const endsAt = new Date('2026-09-11T12:30:00Z');
let now;
before(async () => { server = await startServer({ now: () => now }); });
after(async () => { await server.close(); });
beforeEach(async () => { await cleanDatabase(); now = new Date('2026-09-11T12:31:00Z'); });
async function eventFor(userId) {
  const event = await prisma.globalStepEvent.create({ data: { startsAt, endsAt, multiplier: 2,
    scheduleMode: 'LOCAL_ENTITLEMENTS', eventDay: randomUUID() } });
  await prisma.globalStepEventEntitlement.create({ data: { eventId: event.id, userId,
    startsAt, endsAt, timezone: 'UTC', localDate: '2026-09-11' } });
  return event;
}
async function raceFor(userId, { race = {}, participant = {} } = {}) {
  const created = await prisma.race.create({ data: { creatorId: userId, name: 'start cohort',
    targetSteps: 10000, status: 'ACTIVE', startedAt: new Date('2026-09-11T11:00:00Z'),
    endsAt: new Date('2026-09-12T12:00:00Z'), ...race } });
  await prisma.raceParticipant.create({ data: { raceId: created.id, userId, status: 'ACCEPTED',
    joinedAt: created.startedAt, ...participant } });
  return created;
}
async function recap(token, body) {
  const response = await request(server.baseUrl, body ? 'POST' : 'GET', '/home/event-recap', { token, body });
  assert.equal(response.status, 200);
  return response.json();
}
async function schemaCompletionFixture(t, completed) {
  const where = { jobName: 'simple_event_recap:drop:v1' };
  const original = await prisma.jobRun.findUnique({ where });
  t.after(async () => {
    if (original) await prisma.jobRun.upsert({ where, create: original, update: original });
    else await prisma.jobRun.deleteMany({ where });
  });
  // Explicit test-only phase simulation; restore the exact real milestone so
  // these same behavior assertions also run against physically dropped schema.
  if (completed) await prisma.jobRun.upsert({ where, update: {},
    create: { ...where, lastRanFor: 'test-completed-schema-retirement' } });
  else await prisma.jobRun.deleteMany({ where });
}
test('delayed real start processing counts start races despite later finish/leave and excludes later joins', async () => {
  const { user, token } = await createTestUser();
  const event = await eventFor(user.id);
  await raceFor(user.id);
  await raceFor(user.id, { participant: { finishedAt: new Date('2026-09-11T12:05:00Z') } });
  await raceFor(user.id, { participant: { forfeitedAt: new Date('2026-09-11T12:06:00Z') } });
  await raceFor(user.id, { race: { status: 'COMPLETED', completedAt: new Date('2026-09-11T12:07:00Z') } });
  await raceFor(user.id, { participant: { joinedAt: new Date('2026-09-11T12:01:00Z') } });
  await raceFor(user.id, { participant: { finishedAt: new Date('2026-09-11T11:59:00Z') } });
  await processDueEntitlementBoundaries({ prisma, now: new Date('2026-09-11T12:10:00Z') });
  const pending = await recap(token);
  assert.equal(pending.event.raceCount, 4);
  await raceFor(user.id, { participant: { joinedAt: new Date('2026-09-11T12:11:00Z') } });
  await processDueEntitlementBoundaries({ prisma, now: new Date('2026-09-11T12:20:00Z') });
  const saved = await recap(token, { eventId: event.id, revision: 0, rawSteps: 1000 });
  assert.equal(saved.globalEventSummary.extraRaceSteps, 4000);
  assert.equal(saved.globalEventSummary.raceCount, 4);
});
test('proven empty start count remains zero after late enrollment and saves a suppressed recap', async () => {
  const { user, token } = await createTestUser();
  const event = await eventFor(user.id);
  await processDueEntitlementBoundaries({ prisma, now: new Date('2026-09-11T12:01:00Z') });
  assert.equal((await recap(token)).event.raceCount, 0);
  await raceFor(user.id, { participant: { joinedAt: new Date('2026-09-11T12:02:00Z') } });
  await processDueEntitlementBoundaries({ prisma, now: new Date('2026-09-11T12:03:00Z') });
  assert.deepEqual(await recap(token, { eventId: event.id, revision: 0, rawSteps: 1000 }), { state: 'none' });
  assert.equal((await prisma.eventRecap.findFirstOrThrow()).raceCount, 0);
});
test('ambiguous cancellation or missing completion timestamp and stale starts never invent a count', async () => {
  for (const mode of ['cancelled', 'missing-completed-at', 'stale']) {
    const { user, token } = await createTestUser();
    await eventFor(user.id);
    await raceFor(user.id, { race: mode === 'cancelled' ? { status: 'CANCELLED' }
      : mode === 'missing-completed-at' ? { status: 'COMPLETED', completedAt: null } : {} });
    await processDueEntitlementBoundaries({ prisma, now: new Date(mode === 'stale'
      ? '2026-09-11T12:31:00Z' : '2026-09-11T12:10:00Z') });
    assert.deepEqual(await recap(token), { state: 'none' }, mode);
    assert.equal(await prisma.eventRecap.count({ where: { userId: user.id } }), 0);
  }
});
test('entitlement retention preserves migrated recap identity and number for the separate drop audit', async (t) => {
  await schemaCompletionFixture(t, false);
  const { user, token } = await createTestUser();
  const event = await eventFor(user.id);
  await prisma.globalStepEventEntitlement.updateMany({ where: { eventId: event.id }, data: {
    startProcessedAt: startsAt, endProcessedAt: endsAt, startOutcome: 'ACTIVATED_ON_TIME' } });
  const saved = await prisma.eventRecap.create({ data: { eventId: event.id, userId: user.id,
    calculationVersion: 'LEGACY_SAVED', extraRaceSteps: 123, raceCount: 2,
    settledAt: endsAt, expiresAt: new Date('2026-09-12T00:00:00Z') } });
  assert.equal((await recap(token)).globalEventSummary.id, saved.id);
  now = new Date('2026-10-13T12:00:00Z');
  assert.equal((await cleanupExpiredEntitlements({ client: prisma, now })).deletedEntitlements, 1);
  assert.deepEqual(await recap(token), { state: 'none' });
  assert.deepEqual(await prisma.eventRecap.findUniqueOrThrow({ where: { id: saved.id } }), saved);
});
test('database rejects a partly populated start stamp instead of accepting SQL unknown', async () => {
  const { user, token } = await createTestUser();
  const event = await eventFor(user.id);
  await assert.rejects(prisma.$executeRawUnsafe(`UPDATE global_step_event_entitlements
    SET recap_race_count=1,recap_window_revision=0,recap_count_policy_version=NULL WHERE event_id=$1`, event.id),
  /recap_stamp_check/);
  assert.deepEqual(await recap(token), { state: 'none' });
});
test('a migrated recap that ages out after final-drop completion receives normal retention', async (t) => {
  await schemaCompletionFixture(t, true);
  const { user, token } = await createTestUser();
  const event = await eventFor(user.id);
  await prisma.globalStepEventEntitlement.updateMany({ where: { eventId: event.id }, data: {
    startProcessedAt: startsAt, endProcessedAt: endsAt, startOutcome: 'ACTIVATED_ON_TIME' } });
  const saved = await prisma.eventRecap.create({ data: { eventId: event.id, userId: user.id,
    calculationVersion: 'LEGACY_SAVED', extraRaceSteps: 123, raceCount: 2,
    settledAt: endsAt, expiresAt: new Date('2026-09-12T00:00:00Z') } });
  assert.equal((await cleanupExpiredEntitlements({ client: prisma,
    now: new Date('2026-09-20T12:00:00Z') })).deletedEntitlements, 0);
  assert.ok(await prisma.eventRecap.findUnique({ where: { id: saved.id } }));
  now = new Date('2026-10-13T12:00:00Z');
  assert.equal((await cleanupExpiredEntitlements({ client: prisma, now })).deletedEntitlements, 1);
  assert.equal(await prisma.eventRecap.count({ where: { id: saved.id } }), 0);
  assert.deepEqual(await recap(token), { state: 'none' });
});
