const DEFAULT_CORRECTION_HORIZON_DAYS = 45;
const MAX_DISCOVERY_LIMIT = 100;

function correctionHorizonDays() {
  const configured = Number(process.env.STEP_CORRECTION_HORIZON_DAYS);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, DEFAULT_CORRECTION_HORIZON_DAYS)
    : DEFAULT_CORRECTION_HORIZON_DAYS;
}

function correctionThrough(now = new Date()) {
  return new Date(now.getTime() - correctionHorizonDays() * 86400000);
}

function buildHistoricalRaceDiscovery({ prisma, now = () => new Date() }) {
  return async function findHistoricalRacesForChangedSteps({
    userId, changedStart, changedEnd, correctionThrough: requestedThrough,
    cursor = null, limit = MAX_DISCOVERY_LIMIT,
  }) {
    const start = new Date(changedStart);
    const end = new Date(changedEnd);
    const through = requestedThrough ? new Date(requestedThrough) : correctionThrough(now());
    const boundedLimit = Math.max(1, Math.min(MAX_DISCOVERY_LIMIT, Number(limit) || MAX_DISCOVERY_LIMIT));
    if (!userId || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
      return { rows: [], nextCursor: null, outOfHorizon: false };
    }
    if (end <= through) return { rows: [], nextCursor: null, outOfHorizon: true };
    const rows = await prisma.$queryRawUnsafe(
      `SELECT race.id AS "raceId", participant.id AS "participantId",
              participant.user_id AS "userId", race.status AS "raceStatus",
              race.started_at AS "startedAt", race.ends_at AS "endsAt"
         FROM race_participants participant
         JOIN races race ON race.id=participant.race_id
        WHERE participant.user_id=$1
          AND participant.status='accepted'
          AND race.status IN ('active','completed')
          AND race.started_at IS NOT NULL
          AND race.started_at < $3::timestamp
          AND COALESCE(race.ends_at,race.started_at) > $2::timestamp
          AND (race.status='active' OR COALESCE(race.completed_at,race.ends_at,race.started_at) >= $4::timestamp)
          AND ($5::text IS NULL OR (race.id,participant.id) > ($5::text,$6::text))
        ORDER BY race.id, participant.id
        LIMIT $7`,
      userId, start, end, through, cursor?.raceId || null, cursor?.participantId || null, boundedLimit,
    );
    const last = rows.length === boundedLimit ? rows[rows.length - 1] : null;
    return {
      rows,
      nextCursor: last ? { raceId: last.raceId, participantId: last.participantId } : null,
      outOfHorizon: false,
    };
  };
}

module.exports = {
  DEFAULT_CORRECTION_HORIZON_DAYS,
  MAX_DISCOVERY_LIMIT,
  correctionHorizonDays,
  correctionThrough,
  buildHistoricalRaceDiscovery,
};
