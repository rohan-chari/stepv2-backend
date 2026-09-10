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
]);
async function raceChanged(raceId, fields = null) {
  if (!raceId || (fields && !Object.keys(fields).some((field) => METADATA_FIELDS.has(field)))) return;
  await efficiency.afterCommit([
    { domain: "race-meta", identity: raceId },
    { domain: "event", identity: raceId },
  ]);
  const { deferUntilAfterCommitBatch } = require("../../../db");
  await deferUntilAfterCommitBatch("legacy-race-list-races", [raceId], async (ids) => {
    const { invalidateRaces } = require("./raceListCache");
    await invalidateRaces([...new Set(ids)]);
  });
}
async function membershipChanged(rows, fields = null) {
  if (fields && !Object.keys(fields).some((field) => MEMBERSHIP_FIELDS.has(field))) return;
  const entries = [];
  const users = [];
  for (const row of rows || []) {
    if (row.raceId) entries.push({ domain: "race-members", identity: row.raceId });
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
module.exports = { raceChanged, membershipChanged, MEMBERSHIP_FIELDS, METADATA_FIELDS };
