const { Prisma } = require('@prisma/client');
const { prisma } = require('../../../db');
const { readFragment } = require('../../../shared/cache/cacheEfficiencyRead');
const META_FIELDS = ['id', 'name', 'creatorId', 'startedAt', 'endsAt', 'scheduledStartAt', 'scheduledEndAt', 'timezone', 'isTeamRace', 'teamSize', 'teamAName', 'teamBName', 'tournamentId', 'tournamentRound', 'tournamentMatchIndex'];
const COUNT_FIELDS = ['totalCount', 'acceptedCount', 'teamACount', 'teamBCount'];
const metaSelect = Object.fromEntries(META_FIELDS.map(field => [field, true]));
function validMetadata(value) {
  return value && Object.keys(value).length === META_FIELDS.length && META_FIELDS.every(field => Object.hasOwn(value, field)) &&
    ['id', 'name', 'creatorId'].every(field => typeof value[field] === 'string') && typeof value.isTeamRace === 'boolean' &&
    ['startedAt', 'endsAt', 'scheduledStartAt', 'scheduledEndAt'].every(field => value[field] === null || Number.isFinite(Date.parse(value[field]))) &&
    ['timezone', 'teamAName', 'teamBName', 'tournamentId'].every(field => value[field] === null || typeof value[field] === 'string') &&
    ['teamSize', 'tournamentRound', 'tournamentMatchIndex'].every(field => value[field] === null || Number.isSafeInteger(value[field]));
}
function validCounts(value) {
  return value && Object.keys(value).length === COUNT_FIELDS.length && COUNT_FIELDS.every(field => Number.isSafeInteger(value[field]) && value[field] >= 0);
}
async function loadMetadata(ids) {
  return new Map((await prisma.race.findMany({ where: { id: { in: ids } }, select: metaSelect })).map(row => [row.id, JSON.parse(JSON.stringify(row))]));
}
async function loadCounts(ids) {
  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT race_id AS id, count(*)::int AS "totalCount",
      count(*) FILTER (WHERE status='accepted')::int AS "acceptedCount",
      count(*) FILTER (WHERE status='accepted' AND team='team_a')::int AS "teamACount",
      count(*) FILTER (WHERE status='accepted' AND team='team_b')::int AS "teamBCount"
    FROM race_participants WHERE race_id IN (${Prisma.join(ids)}) GROUP BY race_id
  `);
  const map = new Map(ids.map(id => [id, Object.fromEntries(COUNT_FIELDS.map(field => [field, 0]))]));
  for (const { id, ...counts } of rows) map.set(id, counts);
  return map;
}
async function readMany(ids, domain, load, validate) {
  const unique = [...new Set(ids)].filter(Boolean), result = new Map();
  for (let i = 0; i < unique.length; i += 256) {
    const page = unique.slice(i, i + 256); let bulk;
    if (require('../../../shared/cache/redisCache').isEnabled()) require('../../../shared/observability/cacheEfficiencyMetrics').count(domain, 'redis');
    const batchFence = require('../../../shared/cache/redisCache').isEnabled()
      ? await require('../../../shared/cache/cacheEfficiencyRead').capture(page.map(id => ({ domain, identity: id }))) : null;
    const values = await Promise.all(page.map(async (id, index) => {
      let attempt = 0;
      const fragment = await readFragment({ kind: domain, key: `ce:v1:${domain}:${id}`,
        markers: [{ domain, identity: id }], ttlMs: 300000, validate,
        initialFence: batchFence ? { keys: [batchFence.keys[index]], tokens: [batchFence.tokens[index]] } : null,
        load: async () => ++attempt > 1 ? (await load([id])).get(id) : (await (bulk ||= load(page))).get(id),
      });
      return [id, fragment.value];
    }));
    for (const [id, value] of values) if (value) result.set(id, value);
  }
  return result;
}
module.exports = {
  metadataMany: ids => readMany(ids, 'race-meta', loadMetadata, validMetadata),
  countsMany: ids => readMany(ids, 'race-members', loadCounts, validCounts),
  META_FIELDS, metaSelect,
};

// Access, current status, money and viewer membership remain in the core query.
// Only descriptive columns are omitted on this display-only read plan.
async function loadCore(id, options) {
  if (!require('../../../shared/cache/redisCache').isEnabled()) return prisma.race.findUnique(options);
  const retained = new Set(['id', 'creatorId', 'isTeamRace', 'teamSize', 'tournamentId']);
  const omitted = META_FIELDS.filter(field => !retained.has(field));
  const [core, metadata] = await Promise.all([
    prisma.race.findUnique({ ...options, omit: Object.fromEntries(omitted.map(field => [field, true])) }),
    module.exports.metadataMany([id]),
  ]);
  if (!core) return null;
  const meta = metadata.get(id);
  if (!meta) return prisma.race.findUnique(options);
  for (const field of omitted) {
    core[field] = meta[field];
    if (field.endsWith('At') && core[field] !== null) core[field] = new Date(core[field]);
  }
  return core;
}
module.exports.loadCore = loadCore;

async function captureCounts(raceId) {
  const redis = require('../../../shared/cache/redisCache');
  if (!redis.isEnabled()) return null;
  require('../../../shared/observability/cacheEfficiencyMetrics').count('race-members', 'redis');
  return require('../../../shared/cache/cacheEfficiencyRead').capture([{ domain: 'race-members', identity: raceId }]);
}
async function publishCounts(raceId, summary, fence) {
  if (!fence || require('../../../shared/cache/derivedCache').isBypassed('ce:v1:')) return;
  const value = Object.fromEntries(COUNT_FIELDS.map(field => [field, summary[field]]));
  if (!validCounts(value)) return;
  const at = Date.now();
  require('../../../shared/observability/cacheEfficiencyMetrics').count('race-members', 'redis');
  await require('../../../shared/cache/redisCache').evalLua(`
    if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
    redis.call('SET',KEYS[2],ARGV[2],'PX',300000)
    return 1`, [fence.keys[0], `ce:v1:race-members:${raceId}`],
    [fence.tokens[0], JSON.stringify({ schema: 1, tokens: fence.tokens, loadedAt: at, expiresAt: at + 300000, value })]);
}
module.exports.captureCounts = captureCounts;
module.exports.publishCounts = publishCounts;
