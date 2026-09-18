const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { describe, it, before, beforeEach, after } = require('node:test');
const { cleanDatabase, createTestUser, startServer, prisma, request } = require('./setup');
const { scheduleSeededChallengePreparation } = require('../../src/modules/races/jobs/seededChallengePreparation');
const { buildRaceResolutionWorkerV2 } = require('../../src/modules/races/jobs/raceResolutionQueueV2');
const HEADERS = { 'X-Client-Features': 'seeded_race_buckets' };

// Exercise the production scheduler entrypoint and real HTTP admission. The
// only substitutions are time and the interval driver; no membership service
// is called by this suite.
describe('early seeded preparation and HTTP joins', () => {
  let server, clock, scheduler, batchHook;
  before(async () => { server = await startServer({ now: () => new Date(clock) }); });
  after(async () => { scheduler?.stop(); await server.close(); });
  beforeEach(async () => {
    scheduler?.stop();
    await cleanDatabase();
    clock = '2026-09-10T03:29:00Z';
    batchHook = null;
    const seeds = await prisma.raceSeed.findMany({ where: { kind: { in: ['DAILY_10K', 'WEEKLY_50K'] } } });
    await prisma.seededRaceWindowModeRecord.createMany({ data: seeds.map(seed => ({ seedId: seed.id, mode: 'BUCKET',
      windowStart: new Date(seed.cadence === 'WEEKLY' ? '2026-09-14T04:00:00Z' : '2026-09-10T04:00:00Z'),
      windowEnd: new Date(seed.cadence === 'WEEKLY' ? '2026-09-21T04:00:00Z' : '2026-09-11T04:00:00Z') })) });
    scheduler = scheduleSeededChallengePreparation({ prisma, now: () => new Date(clock),
      setInterval: () => ({ unref() {} }), clearInterval() {}, startImmediately: false,
      beforePreparationBatch: record => batchHook?.(record),
      logger: { log() {}, error() {} }, processRole: 'cron', instance: '0' });
  });
  async function elect(token, kind = 'DAILY_10K') {
    const response = await request(server.baseUrl, 'POST', `/races/seeded/${kind}/assign`, { token, headers: HEADERS });
    assert.equal(response.status, 202, await response.clone().text());
  }
  async function join(token) {
    return request(server.baseUrl, 'POST', '/races/seeded/DAILY_10K/join-current', {
      token, headers: HEADERS, body: { requestId: randomUUID() },
    });
  }
  it('starts daily planning at 23:30, publishes capped reservations, and still accepts elections', async () => {
    const accounts = [];
    for (let i = 0; i < 38; i++) accounts.push(await createTestUser({ autoJoinFeaturedRaces: false }));
    for (const account of accounts.slice(0, 37)) await elect(account.token);
    await scheduler.runNow();
    assert.equal(await prisma.seededChallengePreparation.count({ where: { windowStart: new Date('2026-09-10T04:00:00Z'), publishedAt: { not: null } } }), 0);
    clock = '2026-09-10T03:30:00Z';
    for (let i = 0; i < 8; i++) await scheduler.runNow();
    const preparation = await prisma.seededChallengePreparation.findFirst({ where: { windowStart: new Date('2026-09-10T04:00:00Z') } });
    assert.ok(preparation?.publishedAt);
    const groups = await prisma.seededChallengePreparationGroup.findMany({ where: { preparationId: preparation.id } });
    assert.equal(groups.reduce((sum, group) => sum + group.members.length, 0), 37);
    assert.ok(groups.every(group => group.members.length <= 35));
    await elect(accounts[37].token);
    clock = '2026-09-10T04:01:00Z';
    const response = await join(accounts[0].token);
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.scoringStartsAt, '2026-09-10T04:00:00.000Z');
    assert.equal(result.raceStatus, 'ACTIVE');
    assert.equal((await request(server.baseUrl, 'GET', `/races/${result.raceId}`, { token: accounts[0].token, headers: HEADERS })).status, 200);
    // HTTP may create the caller's shell but must never bulk-admit its group.
    assert.equal(await prisma.raceParticipant.count({ where: { raceId: result.raceId } }), 1);
  });
  it('resumes an interrupted automatic scan beyond 500 users after midnight', async () => {
    const ids = Array.from({ length: 501 }, () => randomUUID()).sort();
    await prisma.user.createMany({ data: ids.map(id => ({ id, appleId: `scan-${id}`,
      autoJoinFeaturedRaces: true, clientFeatures: ['seeded_race_buckets'],
      // These users were already eligible before the captured boundary. The
      // insertion trigger otherwise stamps eligibility with today's DB clock.
      seededAutomaticEligibleAt: new Date('2026-09-01T00:00:00Z'),
      createdAt: new Date('2026-09-01T00:00:00Z') })) });
    for (const day of ['2026-09-08', '2026-09-09']) {
      await prisma.stepSample.createMany({ data: ids.map(userId => ({ userId, steps: 1000,
        periodStart: new Date(`${day}T12:00:00Z`), periodEnd: new Date(`${day}T12:05:00Z`) })) });
    }
    await scheduler.runNow();
    const seed = await prisma.raceSeed.findUnique({ where: { kind: 'DAILY_10K' } });
    const windowStart = new Date('2026-09-10T04:00:00Z');
    const record = await prisma.seededChallengePreparation.findUnique({ where: { seedId_windowStart: { seedId: seed.id, windowStart } } });
    assert.equal(record.automaticCursor, ids[499]);
    assert.equal(record.automaticScanCompleteAt, null);
    clock = '2026-09-10T04:01:00Z';
    await scheduler.runNow();
    const recovered = await prisma.seededRaceWindowMembership.findMany({ where: { seedId: seed.id, windowStart } });
    assert.equal(recovered.length, 501, 'The unfinished population page must resume for the current window');
    assert.equal(recovered.find(row => row.userId === ids[500]).createdAt.toISOString(), windowStart.toISOString());
    assert.ok((await prisma.seededChallengePreparation.findUnique({ where: { id: record.id } })).automaticScanCompleteAt);
  });
  it('cold recovery excludes post-boundary eligibility and retains legacy eligible users', async () => {
    const seed = await prisma.raceSeed.findUnique({ where: { kind: 'DAILY_10K' } });
    const windowStart = new Date('2026-09-10T04:00:00Z');
    const old = await createTestUser({ autoJoinFeaturedRaces: true });
    const late = await createTestUser({ autoJoinFeaturedRaces: true });
    await prisma.user.updateMany({ where: { id: { in: [old.user.id, late.user.id] } }, data: {
      clientFeatures: ['seeded_race_buckets'], createdAt: new Date('2026-09-01T00:00:00Z') } });
    // Historical NULL represents a user already eligible when the additive
    // migration landed. The other row models a post-boundary ON transition.
    await prisma.user.update({ where: { id: old.user.id }, data: { seededAutomaticEligibleAt: null } });
    await prisma.user.update({ where: { id: late.user.id }, data: { seededAutomaticEligibleAt: new Date('2026-09-10T04:00:30Z') } });
    for (const day of ['2026-09-08', '2026-09-09']) await prisma.stepSample.createMany({ data: [old, late].map(account => ({
      userId: account.user.id, steps: 1000, periodStart: new Date(`${day}T12:00:00Z`), periodEnd: new Date(`${day}T12:05:00Z`) })) });
    clock = '2026-09-10T04:01:00Z';
    await scheduler.runNow();
    assert.equal(await prisma.seededRaceWindowMembership.count({ where: { seedId: seed.id, windowStart, userId: old.user.id } }), 1);
    assert.equal(await prisma.seededRaceWindowMembership.count({ where: { seedId: seed.id, windowStart, userId: late.user.id } }), 0);
    const response = await join(old.token);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).scoringStartsAt, windowStart.toISOString());
  });
  it('HTTP workers never start the preparation coordinator', async () => {
    const inactive = scheduleSeededChallengePreparation({ processRole: 'http', setInterval() { throw new Error('HTTP scheduled cron'); } });
    assert.equal(await inactive.runNow(), null);
    inactive.stop();
  });
  it('the canonical worker materializes an empty reserved shell before reading its roster', async () => {
    const accounts = [];
    for (let i = 0; i < 3; i++) accounts.push(await createTestUser({ autoJoinFeaturedRaces: false }));
    for (const account of accounts) await elect(account.token);
    clock = '2026-09-10T03:30:00Z';
    await scheduler.runNow();
    const group = await prisma.seededChallengePreparationGroup.findFirst({ orderBy: { createdAt: 'asc' } });
    assert.ok(group);
    assert.equal(await prisma.raceParticipant.count({ where: { raceId: group.reservedRaceId } }), 0);
    const worker = buildRaceResolutionWorkerV2({ prisma, now: () => new Date(clock), processRole: 'all', logger: { log() {}, error() {}, warn() {} } });
    await worker.processRace({ raceId: group.reservedRaceId });
    assert.equal(await prisma.raceParticipant.count({ where: { raceId: group.reservedRaceId, status: 'ACCEPTED' } }), 3);
    assert.equal(await prisma.raceResolutionPostTask.count({ where: { raceId: group.reservedRaceId } }), 0);
    assert.equal(await prisma.racePlacementTransitionJob.count({ where: { raceId: group.reservedRaceId } }), 0);
    const detail = await request(server.baseUrl, 'GET', `/races/${group.reservedRaceId}`, { token: accounts[0].token, headers: HEADERS });
    assert.equal(detail.status, 200, await detail.clone().text());
  });
  it('yields an unpublished future plan at 23:50 and recovers its reservations at midnight', async () => {
    const first = await createTestUser({ autoJoinFeaturedRaces: false });
    const second = await createTestUser({ autoJoinFeaturedRaces: false });
    await elect(first.token); await elect(second.token);
    clock = '2026-09-10T03:49:59Z';
    batchHook = () => { clock = '2026-09-10T03:50:00Z'; batchHook = null; };
    await scheduler.runNow();
    const interrupted = await prisma.seededChallengePreparation.findFirst({ where: { windowStart: new Date('2026-09-10T04:00:00Z') } });
    assert.equal(interrupted.publishedAt, null);
    assert.equal(interrupted.lastErrorCode, 'Preparation yielded to boundary work');
    clock = '2026-09-10T04:00:00Z';
    await scheduler.runNow();
    const recovered = await prisma.seededChallengePreparation.findUnique({ where: { id: interrupted.id } });
    assert.ok(recovered.publishedAt);
    assert.notEqual(recovered.generation, interrupted.generation);
    const response = await join(first.token);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).scoringStartsAt, '2026-09-10T04:00:00.000Z');
    assert.equal(await prisma.seededRaceWindowMembership.count({ where: { userId: { in: [first.user.id, second.user.id] }, windowStart: recovered.windowStart } }), 2);
  });
  it('starts weekly planning on Sunday at 23:15 and keeps current weekly Join available', async () => {
    clock = '2026-09-14T03:14:00Z';
    const account = await createTestUser({ autoJoinFeaturedRaces: false });
    await elect(account.token, 'WEEKLY_50K');
    await scheduler.runNow();
    const seed = await prisma.raceSeed.findUnique({ where: { kind: 'WEEKLY_50K' } });
    const before = await prisma.seededChallengePreparation.findFirst({ where: { seedId: seed.id } });
    assert.equal(before.publishedAt, null);
    clock = '2026-09-14T03:15:00Z';
    await scheduler.runNow();
    assert.ok((await prisma.seededChallengePreparation.findUnique({ where: { id: before.id } })).publishedAt);
    const response = await request(server.baseUrl, 'POST', '/races/seeded/WEEKLY_50K/join-current', { token: account.token, headers: HEADERS, body: { requestId: randomUUID() } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).windowStart, '2026-09-07T04:00:00.000Z');
  });
  it('a stale worker lease cannot materialize reservations, and the next owner recovers them', async () => {
    const account = await createTestUser({ autoJoinFeaturedRaces: false });
    await elect(account.token);
    clock = '2026-09-10T03:30:00Z';
    await scheduler.runNow();
    const group = await prisma.seededChallengePreparationGroup.findFirst();
    const replacement = randomUUID();
    const stale = buildRaceResolutionWorkerV2({ prisma, now: () => new Date(clock), processRole: 'all',
      logger: { log() {}, error() {}, warn() {} },
      async beforeSeededMembershipWrite({ job }) {
        await prisma.raceResolutionJobV2.update({ where: { id: job.id }, data: { leaseToken: replacement } });
      },
    });
    await stale.processRace({ raceId: group.reservedRaceId });
    assert.equal(await prisma.raceParticipant.count({ where: { raceId: group.reservedRaceId } }), 0);
    assert.equal((await prisma.raceResolutionJobV2.findUnique({ where: { raceId: group.reservedRaceId } })).leaseToken, replacement);
    await prisma.raceResolutionJobV2.update({ where: { raceId: group.reservedRaceId }, data: { leaseExpiresAt: new Date(new Date(clock).getTime() - 1) } });
    const next = buildRaceResolutionWorkerV2({ prisma, now: () => new Date(clock), processRole: 'all', logger: { log() {}, error() {}, warn() {} } });
    await next.processRace({ raceId: group.reservedRaceId });
    const detail = await request(server.baseUrl, 'GET', `/races/${group.reservedRaceId}`, { token: account.token, headers: HEADERS });
    assert.equal(detail.status, 200, await detail.clone().text());
    assert.equal(await prisma.raceParticipant.count({ where: { raceId: group.reservedRaceId, status: 'ACCEPTED' } }), 1);
  });
  it('activates an empty compatibility race without scheduling empty scoring and placement work', async () => {
    await scheduler.runNow();
    const race = await prisma.race.findFirst({ where: { seededBucketId: null, status: 'PENDING', scheduledStartAt: new Date('2026-09-10T04:00:00Z') } });
    assert.ok(race);
    clock = '2026-09-10T04:00:00Z';
    await scheduler.runNow();
    assert.equal((await prisma.race.findUnique({ where: { id: race.id } })).status, 'ACTIVE');
    assert.equal((await prisma.raceResolutionJobV2.findUnique({ where: { raceId: race.id } })).generation, 0);
    const account = await createTestUser({ autoJoinFeaturedRaces: false });
    const featured = await request(server.baseUrl, 'GET', '/races/featured', { token: account.token, headers: HEADERS });
    assert.equal(featured.status, 200);
  });
});
