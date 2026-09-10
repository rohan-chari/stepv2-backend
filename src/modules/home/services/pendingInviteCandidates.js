const { prisma } = require('../../../db');
const { readFragment } = require('../../../shared/cache/cacheEfficiencyRead');
const presentation = require('../../social/services/userPresentationFragments');
const { metadataMany, countsMany } = require('../../races/services/raceDisplayFragments');
const FIELDS = ['createdAt', 'expiresAt', 'inviterId', 'participantId', 'raceId'];
const valid = value => Array.isArray(value) && value.length <= 512 && value.every(row =>
  row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).sort().join(',') === FIELDS.join(',') &&
  ['participantId', 'raceId', 'inviterId'].every(field => typeof row[field] === 'string') &&
  Number.isFinite(Date.parse(row.createdAt)) && (row.expiresAt === null || Number.isFinite(Date.parse(row.expiresAt))));
async function load(userId) {
  const rows = [];
  // Existing response includes every eligible invitation. Bound each query;
  // large accounts bypass caching instead of truncating the frozen response.
  for (let skip = 0; ; skip += 256) {
    const page = await prisma.raceParticipant.findMany({
      where: { userId, status: 'INVITED' }, take: 256, skip,
      select: { id: true, raceId: true, joinedAt: true, inviteExpiresAt: true, race: { select: { creatorId: true } } },
      orderBy: [{ inviteExpiresAt: 'asc' }, { joinedAt: 'asc' }, { id: 'asc' }],
    });
    rows.push(...page.map(row => ({ participantId: row.id, raceId: row.raceId, inviterId: row.race.creatorId,
      createdAt: row.joinedAt.toISOString(), expiresAt: row.inviteExpiresAt?.toISOString() ?? null })));
    if (page.length < 256) return rows;
  }
}
async function read(userId, now) {
  const { value } = await readFragment({ kind: 'invites', key: `ce:v1:invites:${userId}`,
    markers: [{ domain: 'invites', identity: userId }], ttlMs: 60000, load: () => load(userId), validate: valid });
  const candidates = value.filter(row => row.expiresAt === null || Date.parse(row.expiresAt) > now.getTime());
  if (!candidates.length) return [];
  const current = new Map();
  for (let i = 0; i < candidates.length; i += 256) {
    const rows = await prisma.raceParticipant.findMany({
      where: { id: { in: candidates.slice(i, i + 256).map(row => row.participantId) }, userId, status: 'INVITED',
        race: { status: 'PENDING' }, OR: [{ inviteExpiresAt: null }, { inviteExpiresAt: { gt: now } }] },
      select: { id: true, raceId: true, inviteExpiresAt: true, joinedAt: true,
        race: { select: { id: true, status: true, maxDurationDays: true } } },
    });
    for (const row of rows) current.set(row.id, row);
  }
  const eligible = candidates.filter(row => current.has(row.participantId));
  if (!eligible.length) return [];
  const raceIds = eligible.map(row => row.raceId);
  const [metadata, counts, people] = await Promise.all([
    metadataMany(raceIds), countsMany(raceIds), presentation.getMany(eligible.map(row => row.inviterId)),
  ]);
  const itemIds = [...new Set([...people.values()].flatMap(user => user.equipment.map(row => row.shopItemId)))];
  const catalog = new Map();
  for (let i = 0; i < itemIds.length; i += 256) {
    for (const row of await prisma.shopItem.findMany({ where: { id: { in: itemIds.slice(i, i + 256) } } })) catalog.set(row.id, row);
  }
  return eligible.flatMap(candidate => {
    const row = current.get(candidate.participantId), meta = metadata.get(candidate.raceId), user = people.get(candidate.inviterId);
    if (!meta || !user) return [];
    const creator = { ...user, equippedAccessories: user.equipment.filter(ref => catalog.has(ref.shopItemId)).map(ref => ({ slot: ref.slot, shopItem: catalog.get(ref.shopItemId) })) };
    return [{ joinedAt: row.joinedAt, inviteExpiresAt: row.inviteExpiresAt,
      race: { ...meta, ...row.race, creator, _count: { participants: counts.get(candidate.raceId)?.totalCount ?? 0 } } }];
  });
}
module.exports = { read };
