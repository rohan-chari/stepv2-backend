const crypto = require("node:crypto");

function classifyRaceStatus(status) {
  const normalized = String(status || "").toUpperCase();
  if (normalized === "ACTIVE" || normalized === "PENDING") return "ACTIVE_RACE";
  if (normalized === "COMPLETED") return "COMPLETED_RACE";
  if (normalized === "CANCELLED") return "CANCELLED_RACE";
  return "OTHER_RACE_STATUS";
}

function reportDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function auditPendingV1Impacts(prisma) {
  const { source, databaseReadOnly } = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const setting = await tx.$queryRawUnsafe(
      "SELECT current_setting('transaction_read_only') AS value",
    );
    if (setting[0]?.value !== "on") {
      throw new Error("V1 pending-impact audit requires a database-enforced read-only transaction");
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT impact.id AS "impactId",
            impact.event_id AS "eventId",
            impact.race_id AS "raceId",
            impact.user_id AS "userId",
            impact.created_at AS "impactCreatedAt",
            race.status::text AS "raceStatus",
            race.is_team_race AS "isTeamRace",
            race.completed_at AS "raceCompletedAt",
            participant.id AS "participantId",
            participant.status::text AS "participantStatus",
            participant.placement,
            participant.total_steps AS "totalSteps",
            BOOL_AND(race.status IN ('completed','cancelled')) OVER (
              PARTITION BY impact.event_id, impact.user_id
            ) AS "terminalOnlyGroup"
       FROM global_event_race_impacts impact
       JOIN races race ON race.id=impact.race_id
       LEFT JOIN race_participants participant
         ON participant.race_id=impact.race_id
        AND participant.user_id=impact.user_id
      WHERE impact.attribution_version=1
        AND impact.status='PENDING'
      ORDER BY impact.event_id, impact.user_id, impact.race_id, impact.id`,
    );
    return { source: rows, databaseReadOnly: true };
  }, { timeout: 30_000, maxWait: 10_000 });
  const rows = source.map((row) => {
    const classification = classifyRaceStatus(row.raceStatus);
    const missingSettlementEvidence = classification === "COMPLETED_RACE" && (
      !row.raceCompletedAt ||
      !row.participantId ||
      String(row.participantStatus || "").toUpperCase() !== "ACCEPTED" ||
      row.placement == null ||
      row.totalSteps == null
    );
    return {
      impactId: row.impactId,
      eventId: row.eventId,
      raceId: row.raceId,
      userId: row.userId,
      impactCreatedAt: row.impactCreatedAt?.toISOString?.() || String(row.impactCreatedAt),
      classification,
      raceStatus: String(row.raceStatus || "").toUpperCase(),
      isTeamRace: row.isTeamRace === true,
      raceCompletedAt: row.raceCompletedAt?.toISOString?.() || null,
      participantStatus: row.participantStatus
        ? String(row.participantStatus).toUpperCase()
        : null,
      placement: row.placement == null ? null : Number(row.placement),
      totalSteps: row.totalSteps == null ? null : Number(row.totalSteps),
      missingSettlementEvidence,
      terminalOnlyGroup: row.terminalOnlyGroup === true,
    };
  });
  const terminalGroups = new Set(rows
    .filter((row) => row.terminalOnlyGroup)
    .map((row) => `${row.eventId}:${row.userId}`));
  const counts = {
    total: rows.length,
    activeRace: rows.filter((row) => row.classification === "ACTIVE_RACE").length,
    completedRace: rows.filter((row) => row.classification === "COMPLETED_RACE").length,
    cancelledRace: rows.filter((row) => row.classification === "CANCELLED_RACE").length,
    otherRaceStatus: rows.filter((row) => row.classification === "OTHER_RACE_STATUS").length,
    missingSettlementEvidence: rows.filter((row) => row.missingSettlementEvidence).length,
    terminalOnlyGroups: terminalGroups.size,
  };
  const digestInput = { schema: "v1-pending-impact-audit-v1", counts, rows };
  return {
    ...digestInput,
    digest: reportDigest(digestInput),
    readOnly: true,
    databaseReadOnly,
  };
}

module.exports = {
  auditPendingV1Impacts,
  classifyRaceStatus,
  reportDigest,
};
