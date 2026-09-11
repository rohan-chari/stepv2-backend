const { prisma } = require('../../../db');
const { readFragment, capture } = require('../../../shared/cache/cacheEfficiencyRead');
const redis = require('../../../shared/cache/redisCache');

const CHUNK_SIZE = 100;
const PREFIX = 'ce:v1:race-open:';
const BOOLEAN_FIELDS = ['seriesEnabled', 'viewerAccepted', 'hasSeriesSuccessor', 'hasLiveRematch', 'hasCompletedRematchChild', 'subscribed'];
const NULLABLE_IDS = ['seedId', 'tournamentId', 'creationSource', 'startPolicy', 'rematchRootRaceId', 'seriesId'];
function validLinks(row) {
  return row && typeof row.id === 'string' &&
    ['rematchRootRaceId', 'seriesId'].every(key => row[key] === null || typeof row[key] === 'string');
}
function validState(row) {
  return validLinks(row) && (row.creatorId === null || typeof row.creatorId === 'string') &&
    ['pending', 'active', 'completed', 'cancelled'].includes(row.status) &&
    NULLABLE_IDS.every(key => row[key] === null || typeof row[key] === 'string') &&
    BOOLEAN_FIELDS.every(key => typeof row[key] === 'boolean') &&
    Number.isSafeInteger(row.acceptedCount) && row.acceptedCount >= 0;
}
// The descriptor is itself fenced by race-meta: changed series/root pointers
// cannot leave the state reader listening only to its former dependencies.
async function readLinks(ids) {
  let bulk;
  const fence = await capture(ids.map(identity => ({ domain: 'race-meta', identity })));
  return new Map(await Promise.all(ids.map(async (id, index) => {
    let attempt = 0;
    const { value } = await readFragment({ kind: 'race-viewer-links', key: `${PREFIX}viewer-links:${id}`,
      markers: [{ domain: 'race-meta', identity: id }], ttlMs: 300000, validate: validLinks,
      initialFence: fence ? { keys: [fence.keys[index]], tokens: [fence.tokens[index]] } : null,
      load: async () => {
        const load = rows => prisma.race.findMany({ where: { id: { in: rows } }, select: { id: true, rematchRootRaceId: true, seriesId: true } });
        const rows = ++attempt > 1 ? await load([id]) : await (bulk ||= load(ids));
        return rows.find(row => row.id === id) || null;
      },
    });
    return [id, value];
  })));
}
async function readMany({ ids, userId, loadRows }) {
  if (!redis.isEnabled()) return loadRows(ids);
  const result = [];
  for (let offset = 0; offset < ids.length; offset += CHUNK_SIZE) {
    const page = ids.slice(offset, offset + CHUNK_SIZE);
    const links = await readLinks(page);
    const markerGroups = page.map(id => {
      const link = links.get(id);
      return link ? [
        { domain: 'race-meta', identity: id }, { domain: 'race-members', identity: id },
        { domain: 'rematch-lineage', identity: link.rematchRootRaceId || id },
        ...(link.seriesId ? [
          { domain: 'series', identity: link.seriesId },
          { domain: 'series-user', identity: `${link.seriesId}:${userId}` },
        ] : []),
      ] : [];
    });
    // Capture every dependency before a sibling can start the shared SQL.
    // Otherwise a late sibling could label an older bulk row with a token
    // captured after that row's writer committed.
    const fence = await capture(markerGroups.flat());
    let markerOffset = 0;
    const fences = markerGroups.map(markers => {
      const initialFence = fence ? {
        keys: fence.keys.slice(markerOffset, markerOffset + markers.length),
        tokens: fence.tokens.slice(markerOffset, markerOffset + markers.length),
      } : null;
      markerOffset += markers.length;
      return initialFence;
    });
    let bulk;
    const rows = await Promise.all(page.map(async (id, index) => {
      const link = links.get(id);
      if (!link) return (await loadRows([id]))[0] || null;
      let attempt = 0;
      const { value } = await readFragment({ kind: 'race-viewer-state', key: `${PREFIX}viewer-state:${id}:${userId}`,
        markers: markerGroups[index], initialFence: fences[index], ttlMs: 30000,
        validate: row => validState(row) && row.rematchRootRaceId === link.rematchRootRaceId && row.seriesId === link.seriesId,
        load: async () => {
          const loaded = ++attempt > 1 ? await loadRows([id]) : await (bulk ||= loadRows(page));
          const row = loaded.find(value => value.id === id);
          return row ? { ...row, acceptedCount: Number(row.acceptedCount) } : null;
        },
      });
      return value;
    }));
    result.push(...rows.filter(Boolean));
  }
  return result;
}
module.exports = { readMany };
