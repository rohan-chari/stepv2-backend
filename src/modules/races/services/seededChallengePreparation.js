const { randomUUID } = require('node:crypto');
const { prisma: defaultPrisma } = require('../../../db');
const { appSettings } = require('../../../shared/config/appSettings');
const { planBuckets, matchStepsForCandidates, cohortMinimumForSeed, cohortMaximumForSeed,
  acquireSeededWindowLock } = require('./seededRaceBuckets');
const { buildSeededChallengeAdmission } = require('./seededChallengeAdmission');
const { acquireRaceWriteFence } = require('./raceWriteFence');
const { enqueueRaceResolution } = require('./enqueueRaceResolution');

const PAGE_SIZE = 500;
const LEASE_MS = 120000;
const PUBLISHED = ['PUBLISHED', 'MATERIALIZING', 'COMPLETE'];
class PreparationLeaseLost extends Error {}

function buildSeededChallengePreparation(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const admission = buildSeededChallengeAdmission({ ...dependencies, prisma, now });
  const settings = dependencies.appSettings || appSettings;
  const transaction = (fn) => prisma.$transaction(fn, { timeout: 15000, maxWait: 2000 });
  const beforeBatch = record => dependencies.beforePreparationBatch?.(record);

  async function guarded(tx, preparation) {
    await acquireSeededWindowLock(tx, preparation.seedId, preparation.windowStart);
    const result = await tx.seededChallengePreparation.updateMany({
      where: { id: preparation.id, generation: preparation.generation, leaseToken: preparation.leaseToken,
        leaseExpiresAt: { gt: now() } },
      data: { leaseExpiresAt: new Date(now().getTime() + LEASE_MS) },
    });
    if (result.count !== 1) throw new PreparationLeaseLost('Preparation lease changed');
  }

  async function ensure(seed, window, notBeforeAt) {
    return prisma.seededChallengePreparation.upsert({
      where: { seedId_windowStart: { seedId: seed.id, windowStart: window.windowStart } },
      create: { seedId: seed.id, ...window, generation: randomUUID(), notBeforeAt }, update: {},
    });
  }

  async function claim(id) {
    return transaction(async tx => {
      const record = await tx.seededChallengePreparation.findUnique({ where: { id } });
      if (!record || record.notBeforeAt > now()) return null;
      await acquireSeededWindowLock(tx, record.seedId, record.windowStart);
      const fresh = await tx.seededChallengePreparation.findUnique({ where: { id } });
      if (fresh.leaseExpiresAt && fresh.leaseExpiresAt > now()) return null;
      // Only a crashed unpublished generation may be replaced. Clearing its
      // pointers is a separate bounded state; published rosters are immutable.
      const abandoned = !PUBLISHED.includes(fresh.state) && fresh.leaseToken;
      return tx.seededChallengePreparation.update({ where: { id }, data: {
        state: abandoned ? 'CLEANING' : fresh.state,
        leaseToken: randomUUID(), leaseExpiresAt: new Date(now().getTime() + LEASE_MS),
      } });
    });
  }

  async function cleanup(preparation) {
    for (;;) {
      await beforeBatch(preparation);
      const groups = await prisma.seededChallengePreparationGroup.findMany({
        where: { preparationId: preparation.id, generation: preparation.generation }, take: 1, orderBy: { ordinal: 'asc' },
      });
      if (!groups.length) break;
      await transaction(async tx => {
        await guarded(tx, preparation);
        await tx.seededRaceWindowMembership.updateMany({ where: { preparationGroupId: groups[0].id }, data: { preparationGroupId: null } });
        await tx.seededChallengePreparationGroup.delete({ where: { id: groups[0].id } });
      });
    }
    return transaction(async tx => {
      await guarded(tx, preparation);
      return tx.seededChallengePreparation.update({ where: { id: preparation.id }, data: {
        state: 'PLANNING', generation: randomUUID(), snapshotSequence: 0n, planningCursor: 0,
        validationCursor: 0n, expectedSnapshotCount: 0, publishedAt: null,
      } });
    });
  }

  async function plan(seed, preparation) {
    preparation = await transaction(async tx => {
      await guarded(tx, preparation);
      const where = { seedId: seed.id, windowStart: preparation.windowStart, stream: 'BUCKET', raceId: null };
      const snapshot = await tx.seededRaceWindowMembership.aggregate({ where, _max: { electionSequence: true }, _count: true });
      return tx.seededChallengePreparation.update({ where: { id: preparation.id }, data: {
        snapshotSequence: snapshot._max.electionSequence || 0n,
        expectedSnapshotCount: snapshot._count, startedAt: now(),
      } });
    });
    // Population matching is read outside membership locks, with bounded
    // history and friendship queries. Only one capped group is persisted in
    // any transaction. A crash takes the CLEANING path before replanning.
    const candidates = [], friendships = [];
    let cursor = 0n;
    while (cursor < preparation.snapshotSequence) {
      await beforeBatch(preparation);
      const page = await prisma.seededRaceWindowMembership.findMany({
        where: { seedId: seed.id, windowStart: preparation.windowStart, stream: 'BUCKET', raceId: null,
          electionSequence: { gt: cursor, lte: preparation.snapshotSequence } },
        orderBy: { electionSequence: 'asc' }, take: PAGE_SIZE, select: { userId: true, electionSequence: true },
      });
      if (!page.length) break;
      cursor = page.at(-1).electionSequence;
      candidates.push(...await matchStepsForCandidates({ prisma, candidates: page.map(({ userId }) => ({ userId })), seed, windowStart: preparation.windowStart }));
      const edges = await prisma.friendship.findMany({ where: { status: 'ACCEPTED', requesterId: { in: page.map(row => row.userId) } },
        select: { requesterId: true, addresseeId: true } });
      friendships.push(...edges.map(row => ({ userAId: row.requesterId, userBId: row.addresseeId })));
      await transaction(tx => guarded(tx, preparation));
    }
    const groups = planBuckets(candidates, friendships, cohortMinimumForSeed(seed), cohortMaximumForSeed(seed));
    for (let ordinal = 0; ordinal < groups.length; ordinal++) {
      await beforeBatch(preparation);
      await transaction(async tx => {
        await guarded(tx, preparation);
        const planned = groups[ordinal];
        const eligible = await tx.seededRaceWindowMembership.findMany({ where: {
          seedId: seed.id, windowStart: preparation.windowStart, stream: 'BUCKET', raceId: null,
          userId: { in: planned.map(row => row.userId) }, preparationGroupId: null,
        }, select: { id: true, userId: true } });
        const ids = new Set(eligible.map(row => row.userId));
        const members = planned.filter(row => ids.has(row.userId));
        if (members.length) {
          const group = await tx.seededChallengePreparationGroup.create({ data: {
            preparationId: preparation.id, generation: preparation.generation, ordinal,
            reservedRaceId: randomUUID(), reservedBucketId: randomUUID(), members,
          } });
          await tx.seededRaceWindowMembership.updateMany({ where: { id: { in: eligible.map(row => row.id) }, raceId: null }, data: { preparationGroupId: group.id } });
        }
        await tx.seededChallengePreparation.update({ where: { id: preparation.id }, data: { planningCursor: ordinal + 1 } });
      });
    }
    await transaction(async tx => {
      await guarded(tx, preparation);
      await tx.seededChallengePreparation.update({ where: { id: preparation.id }, data: { state: 'VALIDATING' } });
    });
    cursor = 0n;
    while (cursor < preparation.snapshotSequence) {
      await beforeBatch(preparation);
      const next = await transaction(async tx => {
        await guarded(tx, preparation);
        const page = await tx.seededRaceWindowMembership.findMany({ where: {
          seedId: seed.id, windowStart: preparation.windowStart, stream: 'BUCKET',
          electionSequence: { gt: cursor, lte: preparation.snapshotSequence },
        }, orderBy: { electionSequence: 'asc' }, take: PAGE_SIZE });
        const unassigned = page.filter(row => !row.raceId);
        const groupsForPage = await tx.seededChallengePreparationGroup.findMany({ where: {
          id: { in: unassigned.map(row => row.preparationGroupId).filter(Boolean) }, preparationId: preparation.id, generation: preparation.generation,
        }, select: { id: true, members: true } });
        const byId = new Map(groupsForPage.map(group => [group.id, new Set(group.members.map(member => member.userId))]));
        if (unassigned.some(row => !byId.get(row.preparationGroupId)?.has(row.userId))) throw new Error('INCOMPLETE_PREPARATION_SNAPSHOT');
        const end = page.at(-1)?.electionSequence || preparation.snapshotSequence;
        await tx.seededChallengePreparation.update({ where: { id: preparation.id }, data: { validationCursor: end } });
        return end;
      });
      cursor = next;
    }
    return transaction(async tx => {
      await guarded(tx, preparation);
      return tx.seededChallengePreparation.update({ where: { id: preparation.id }, data: { state: 'PUBLISHED', publishedAt: now() } });
    });
  }

  async function incremental(seed, preparation) {
    const page = await prisma.seededRaceWindowMembership.findMany({ where: {
      seedId: seed.id, windowStart: preparation.windowStart, stream: 'BUCKET', raceId: null, preparationGroupId: null,
    }, take: PAGE_SIZE, orderBy: { electionSequence: 'asc' }, select: { id: true, userId: true } });
    if (!page.length) return;
    const scored = await matchStepsForCandidates({ prisma, candidates: page, seed, windowStart: preparation.windowStart });
    // Keep accepted rosters fixed. New elections are first assigned to existing
    // reserved capacity; only excess gets a new bounded group.
    for (let offset = 0; offset < scored.length;) {
      await beforeBatch(preparation);
      const consumed = await transaction(async tx => {
        await guarded(tx, preparation);
        const maximum = cohortMaximumForSeed(seed);
        const room = await tx.$queryRaw`
          SELECT g.id FROM seeded_challenge_preparation_groups g
          LEFT JOIN race_accepted_participant_counts c ON c.race_id=g.reserved_race_id
          WHERE g.preparation_id=${preparation.id} AND g.generation=${preparation.generation}
            AND COALESCE(c.accepted_count,0) + (SELECT count(*) FROM seeded_race_window_memberships m
              WHERE m.preparation_group_id=g.id AND m.race_id IS NULL) < ${maximum}
          ORDER BY g.ordinal LIMIT 1`;
        let group = room.length ? await tx.seededChallengePreparationGroup.findUnique({ where: { id: room[0].id } }) : null;
        const accepted = group ? await tx.raceParticipant.count({ where: { raceId: group.reservedRaceId, status: 'ACCEPTED' } }) : 0;
        const reserved = group ? await tx.seededRaceWindowMembership.count({ where: { preparationGroupId: group.id, raceId: null } }) : 0;
        const batch = scored.slice(offset, offset + maximum - accepted - reserved);
        if (!batch.length) return 0;
        const eligible = await tx.seededRaceWindowMembership.findMany({ where: { id: { in: batch.map(row => row.id) }, raceId: null, preparationGroupId: null }, select: { id: true, userId: true } });
        const ids = new Set(eligible.map(row => row.userId));
        const members = batch.filter(row => ids.has(row.userId)).map(({ userId, matchSteps }) => ({ userId, matchSteps }));
        if (members.length) {
          if (group) {
            // Keep the payload bounded even when pruning freed an old slot.
            const retained = await tx.seededRaceWindowMembership.findMany({ where: { preparationGroupId: group.id, userId: { in: group.members.map(row => row.userId) } }, select: { userId: true } });
            const keep = new Set(retained.map(row => row.userId));
            const existing = group.members.filter(row => keep.has(row.userId));
            if (existing.length + members.length > maximum) group = null;
            else group = await tx.seededChallengePreparationGroup.update({ where: { id: group.id }, data: { members: [...existing, ...members], state: 'RESERVED', materializedAt: null } });
          }
          if (!group) {
            const last = await tx.seededChallengePreparationGroup.aggregate({ where: { preparationId: preparation.id, generation: preparation.generation }, _max: { ordinal: true } });
            group = await tx.seededChallengePreparationGroup.create({ data: { preparationId: preparation.id, generation: preparation.generation,
              ordinal: (last._max.ordinal ?? -1) + 1, reservedRaceId: randomUUID(), reservedBucketId: randomUUID(), members } });
          }
          await tx.seededRaceWindowMembership.updateMany({ where: { id: { in: eligible.map(row => row.id) } }, data: { preparationGroupId: group.id } });
          await tx.seededChallengePreparation.update({ where: { id: preparation.id }, data: { state: 'MATERIALIZING', completedAt: null } });
        }
        return batch.length;
      });
      if (!consumed) break;
      offset += consumed;
    }
  }

  async function publishShells(seed, preparation) {
    // Recover a lost/terminal worker attempt without continually bumping live
    // generations. A QUEUED group is complete only after the worker marks it.
    const stranded = await prisma.$queryRaw`
      SELECT g.id FROM seeded_challenge_preparation_groups g
      LEFT JOIN race_resolution_jobs_v2 j ON j.race_id=g.reserved_race_id
      WHERE g.preparation_id=${preparation.id} AND g.generation=${preparation.generation}
        AND g.state='QUEUED' AND (j.id IS NULL OR j.state IN ('succeeded','failed'))
      ORDER BY g.ordinal LIMIT 16`;
    if (stranded.length) await transaction(async tx => {
      await guarded(tx, preparation);
      await tx.seededChallengePreparationGroup.updateMany({ where: { id: { in: stranded.map(row => row.id) }, state: 'QUEUED' }, data: { state: 'RESERVED' } });
    });
    const groups = await prisma.seededChallengePreparationGroup.findMany({ where: { preparationId: preparation.id, generation: preparation.generation, state: 'RESERVED' }, take: 16, orderBy: { ordinal: 'asc' } });
    for (const group of groups) {
      await beforeBatch(preparation);
      const data = await admission.raceData(seed, preparation, group.reservedRaceId, now() >= preparation.windowStart);
      await transaction(async tx => {
        await tx.race.createMany({ data: [data], skipDuplicates: true });
        await acquireRaceWriteFence(tx, group.reservedRaceId);
        await guarded(tx, preparation);
        const fresh = await tx.seededChallengePreparationGroup.findUnique({ where: { id: group.id } });
        if (fresh?.state !== 'RESERVED') return;
        await tx.seededRaceBucket.createMany({ data: [{ id: group.reservedBucketId, seedId: seed.id, raceId: group.reservedRaceId,
          windowStart: preparation.windowStart, windowEnd: preparation.windowEnd, status: data.status, admissionVersion: 1 }], skipDuplicates: true });
        await tx.race.updateMany({ where: { id: group.reservedRaceId, seededBucketId: null }, data: { seededBucketId: group.reservedBucketId } });
        await enqueueRaceResolution({ raceId: group.reservedRaceId, now: now(), reason: 'MEMBERSHIP_CHANGED' }, tx);
        await tx.seededChallengePreparationGroup.update({ where: { id: group.id }, data: { state: 'QUEUED' } });
      });
    }
    await transaction(async tx => {
      await guarded(tx, preparation);
      const outstanding = await tx.seededRaceWindowMembership.count({ where: { seedId: seed.id, windowStart: preparation.windowStart, stream: 'BUCKET', raceId: null } });
      await tx.seededChallengePreparation.update({ where: { id: preparation.id }, data: { state: outstanding ? 'MATERIALIZING' : 'COMPLETE', completedAt: outstanding ? null : now() } });
    });
    return groups.length;
  }

  async function run(seed, record) {
    let preparation = await claim(record.id);
    if (!preparation) return null;
    try {
      if (preparation.state === 'CLEANING') preparation = await cleanup(preparation);
      if (!PUBLISHED.includes(preparation.state)) preparation = await plan(seed, preparation);
      await incremental(seed, preparation);
      // Every write remains one group; continue bounded pages in this tick so
      // a 5,000-person recovery does not add one minute per sixteen groups.
      // beforeBatch yields to the quiet window/activation between every group.
      while (await publishShells(seed, preparation) === 16) {}
      return preparation.id;
    } catch (error) {
      await prisma.seededChallengePreparation.updateMany({ where: { id: preparation.id, generation: preparation.generation, leaseToken: preparation.leaseToken }, data: { lastErrorCode: error.message.slice(0, 200), leaseExpiresAt: now() } });
      if (error.code === 'PREPARATION_DEFERRED') return null;
      throw error;
    } finally {
      // Leave the token on failed unpublished work: the next owner must clean
      // it before planning. Successful published work resumes without repack.
      await prisma.seededChallengePreparation.updateMany({ where: { id: preparation.id, generation: preparation.generation, leaseToken: preparation.leaseToken, state: { in: PUBLISHED } }, data: { leaseToken: null, leaseExpiresAt: null } });
    }
  }
  return { ensure, run };
}
module.exports = { buildSeededChallengePreparation, PAGE_SIZE, PreparationLeaseLost };
