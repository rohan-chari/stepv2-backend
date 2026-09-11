const efficiency = require('../../../shared/cache/cacheEfficiencyInvalidation');
// Participant IDs are globally unique. Race epochs cover bounded bulk expiry
// and conditional mutations whose caller has only the race identity.
async function slotsChanged({ participantId, raceId }) {
  const identity = participantId ? `participant:${participantId}` : raceId ? `race:${raceId}` : null;
  if (identity) await efficiency.afterCommit([{ domain: 'slots', identity },
    { domain: 'participant-display', identity: participantId || `race:${raceId}` },
    ...(participantId ? [{ domain: 'participant-use-history', identity: participantId }] : []),
  ]);
}
async function participantsChanged(participantIds) {
  await efficiency.afterCommit([...new Set(participantIds.filter(Boolean))].flatMap(id => [{ domain: 'slots', identity: `participant:${id}` }, { domain: 'participant-display', identity: id }, { domain: 'participant-use-history', identity: id }]));
}
module.exports = { slotsChanged, participantsChanged };
