const { afterCommit } = require('../../../shared/cache/cacheEfficiencyInvalidation');

async function raceLinksChanged(rows) {
  const entries = [];
  for (const row of rows || []) {
    if (!row?.id) continue;
    entries.push({ domain: 'race-meta', identity: row.id },
      { domain: 'rematch-lineage', identity: row.rematchRootRaceId || row.id });
    if (row.seriesId) entries.push({ domain: 'series', identity: row.seriesId });
  }
  await afterCommit(entries);
}
async function seriesChanged(seriesId, userId = null) {
  if (!seriesId) return;
  await afterCommit([{ domain: userId ? 'series-user' : 'series', identity: userId ? `${seriesId}:${userId}` : seriesId }]);
}
module.exports = { raceLinksChanged, seriesChanged };
