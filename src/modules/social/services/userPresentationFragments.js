// Additive identity/equipment-reference payload. Catalog fields are deliberately
// hydrated from the target database so peer catalog writes remain authoritative.
const { Prisma } = require('@prisma/client');
const { prisma } = require('../../../db');
const redis = require('../../../shared/cache/redisCache');
const derived = require('../../../shared/cache/derivedCache');
const keys = require('../../../shared/cache/cacheKeys');
const { capture, unchanged } = require('../../../shared/cache/cacheEfficiencyRead');
const { PREFIX } = require('../../../shared/cache/cacheEfficiencyInvalidation');
const metrics = require('../../../shared/observability/cacheEfficiencyMetrics');
const FIELDS = ['id', 'displayName', 'profilePhotoUrl', 'firstName', 'lastName', 'nameSetupCompletedAt', 'clientFeatures', 'isReviewAccount', 'hiddenFromLeaderboard', 'equipment'];
const INSTALL = `
local result = {}
for i = 1, #KEYS / 2 do
 if redis.call('GET', KEYS[i * 2 - 1]) == ARGV[i * 2 - 1] then
  redis.call('SET', KEYS[i * 2], ARGV[i * 2], 'EX', 3600)
  result[i] = 1
 else result[i] = 0 end
end
return result
`;
function valid(value, id) {
  return value && value.id === id && Object.keys(value).length === FIELDS.length &&
    FIELDS.every((field) => Object.hasOwn(value, field)) &&
    ['displayName', 'profilePhotoUrl', 'firstName', 'lastName'].every((field) => value[field] == null || typeof value[field] === 'string') &&
    (value.nameSetupCompletedAt === null || Number.isFinite(Date.parse(value.nameSetupCompletedAt))) &&
    Array.isArray(value.clientFeatures) && value.clientFeatures.every((v) => typeof v === 'string') &&
    typeof value.isReviewAccount === 'boolean' && typeof value.hiddenFromLeaderboard === 'boolean' &&
    Array.isArray(value.equipment) && value.equipment.length <= 16 && value.equipment.every((row) =>
      row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).sort().join(',') === 'shopItemId,slot' && typeof row.shopItemId === 'string' && typeof row.slot === 'string');
}
async function load(ids, kind) {
  metrics.count(kind, "source_loads");
  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT u.id, u.display_name AS "displayName", u.profile_photo_url AS "profilePhotoUrl",
      u.first_name AS "firstName", u.last_name AS "lastName", u.name_setup_completed_at AS "nameSetupCompletedAt",
      u.client_features AS "clientFeatures", u.is_review_account AS "isReviewAccount",
      u.hidden_from_leaderboard AS "hiddenFromLeaderboard",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('slot', e.slot, 'shopItemId', e.shop_item_id) ORDER BY e.slot)
        FROM user_equipped_accessories e WHERE e.user_id = u.id), '[]'::jsonb) AS equipment
    FROM users u WHERE u.id IN (${Prisma.join(ids)})
  `);
  return new Map(rows.map((row) => [row.id, { ...row, nameSetupCompletedAt: row.nameSetupCompletedAt?.toISOString() ?? null }]));
}
async function readBatch(ids, kind) {
  const fallback = async (reason) => { metrics.read(kind, reason); return load(ids, kind); };
  if (!redis.isEnabled() || derived.isBypassed(PREFIX)) return fallback('bypass');
  derived.ensureSubscribed();
  const fence = await capture(ids.map((id) => ({ domain: 'presentation', identity: id })));
  if (!fence) return fallback('error');
  const payloadKeys = ids.map((id) => `${keys.userCosmetics(id)}:ce:v1`);
  const batch = await redis.getManyJSON(payloadKeys);
  metrics.count(kind, 'redis', 2);
  if (!batch.ok) return fallback('error');
  const result = new Map(), missed = [];
  for (let i = 0; i < ids.length; i++) {
    const box = batch.values[i];
    if (box?.schema === 1 && box.token === fence.tokens[i] && valid(box.value, ids[i]) &&
        Number.isFinite(box.loadedAt) && Date.now() - box.loadedAt < 3600000 && box.loadedAt <= Date.now()) {
      result.set(ids[i], box.value); metrics.read(kind, 'hit');
    } else { missed.push(ids[i]); metrics.read(kind, box ? 'generation' : 'missing'); }
  }
  if (missed.length) {
    const loaded = await load(missed, kind);
    const casKeys = [], args = [];
    for (const id of missed) {
      const value = loaded.get(id); if (!value) continue;
      result.set(id, value);
      if (!valid(value, id)) continue;
      const i = ids.indexOf(id);
      const payload = JSON.stringify({ schema: 1, token: fence.tokens[i], loadedAt: Date.now(), value });
      if (Buffer.byteLength(payload) > 65536) continue;
      casKeys.push(fence.keys[i], payloadKeys[i]); args.push(fence.tokens[i], payload);
    }
    if (casKeys.length && !derived.isBypassed(PREFIX)) {
      const installed = await redis.evalLua(INSTALL, casKeys, args); metrics.count(kind, 'redis');
      if (installed.ok && installed.result.some((v) => v !== 1)) return fallback('generation');
    }
  }
  metrics.count(kind, 'redis');
  if (!await unchanged(fence) || derived.isBypassed(PREFIX)) return fallback('generation');
  return result;
}
async function getMany(ids, { kind = 'equipment' } = {}) {
  const unique = [...new Set(ids)].filter((id) => typeof id === 'string' && id.length);
  const result = new Map();
  for (let i = 0; i < unique.length; i += 256) {
    for (const [id, value] of await readBatch(unique.slice(i, i + 256), kind)) result.set(id, value);
  }
  return result;
}
async function equipmentForUser(userId) {
  const user = (await getMany([userId])).get(userId);
  const refs = user?.equipment || [];
  if (!refs.length) return [];
  const catalog = await prisma.shopItem.findMany({ where: { id: { in: refs.map((row) => row.shopItemId) } } });
  const byId = new Map(catalog.map((item) => [item.id, item]));
  return refs.filter((ref) => byId.has(ref.shopItemId)).map((ref) => ({ slot: ref.slot, shopItem: byId.get(ref.shopItemId) }));
}
module.exports = { getMany, equipmentForUser };
