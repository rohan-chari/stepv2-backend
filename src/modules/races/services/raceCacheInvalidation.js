const efficiency = require("../../../shared/cache/cacheEfficiencyInvalidation");
const MEMBERSHIP_FIELDS = new Set([
  "status", "team", "userId", "raceId", "inviteExpiresAt", "invitedByUserId",
  "resultsSeenAt", "forfeitedAt", "favoritedAt",
]);
const METADATA_FIELDS = new Set([
  "name", "status", "creatorId", "startedAt", "endsAt", "completedAt",
  "scheduledStartAt", "scheduledEndAt", "timezone", "isTeamRace", "teamSize",
  "teamAName", "teamBName", "tournamentId", "isPublic", "maxParticipants",
  "maxDurationDays", "powerupsEnabled", "payoutPreset", "resultVersion",
  "targetSteps", "powerupStepInterval", "timeBased", "seededBucketId", "seedId",
  "buyInAmount", "potCoins", "fundedPrize", "prizePoolCoins", "prizeCoinUnit",
  "prizePoolMaxCoins", "prizeCalculationVersion", "payoutRoundingVersion", "payoutCurve",
  "creationSource", "startPolicy", "teamPoolMultBps", "teamPayoutVersion", "teamWinnerRewardCoins",
  "winnerUserId", "winnerTeam", "tournamentRound", "tournamentMatchIndex",
  "seriesId", "seriesPredecessorRaceId", "rematchRootRaceId", "rematchSourceRaceId", "exitActionsEnabled", "shareToken",
]);
const CORE_FIELDS = new Set(require('./raceOpenDisplaySchema.json').Race.map(field => field.name));
async function raceChanged(raceId, fields = null) {
  if (!raceId) return;
  const displayChanged = !fields || Object.keys(fields).some(field => CORE_FIELDS.has(field));
  const listChanged = !fields || Object.keys(fields).some(field => METADATA_FIELDS.has(field));
  await efficiency.afterCommit([
    ...(displayChanged ? [{ domain: 'race-meta', identity: raceId }] : []),
    ...(listChanged ? [{ domain: 'event', identity: raceId }] : []),
    ...(listChanged ? [{ domain: 'event', identity: 'public-race-discovery' }] : []),
  ]);
  if (!listChanged) return;
  const { deferUntilAfterCommitBatch } = require("../../../db");
  await deferUntilAfterCommitBatch("legacy-race-list-races", [raceId], async (ids) => {
    const { invalidateRaces } = require("./raceListCache");
    await invalidateRaces([...new Set(ids)]);
  });
}
async function participantDisplayChanged(rows, fields = null) {
  const summaryFields = new Set(['status','team','totalSteps','rawSteps','placement','payoutCoins','buyInAmount','buyInStatus','forfeitedAt','finishedAt','finishTotalSteps']);
  const entries = [];
  for (const row of rows || []) {
    if (row.id) entries.push({ domain: 'participant-display', identity: row.id });
    if (row.raceId && row.userId) entries.push({ domain: 'participant-display', identity: `${row.raceId}:${row.userId}` });
    if (row.raceId) entries.push({ domain: 'participant-display', identity: `roster:${row.raceId}` });
    if (row.raceId && !row.id && !row.userId) entries.push({ domain: 'participant-display', identity: `race:${row.raceId}` });
    if (row.raceId && (!fields || Object.keys(fields).some(key => summaryFields.has(key)))) entries.push({ domain: 'race-summary', identity: row.raceId });
  }
  await efficiency.afterCommit(entries);
  if (!fields || Object.keys(fields).some((field) => MEMBERSHIP_FIELDS.has(field))) {
    await efficiency.afterCommit([{ domain: 'event', identity: 'public-race-discovery' }]);
  }
}
async function membershipChanged(rows, fields = null) {
  await participantDisplayChanged(rows, fields);
  if (fields && !Object.keys(fields).some((field) => MEMBERSHIP_FIELDS.has(field))) return;
  const entries = [];
  const users = [];
  for (const row of rows || []) {
    if (row.raceId) entries.push({ domain: "race-members", identity: row.raceId }, { domain: "race-effects", identity: row.raceId });
    if (row.userId) {
      users.push(row.userId);
      entries.push({ domain: "list", identity: row.userId }, { domain: "invites", identity: row.userId });
    }
  }
  await efficiency.afterCommit(entries);
  const { deferUntilAfterCommitBatch } = require("../../../db");
  await deferUntilAfterCommitBatch("legacy-race-list-users", users, async (ids) => {
    await require("./raceListCache").invalidateUsers([...new Set(ids)]);
  });
}
module.exports = { raceChanged, membershipChanged, participantDisplayChanged, MEMBERSHIP_FIELDS, METADATA_FIELDS };
