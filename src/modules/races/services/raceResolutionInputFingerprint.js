const { prisma: defaultPrisma } = require("../../../db");
const { digestPayload } = require("./raceResolutionDisplayArtifact");

async function buildRaceResolutionInputFingerprint({
  raceId,
  now = new Date(),
  balanceConfigVersion = null,
  client = defaultPrisma,
} = {}) {
  if (!raceId || !client || typeof client.$queryRawUnsafe !== "function") return null;
  // Global-event lookahead. This was `now + 5s`, which selected only events
  // that had ALREADY started — so an event about to begin was invisible to
  // every deadline computed from these rows, and a closure (or a reused display
  // artifact) could be declared valid straight across the event's start. The
  // window is now wide enough to cover the dependency-closure planner's maximum
  // validity (10 min).
  //
  // Safe for the shipped consumer: computeArtifactReuseDeadline takes the MIN
  // over its candidates and always seeds `asOf + 5s`, so extra upcoming events
  // can only SHORTEN a reuse deadline, never lengthen one. The ended-event
  // exclusion (`ends_at > race.started_at`) is unchanged.
  const GLOBAL_EVENT_LOOKAHEAD_MS = 10 * 60 * 1000;
  const horizon = new Date(now.getTime() + GLOBAL_EVENT_LOOKAHEAD_MS);
  const [raceRows, inputs, effects, eventRows] = await Promise.all([
    client.$queryRawUnsafe(
      `SELECT jsonb_build_object(
          'id', race.id,
          'status', race.status,
          'startedAt', race.started_at,
          'endsAt', race.ends_at,
          'timezone', race.timezone,
          'targetSteps', race.target_steps,
          'timeBased', race.time_based,
          'powerupsEnabled', race.powerups_enabled,
          'powerupStepInterval', race.powerup_step_interval,
          'isTeamRace', race.is_team_race,
          'teamSize', race.team_size
        ) AS race,
        COALESCE(jsonb_agg(jsonb_build_object(
          'id', participant.id,
          'userId', participant.user_id,
          'status', participant.status,
          'totalSteps', participant.total_steps,
          'rawSteps', participant.raw_steps,
          'bonusSteps', participant.bonus_steps,
          'maxBonusSteps', participant.max_bonus_steps,
          'nextBoxAtSteps', participant.next_box_at_steps,
          'powerupSlots', participant.powerup_slots,
          'finishedAt', participant.finished_at,
          'finishTotalSteps', participant.finish_total_steps,
          'forfeitedAt', participant.forfeited_at,
          'joinedAt', participant.joined_at,
          'team', participant.team
        ) ORDER BY participant.id) FILTER (WHERE participant.id IS NOT NULL), '[]'::jsonb)
          AS participants
       FROM races race
       LEFT JOIN race_participants participant ON participant.race_id=race.id
       WHERE race.id=$1
       GROUP BY race.id`,
      raceId
    ),
    client.$queryRawUnsafe(
      `WITH members AS (
         SELECT DISTINCT participant.user_id
         FROM race_participants participant
         WHERE participant.race_id=$1 AND participant.status='accepted'
       )
       SELECT members.user_id AS "userId",
         version.generation::text AS generation,
         EXISTS (SELECT 1 FROM steps source WHERE source.user_id=members.user_id) AS "hasSteps",
         EXISTS (SELECT 1 FROM step_samples source WHERE source.user_id=members.user_id) AS "hasSamples",
         (SELECT MIN(source.period_end) FROM step_samples source
          WHERE source.user_id=members.user_id AND source.period_end > $2) AS "nextSampleBoundary"
       FROM members
       LEFT JOIN user_scoring_input_versions version ON version.user_id=members.user_id
       ORDER BY members.user_id`,
      raceId,
      now
    ),
    // Schema 2 (dependency-closure spec rule 7): the closure graph needs the
    // EXPIRED LEECH/HITCHHIKE rows too — leechTransfers.js and
    // hitchhikeCopies.js both read status IN (ACTIVE, EXPIRED), so an EXPIRED
    // row is still a live scoring input and a fingerprint that ignores it can
    // report "unchanged" across a real graph transition. Folded into the SAME
    // query rather than a fifth one so the race-scoped query count (and every
    // injected test client's result ordering) is unchanged. The enum's DB
    // labels are lowercase (`active_effect` / `expired_effect`); type labels
    // are lowercase too, hence UPPER(type::text) in the filter.
    client.$queryRawUnsafe(
      `SELECT id, target_participant_id AS "targetParticipantId",
         target_user_id AS "targetUserId", source_user_id AS "sourceUserId",
         powerup_id AS "powerupId", UPPER(type::text) AS type,
         UPPER(status::text) AS status, starts_at AS "startsAt",
         expires_at AS "expiresAt", metadata, updated_at AS "updatedAt"
       FROM race_active_effects
       WHERE race_id=$1
         AND (status='active_effect'
              OR (status='expired_effect'
                  AND UPPER(type::text) IN ('LEECH', 'HITCHHIKE')))
       ORDER BY id`,
      raceId
    ),
    client.$queryRawUnsafe(
      `WITH race_window AS (
         SELECT started_at FROM races WHERE id=$1
       ), schedule AS (
         SELECT COALESCE((
           SELECT NOT EXISTS (
             SELECT 1
             FROM (
               SELECT source.starts_at AS boundary_at, source.id AS event_id,
                 'START'::text AS boundary_kind
               FROM global_step_events source
               JOIN race_window race ON source.ends_at > race.started_at
               WHERE source.schedule_mode='LEGACY_GLOBAL'
               UNION ALL
               SELECT source.ends_at AS boundary_at, source.id AS event_id,
                 'END'::text AS boundary_kind
               FROM global_step_events source
               JOIN race_window race ON source.ends_at > race.started_at
               WHERE source.schedule_mode='LEGACY_GLOBAL'
             ) boundary
             WHERE boundary.boundary_at <=
                 (to_timestamp($3::float8 / 1000) AT TIME ZONE 'UTC')
               AND (boundary.boundary_at, boundary.event_id, boundary.boundary_kind) >
                 (cursor.boundary_at, cursor.event_id, cursor.boundary_kind)
           )
           FROM global_step_event_boundary_cursors cursor
           WHERE cursor.key='global'
         ), false) AS current
       ), candidate_events AS (
         SELECT event.id, event.starts_at, event.ends_at,
           event.multiplier, event.label, event.schedule_mode,
           NULL::text AS entitlement_id, NULL::text AS impact_id,
           NULL::text AS impact_status, NULL::text AS user_id
         FROM global_step_events event
         JOIN races race ON race.id=$1
         WHERE event.schedule_mode='LEGACY_GLOBAL'
           AND event.ends_at > race.started_at AND event.starts_at <= $2
         UNION ALL
         SELECT event.id, entitlement.starts_at, entitlement.ends_at,
           event.multiplier, event.label, event.schedule_mode,
           entitlement.id, impact.id, impact.status, entitlement.user_id
         FROM global_step_event_entitlements entitlement
         JOIN global_step_events event ON event.id=entitlement.event_id
           AND event.schedule_mode='LOCAL_ENTITLEMENTS'
         JOIN global_event_race_impacts impact
           ON impact.event_id=entitlement.event_id
          AND impact.user_id=entitlement.user_id
          AND impact.race_id=$1
         JOIN races race ON race.id=$1
         WHERE entitlement.start_outcome IN ('ACTIVATED_ON_TIME','ACTIVATED_LATE_JOIN')
           AND entitlement.ends_at > race.started_at
           AND entitlement.starts_at <= $2
       )
       SELECT event.id, event.starts_at AS "startsAt", event.ends_at AS "endsAt",
         event.multiplier, event.label, event.schedule_mode AS "scheduleMode",
         event.entitlement_id AS "entitlementId", event.impact_id AS "impactId",
         event.impact_status AS "impactStatus", event.user_id AS "userId",
         schedule.current AS "globalBoundaryScheduleCurrent"
       FROM schedule LEFT JOIN candidate_events event ON TRUE
       ORDER BY event.starts_at, event.id`,
      raceId,
      horizon,
      now.getTime()
    ),
  ]);

  const raceRow = raceRows[0];
  if (!raceRow?.race || !Array.isArray(raceRow.participants)) return null;
  for (const input of inputs || []) {
    if (input.generation == null && (input.hasSteps === true || input.hasSamples === true)) {
      return null;
    }
  }
  const normalizedInputs = (inputs || []).map((input) => ({
    userId: input.userId,
    generation: input.generation == null ? "0" : String(input.generation),
    hasSteps: input.hasSteps === true,
    hasSamples: input.hasSamples === true,
  }));
  const boundaries = (inputs || [])
    .map((input) => input.nextSampleBoundary)
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.getTime()));
  const nextSampleBoundary = boundaries.length
    ? new Date(Math.min(...boundaries.map((value) => value.getTime())))
    : null;
  // The effect read now returns two populations. `activeEffects` stays
  // ACTIVE-only because its shipped consumer is computeArtifactReuseDeadline
  // (getRaceProgress.js), which enumerates startsAt/expiresAt boundaries and
  // would pull an already-elapsed boundary out of an EXPIRED row. The closure
  // planner consumes `expiredScoringEffects` separately.
  const events = (eventRows || []).filter((row) => row?.id);
  const allEffects = effects || [];
  const expiredScoringEffects = allEffects.filter((row) => row.status === "EXPIRED");
  const activeEffects = allEffects.filter((row) => row.status !== "EXPIRED");
  const payload = {
    // schema 2: EXPIRED LEECH/HITCHHIKE rows are digested. The bump changes
    // every digest, which is exactly the intended invalidation — an in-flight
    // display artifact carrying a schema-1 digest simply mismatches and the
    // job falls back to FULL. Nothing parses the digest, so nothing crashes.
    schema: 3,
    race: raceRow.race,
    participants: raceRow.participants,
    inputs: normalizedInputs,
    effects: activeEffects,
    expiredScoringEffects,
    events: events || [],
    balanceConfigVersion: balanceConfigVersion == null
      ? "code-default"
      : String(balanceConfigVersion),
  };
  return {
    digest: digestPayload(payload),
    race: raceRow.race,
    participantCount: raceRow.participants.length,
    nextSampleBoundary,
    activeEffects,
    expiredScoringEffects,
    globalEvents: events || [],
    globalBoundaryScheduleCurrent:
      eventRows?.[0]?.globalBoundaryScheduleCurrent === true,
    // Spec rule 3 (TRAIL_MINE full-field projection) requires the persisted
    // total_steps of every accepted row "taken from the same fingerprint read —
    // no additional query". These rows were already selected and already
    // digested; returning them only widens what callers can READ off the
    // existing result.
    participants: raceRow.participants,
  };
}

module.exports = { buildRaceResolutionInputFingerprint };
