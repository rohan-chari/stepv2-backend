const { prisma } = require("../../../db");

// Exact scalar/array inputs for existing serializers. This is one database
// aggregate, not a transferred participant roster. The all-member ID array is
// deliberately retained for frozen invitation clients, including declined rows.
async function loadRaceParticipantReadSummary(raceId) {
  const [summary] = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int AS "totalCount",
      count(*) FILTER (WHERE status='accepted')::int AS "acceptedCount",
      count(*) FILTER (WHERE status='accepted' AND team='team_a')::int AS "teamACount",
      count(*) FILTER (WHERE status='accepted' AND team='team_b')::int AS "teamBCount",
      count(*) FILTER (WHERE status='accepted' AND team='team_a' AND forfeited_at IS NULL)::int AS "teamARecipients",
      count(*) FILTER (WHERE status='accepted' AND team='team_b' AND forfeited_at IS NULL)::int AS "teamBRecipients",
      COALESCE(sum(buy_in_amount) FILTER (WHERE buy_in_status='held'),0)::float8 AS "heldPotCoins",
      count(*) FILTER (WHERE status='accepted' AND NOT (forfeited_at IS NOT NULL AND COALESCE(total_steps,0)<=0))::int AS "activeFundedPlayerCount",
      count(*) FILTER (WHERE status='accepted' AND forfeited_at IS NULL)::int AS "activeExitRecipientCount",
      count(*) FILTER (WHERE status='accepted' AND placement IS NOT NULL AND total_steps>0)::int AS "settlementPlayerCount",
      count(*) FILTER (WHERE status='accepted' AND total_steps>0)::int AS "teamSettlementPlayerCount",
      count(*) FILTER (WHERE status='accepted' AND placement IS NOT NULL AND raw_steps>=2000)::int AS "quickQualifierCount",
      count(*) FILTER (WHERE placement IS NOT NULL AND forfeited_at IS NULL AND total_steps>0)::int AS "completedExitRecipientCount",
      count(*) FILTER (WHERE status='accepted' AND placement IS NOT NULL AND raw_steps>=2000 AND forfeited_at IS NULL)::int AS "completedQuickExitRecipientCount",
      COALESCE(jsonb_agg(payout_coins ORDER BY payout_coins DESC,user_id) FILTER (WHERE payout_coins>0),'[]'::jsonb) AS "completedTeamPayouts",
      COALESCE(jsonb_agg(payout_coins ORDER BY placement,joined_at,id) FILTER (WHERE placement IS NOT NULL AND payout_coins>0),'[]'::jsonb) AS "completedV1Payouts",
      COALESCE(jsonb_agg(user_id ORDER BY joined_at,id),'[]'::jsonb) AS "participantUserIds"
    FROM race_participants WHERE race_id=$1`, raceId);
  return summary;
}

module.exports = { loadRaceParticipantReadSummary };
