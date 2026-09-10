const efficiency = require('../../../shared/cache/cacheEfficiencyInvalidation');
async function milestonesChanged(userId, date) {
  if (!userId || !date) return;
  const localDate = typeof date === 'string' ? date.slice(0, 10) : date.toISOString().slice(0, 10);
  await efficiency.afterCommit([{ domain: 'milestones', identity: `${userId}:${localDate}` }]);
}
module.exports = { milestonesChanged };
