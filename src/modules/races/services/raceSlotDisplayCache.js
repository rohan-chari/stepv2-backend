const { readFragment, capture } = require('../../../shared/cache/cacheEfficiencyRead');
const { RacePowerup } = require('../../powerups/models/racePowerup');
const TTL_MS = 30000;
const CHUNK_SIZE = 256;
function valid(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2 &&
    Number.isSafeInteger(value.queuedBoxCount) && value.queuedBoxCount >= 0 &&
    Array.isArray(value.slotPowerups) && value.slotPowerups.length <= 32 &&
    value.slotPowerups.every(row => row && Object.keys(row).length === 4 &&
      typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 128 &&
      ['HELD', 'MYSTERY_BOX'].includes(row.status) &&
      (row.type === null || typeof row.type === 'string') &&
      (row.rarity === null || typeof row.rarity === 'string'));
}
async function loadMany(participants, powerupModel) {
  const out = new Map(participants.map(row => [row.id, { slotPowerups: [], queuedBoxCount: 0 }]));
  for (let offset = 0; offset < participants.length; offset += CHUNK_SIZE) {
    const ids = participants.slice(offset, offset + CHUNK_SIZE).map(row => row.id);
    const rows = await powerupModel.findInventoryForParticipants(ids, ['HELD', 'MYSTERY_BOX', 'QUEUED']);
    for (const row of rows) {
      const value = out.get(row.participantId);
      if (!value) continue;
      if (row.status === 'QUEUED') value.queuedBoxCount++;
      else if (row.status === 'HELD' || row.status === 'MYSTERY_BOX') value.slotPowerups.push({
        id: row.id, type: row.type, rarity: row.rarity, status: row.status,
      });
    }
  }
  return out;
}
async function readMany({ participantRows, powerupModel = RacePowerup }) {
  const participants = [...new Map(participantRows.filter(row => row?.id && row.raceId && row.userId).map(row => [row.id, row])).values()];
  if (!participants.length) return new Map();
  const output = new Map();
  for (let offset = 0; offset < participants.length; offset += CHUNK_SIZE) {
    const page = participants.slice(offset, offset + CHUNK_SIZE);
    const markers = page.flatMap(row => [
      { domain: 'slots', identity: `participant:${row.id}` },
      { domain: 'slots', identity: `race:${row.raceId}` },
    ]);
    // Capture every sibling's source fence BEFORE the shared SQL can start.
    // An independently captured later token must never label older bulk rows.
    if (require('../../../shared/cache/redisCache').isEnabled()) {
      require('../../../shared/observability/cacheEfficiencyMetrics').count('slots', 'redis');
    }
    const fence = await capture(markers);
    let bulkLoad;
    const values = await Promise.all(page.map(async (row, index) => {
      let attempts = 0;
      const result = await readFragment({
        kind: 'slots', key: `ce:v1:slots:${row.raceId}:${row.userId}:${row.id}`,
        markers: markers.slice(index * 2, index * 2 + 2),
        initialFence: fence ? {
          keys: fence.keys.slice(index * 2, index * 2 + 2),
          tokens: fence.tokens.slice(index * 2, index * 2 + 2),
        } : null,
        ttlMs: TTL_MS, validate: valid, maxBytes: 16384,
        load: async () => {
          // A lost-fill retry must read committed state again.
          if (++attempts > 1) return (await loadMany([row], powerupModel)).get(row.id);
          bulkLoad ||= loadMany(page, powerupModel);
          return (await bulkLoad).get(row.id);
        },
      });
      return [row.id, result.value];
    }));
    for (const [id, value] of values) output.set(id, value);
  }
  return output;
}
module.exports = { readMany, TTL_MS };
