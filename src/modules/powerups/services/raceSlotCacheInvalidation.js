const efficiency = require('../../../shared/cache/cacheEfficiencyInvalidation');
// Participant IDs are globally unique. Race epochs cover bounded bulk expiry
// and conditional mutations whose caller has only the race identity.
async function slotsChanged({ participantId, raceId }) {
  const identity = participantId ? `participant:${participantId}` : raceId ? `race:${raceId}` : null;
  if (identity) await efficiency.afterCommit([{ domain: 'slots', identity }]);
}
async function participantsChanged(participantIds) {
  await efficiency.afterCommit([...new Set(participantIds.filter(Boolean))].map(id => ({
    domain: 'slots', identity: `participant:${id}`,
  })));
}
module.exports = { slotsChanged, participantsChanged };
