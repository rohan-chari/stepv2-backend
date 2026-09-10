const { readFragment } = require('../../../shared/cache/cacheEfficiencyRead');
const TTL_MS = 30000;
function valid(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Number.isSafeInteger(value.currentSteps) && value.currentSteps >= 0 &&
    Array.isArray(value.claimedThresholds) && value.claimedThresholds.length <= 100 &&
    value.claimedThresholds.every(threshold => Number.isSafeInteger(threshold) && threshold > 0);
}
async function read({ userId, localDate, load }) {
  const result = await readFragment({
    kind: 'milestones', key: `ce:v1:milestones:${userId}:${localDate}`,
    markers: [{ domain: 'milestones', identity: `${userId}:${localDate}` }],
    ttlMs: TTL_MS, load, validate: valid, maxBytes: 4096,
  });
  return result.value;
}
module.exports = { read, TTL_MS };
