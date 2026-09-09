const { prisma: defaultPrisma } = require('../../../db');
const { appSettings } = require('../../../shared/config/appSettings');
const { getTimeZoneParts } = require('../../../shared/time/week');
const { buildRenewSeededRaces } = require('./seededRaceRenewal');
const { buildSeededChallengePreparation } = require('../services/seededChallengePreparation');
const { windowFor, upcomingWindowFor, acquireSeededWindowLock, readWindowMode, stampWindowMode } = require('../services/seededRaceBuckets');
const { filterInactiveUserIds } = require('../services/seededInactivity');
const { enqueueRaceResolution } = require('../services/enqueueRaceResolution');
const { buildSeededChallengeRetention } = require('./seededChallengeRetention');

const INTERVAL_MS = 60000;
function scheduleSeededChallengePreparation(dependencies = {}) {
  const role = dependencies.processRole || process.env.STEPS_PROCESS_ROLE || 'all';
  const instance = dependencies.instance ?? process.env.NODE_APP_INSTANCE ?? '0';
  if (!['cron', 'all'].includes(role) || String(instance) !== '0') return { stop() {}, async runNow() { return null; } };
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const settings = dependencies.appSettings || appSettings;
  const retention = buildSeededChallengeRetention({ ...dependencies, prisma, now });
  const renew = buildRenewSeededRaces({ ...dependencies, prisma, now, preparationCoordinator: true, enqueueRaceResolution });
  const dueWhere = () => ({ seedId: { not: null }, status: 'PENDING', scheduledStartAt: { lte: now() } });
  let lastLifecycleCheck = null;
  async function activateDue() {
    // Query/update bounded groups until the due set is drained, rather than
    // making group 33 wait for another minute. A stalled activation ends the
    // loop and takes precedence over nonurgent preparation on the next tick.
    for (;;) {
      const before = await prisma.race.count({ where: dueWhere() });
      if (!before) break;
      await renew({ phase: 'ACTIVATE' });
      const after = await prisma.race.count({ where: dueWhere() });
      if (after >= before) break;
    }
    lastLifecycleCheck = now().getTime();
  }
  function quietAt(at) {
    const parts = getTimeZoneParts(at, 'America/New_York');
    return (parts.hour === 23 && parts.minute >= 50) || (parts.hour === 0 && parts.minute < 10);
  }
  const preparation = buildSeededChallengePreparation({ ...dependencies, prisma, now,
    async beforePreparationBatch(record) {
      await dependencies.beforePreparationBatch?.(record);
      const at = now();
      if (lastLifecycleCheck === null || at.getTime() - lastLifecycleCheck >= 1000) await activateDue();
      if ((record.windowStart > at && quietAt(at)) || await prisma.race.count({ where: dueWhere() })) {
        const error = new Error('Preparation yielded to boundary work');
        error.code = 'PREPARATION_DEFERRED';
        throw error;
      }
    },
  });
  const transaction = fn => prisma.$transaction(fn, { timeout: 15000, maxWait: 2000 });
  let running = null, stopped = false;

  async function eligible(ids) {
    if (!ids.length || (await settings.getFlag('seededInactivityPruneEnabled')) !== true) return ids;
    const inactive = await filterInactiveUserIds({ userIds: ids, now: now(), prisma });
    return ids.filter(id => !inactive.has(id));
  }
  async function scanAutomatic(seed, record) {
    if (record.automaticScanCompleteAt) return;
    const acceptedAt = new Date(Math.min(now().getTime(), record.windowStart.getTime()));
    const users = await prisma.user.findMany({ where: { autoJoinFeaturedRaces: true, isReviewAccount: false,
      createdAt: { lt: record.windowStart }, OR: [
        { seededAutomaticEligibleAt: null }, { seededAutomaticEligibleAt: { lt: record.windowStart } },
      ],
      clientFeatures: { has: 'seeded_race_buckets' }, ...(record.automaticCursor ? { id: { gt: record.automaticCursor } } : {}) },
      select: { id: true }, orderBy: { id: 'asc' }, take: 500 });
    const ids = await eligible(users.map(user => user.id));
    await transaction(async tx => {
      await acquireSeededWindowLock(tx, seed.id, record.windowStart);
      const fresh = await tx.seededChallengePreparation.findUnique({ where: { id: record.id } });
      if (fresh.automaticCursor !== record.automaticCursor || fresh.automaticScanCompleteAt) return;
      // Preference/capability events that arrive after this page use their
      // durable exact-window outbox; no repeated population scan is needed.
      await tx.seededRaceWindowMembership.createMany({ data: ids.map(userId => ({ seedId: seed.id,
        windowStart: record.windowStart, userId, stream: 'BUCKET', admissionSource: 'AUTOMATIC', createdAt: acceptedAt })), skipDuplicates: true });
      await tx.seededChallengePreparation.update({ where: { id: record.id }, data: {
        automaticCursor: users.at(-1)?.id || record.automaticCursor,
        automaticScanCompleteAt: users.length < 500 ? now() : null,
      } });
    });
  }
  async function consumeIntents(seeds) {
    const requests = await prisma.seededChallengeEnrollmentRequest.findMany({ where: { state: 'PENDING', availableAt: { lte: now() } }, orderBy: [{ availableAt: 'asc' }, { id: 'asc' }], take: 500 });
    const bySeed = new Map(seeds.map(seed => [seed.id, seed]));
    const users = await prisma.user.findMany({ where: { id: { in: requests.map(row => row.userId) }, isReviewAccount: false }, select: { id: true, clientFeatures: true } });
    const existingUsers = new Set(users.map(user => user.id));
    const capable = new Set(users.filter(user => user.clientFeatures.includes('seeded_race_buckets')).map(user => user.id));
    const allowed = new Set(await eligible([...capable]));
    const batches = new Map();
    for (const request of requests) {
      const key = `${request.seedId}:${request.windowStart.toISOString()}`;
      if (!batches.has(key)) batches.set(key, []);
      batches.get(key).push(request);
    }
    for (const batch of batches.values()) {
      const first = batch[0], seed = bySeed.get(first.seedId);
      const mode = seed ? await readWindowMode({ prisma, seedId: seed.id, windowStart: first.windowStart }) : 'LEGACY';
      await transaction(async tx => {
        await acquireSeededWindowLock(tx, first.seedId, first.windowStart);
        const live = await tx.seededChallengeEnrollmentRequest.findMany({ where: { id: { in: batch.map(row => row.id) }, state: 'PENDING' } });
        const admitted = live.filter(row => seed && row.windowEnd > now() && (row.source === 'SIGNUP' ? existingUsers.has(row.userId) : capable.has(row.userId)) &&
          (row.source === 'SIGNUP' || allowed.has(row.userId)) && (mode === 'BUCKET' || row.source === 'SIGNUP'));
        await tx.seededRaceWindowMembership.createMany({ data: admitted.map(row => ({ seedId: row.seedId, windowStart: row.windowStart,
          userId: row.userId, stream: 'BUCKET', admissionSource: row.source === 'SIGNUP' ? 'SIGNUP' : 'AUTOMATIC', createdAt: row.requestedAt })), skipDuplicates: true });
        const memberships = await tx.seededRaceWindowMembership.findMany({ where: { seedId: first.seedId,
          windowStart: first.windowStart, userId: { in: live.map(row => row.userId) } }, select: { userId: true } });
        const completedUsers = new Set(memberships.map(row => row.userId));
        const completed = live.filter(row => completedUsers.has(row.userId) || row.windowEnd <= now() || !seed || !existingUsers.has(row.userId));
        await tx.seededChallengeEnrollmentRequest.updateMany({ where: { id: { in: completed.map(row => row.id) }, state: 'PENDING' }, data: { state: 'COMPLETE', leaseToken: null, leaseExpiresAt: null } });
        await tx.seededChallengeEnrollmentRequest.updateMany({ where: { id: { in: live.map(row => row.id) }, state: 'PENDING' }, data: { availableAt: new Date(now().getTime() + 60000) } });
      });
    }
  }
  async function repairs() {
    const rows = await prisma.$queryRaw`
      SELECT DISTINCT p.race_id AS "raceId" FROM seeded_challenge_membership_repairs t
      JOIN race_participants p ON p.id=t.source_participant_id
      WHERE t.state='PENDING' AND t.available_at<=${now()} ORDER BY p.race_id LIMIT 16`;
    for (const row of rows) await enqueueRaceResolution({ raceId: row.raceId, reason: 'MEMBERSHIP_CHANGED', now: now() });
  }
  async function tick() {
    // Due lifecycle work across ALL seeds wins before planning/history reads.
    await activateDue();
    if (await prisma.race.count({ where: dueWhere() })) return;
    const seeds = await prisma.raceSeed.findMany({ where: { active: true, kind: { in: ['DAILY_10K', 'WEEKLY_50K'] } }, take: 2 });
    const quiet = quietAt(now());
    // Exact accepted signup intentions must arbitrate their stream before a
    // compatibility population sweep can claim the same user/window.
    await consumeIntents(seeds);
    if (!quiet) await renew({ phase: 'MAINTENANCE' });
    await repairs();
    for (const seed of seeds) {
      const current = windowFor(seed, now());
      let existing = await prisma.seededChallengePreparation.findUnique({ where: { seedId_windowStart: { seedId: seed.id, windowStart: current.windowStart } } });
      if (await readWindowMode({ prisma, seedId: seed.id, windowStart: current.windowStart }) === 'BUCKET') {
        existing ||= await preparation.ensure(seed, current, current.windowStart);
        // Resume one bounded population page after a restart/boundary. Exact
        // accepted intents are consumed independently; late eligibility cannot
        // be mistaken for a pre-boundary election by this fallback scan.
        await scanAutomatic(seed, existing);
        existing = await prisma.seededChallengePreparation.findUnique({ where: { id: existing.id } });
      }
      const outstanding = await prisma.seededRaceWindowMembership.count({ where: { seedId: seed.id, windowStart: current.windowStart, stream: 'BUCKET', raceId: null } });
      if (outstanding || existing?.state === 'MATERIALIZING') await preparation.run(seed, existing || await preparation.ensure(seed, current, current.windowStart));
    }
    if (quiet) return;
    for (const seed of seeds) {
      const upcoming = upcomingWindowFor(seed, now());
      await stampWindowMode({ prisma, seedId: seed.id, ...upcoming,
        mode: (await settings.getFlag('seededRaceBucketsEnabled')) === true ? 'BUCKET' : 'LEGACY' });
      if (await readWindowMode({ prisma, seedId: seed.id, windowStart: upcoming.windowStart }) !== 'BUCKET') continue;
      const notBeforeAt = new Date(upcoming.windowStart.getTime() - (seed.cadence === 'WEEKLY' ? 45 : 30) * 60000);
      const record = await preparation.ensure(seed, upcoming, notBeforeAt);
      await scanAutomatic(seed, record);
      const refreshed = await prisma.seededChallengePreparation.findUnique({ where: { id: record.id } });
      if (refreshed.automaticScanCompleteAt && now() >= notBeforeAt) await preparation.run(seed, refreshed);
    }
    await retention();
  }
  function runNow() {
    if (stopped) return Promise.resolve(null);
    if (running) return running;
    running = tick().finally(() => { running = null; });
    return running;
  }
  const runScheduled = () => runNow().catch(error => logger.error('[CRON] Seeded preparation failed', error));
  const timer = (dependencies.setInterval || setInterval)(runScheduled, INTERVAL_MS);
  timer?.unref?.();
  if (dependencies.startImmediately !== false) runScheduled();
  return { runNow, async stop() { stopped = true; (dependencies.clearInterval || clearInterval)(timer); await running?.catch(() => {}); } };
}
module.exports = { scheduleSeededChallengePreparation, INTERVAL_MS };
