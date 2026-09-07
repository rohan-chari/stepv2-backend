const { SETTLEMENT_EFFECT_TYPES } = require("./raceScoringEffectTypes");
const { prisma: defaultPrisma } = require("../../../db");
const { digestPayload } = require("./raceResolutionDisplayArtifact");

async function buildRaceResolutionInputFingerprint({
  raceId,
  now = new Date(),
  balanceConfigVersion = null,
  client = defaultPrisma,
  // Only full-digest validation may omit names; closure digests include them.
  includePresentation = true,
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
      `SELECT race.id AS "r_id",
       race.name AS "r_name",
       (EXTRACT(EPOCH FROM race.scheduled_start_at) * 1000)::float8 AS "r_scheduledStartAt",
       race.team_a_name AS "r_teamAName",
       race.team_b_name AS "r_teamBName",
       UPPER(race.status::text) AS "r_status",
       (EXTRACT(EPOCH FROM race.started_at) * 1000)::float8 AS "r_startedAt",
       (EXTRACT(EPOCH FROM race.ends_at) * 1000)::float8 AS "r_endsAt",
       race.timezone AS "r_timezone",
       race.target_steps AS "r_targetSteps",
       race.time_based AS "r_timeBased",
       race.powerups_enabled AS "r_powerupsEnabled",
       race.powerup_step_interval AS "r_powerupStepInterval",
       race.is_team_race AS "r_isTeamRace",
       race.team_size AS "r_teamSize",
       participant.id AS "p_id",
       participant.user_id AS "p_userId",
       UPPER(participant.status::text) AS "p_status",
       participant.total_steps AS "p_totalSteps",
       participant.raw_steps AS "p_rawSteps",
       participant.bonus_steps AS "p_bonusSteps",
       participant.max_bonus_steps AS "p_maxBonusSteps",
       participant.next_box_at_steps AS "p_nextBoxAtSteps",
       participant.powerup_slots AS "p_powerupSlots",
       (EXTRACT(EPOCH FROM participant.finished_at) * 1000)::float8 AS "p_finishedAt",
       participant.finish_total_steps AS "p_finishTotalSteps",
       (EXTRACT(EPOCH FROM participant.forfeited_at) * 1000)::float8 AS "p_forfeitedAt",
       (EXTRACT(EPOCH FROM participant.joined_at) * 1000)::float8 AS "p_joinedAt",
       UPPER(participant.team::text) AS "p_team",
       participant.placement AS "p_placement",
       participant.last_notified_placement AS "p_lastNotifiedPlacement",
       (EXTRACT(EPOCH FROM participant.high_multiplier_notified_at) * 1000)::float8 AS "p_highMultiplierNotifiedAt",
       (EXTRACT(EPOCH FROM participant.totals_updated_at) * 1000)::float8 AS "p_totalsUpdatedAt"
       ${includePresentation ? ', person.id AS "u_id", person.display_name AS "u_displayName"' : ""}
       FROM races race
       LEFT JOIN race_participants participant ON participant.race_id=race.id
       ${includePresentation ? "LEFT JOIN users person ON person.id=participant.user_id" : ""}
       WHERE race.id=$1
       ORDER BY participant.id`,
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
         CASE WHEN version.generation IS NULL THEN
           EXISTS (SELECT 1 FROM steps source WHERE source.user_id=members.user_id)
         ELSE false END AS "hasSteps",
         CASE WHEN version.generation IS NULL THEN
           EXISTS (SELECT 1 FROM step_samples source WHERE source.user_id=members.user_id)
         ELSE false END AS "hasSamples",
         CASE
           WHEN version.scoring_watermark IS NOT NULL
            AND version.source_queue_semantics_generation=version.generation
            AND (version.next_sample_boundary_at IS NULL
                 OR version.next_sample_boundary_at > $2)
             THEN version.next_sample_boundary_at
           ELSE (SELECT MIN(source.period_end) FROM step_samples source
                  WHERE source.user_id=members.user_id AND source.period_end > $2)
         END AS "nextSampleBoundary"
       FROM members
       LEFT JOIN user_scoring_input_versions version ON version.user_id=members.user_id
       ORDER BY members.user_id`,
      raceId,
      now
    ),
    // Load the complete scoring effect input once for this protected attempt.
    // Expired local modifiers still affect steps earned during their windows;
    // expired Leech/Hitchhike links additionally remain part of the graph.
    client.$queryRawUnsafe(
      `SELECT id, target_participant_id AS "targetParticipantId",
         target_user_id AS "targetUserId", source_user_id AS "sourceUserId",
         powerup_id AS "powerupId", UPPER(type::text) AS type,
         CASE status WHEN 'active_effect' THEN 'ACTIVE'
           WHEN 'expired_effect' THEN 'EXPIRED' ELSE UPPER(status::text) END AS status,
         starts_at AS "startsAt",
         expires_at AS "expiresAt", metadata, updated_at AS "updatedAt",
         race_id AS "raceId", created_at AS "createdAt"
       FROM race_active_effects
       WHERE race_id=$1
         AND (status='active_effect'
              OR (status='expired_effect'
                  AND UPPER(type::text) = ANY($2::text[])))
       ORDER BY id`,
      raceId,
      [...SETTLEMENT_EFFECT_TYPES, "HITCHHIKE"]
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
           event.multiplier, event.label, event.schedule_mode, event.summary_attribution_version,
           NULL::text AS entitlement_id, NULL::text AS impact_id,
           NULL::text AS impact_status, NULL::text AS user_id
         FROM global_step_events event
         JOIN races race ON race.id=$1
         WHERE event.schedule_mode='LEGACY_GLOBAL'
           AND event.ends_at > race.started_at AND event.starts_at <= $2
         UNION ALL
         SELECT event.id, entitlement.starts_at, entitlement.ends_at,
           event.multiplier, event.label, event.schedule_mode, event.summary_attribution_version,
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
         event.summary_attribution_version AS "summaryAttributionVersion",
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

  if (!raceRows[0]?.r_id) return null;
  // Keep race + roster in one SQL snapshot, but assemble their JSON in Node.
  // Explicit SQL aliases define the same payload keys as the former jsonb
  // projection. Epoch expressions are float8, so Prisma returns JSON numbers
  // rather than Decimal objects. The LEFT JOIN sentinel is not a participant.
  const project = (row, prefix) => Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value])
  );
  const raceRow = {
    race: project(raceRows[0], "r_"),
    participants: raceRows.filter((row) => row.p_id != null).map((row) => ({
      ...project(row, "p_"),
      ...(includePresentation ? { user: project(row, "u_") } : {}),
    })),
  };
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
  // The effect read returns active and historical inputs. `activeEffects` stays
  // ACTIVE-only because its shipped consumer is computeArtifactReuseDeadline
  // (getRaceProgress.js), which enumerates startsAt/expiresAt boundaries and
  // would pull an already-elapsed boundary out of an EXPIRED row. The closure
  // planner consumes `expiredScoringEffects` separately.
  const events = (eventRows || []).filter((row) => row?.id);
  const allEffects = effects || [];
  const expiredScoringEffects = allEffects.filter((row) =>
    row.status === "EXPIRED" && ["LEECH", "HITCHHIKE"].includes(row.type));
  const historicalScoringEffects = allEffects.filter((row) =>
    row.status === "EXPIRED" && !["LEECH", "HITCHHIKE"].includes(row.type));
  const activeEffects = allEffects.filter((row) => row.status !== "EXPIRED");
  const payload = {
    // Schema 4 protects the complete lean roster and historical scoring
    // effects reused by the compute adapters. Older display-artifact digests
    // mismatch and fall back to fresh computation during rolling deployment.
    schema: 4,
    race: raceRow.race,
    // Names are presentation data: artifact commands rebind them at commit.
    // A rename must not invalidate an otherwise identical scoring artifact.
    participants: raceRow.participants.map(({ user, ...scoring }) => scoring),
    inputs: normalizedInputs,
    effects: activeEffects,
    expiredScoringEffects,
    historicalScoringEffects,
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
    historicalScoringEffects,
    globalEvents: events || [],
    globalBoundaryScheduleCurrent:
      eventRows?.[0]?.globalBoundaryScheduleCurrent === true,
    // Spec rule 3 (TRAIL_MINE full-field projection) requires the persisted
    // total_steps of every accepted row "taken from the same fingerprint read —
    // no additional query". These rows were already selected and already
    // digested; returning them only widens what callers can READ off the
    // existing result.
    participants: raceRow.participants,
    // Internal closure-fence input. The full display-artifact digest above is
    // intentionally race-wide; the dependency worker needs the normalized
    // per-user generations separately so unrelated uploaders can be excluded
    // from a bounded closure fence without inventing a second database read.
    inputs: normalizedInputs,
    scoringEffects: allEffects,
    // Provenance is deliberately outside the digest: fence reads use a later
    // clock, while the immutable scoring facts must still hash identically.
    scoringReadSnapshot: { schema: 1, raceId, asOf: now.getTime(), through: horizon.getTime(), effectsComplete: true, raceComplete: true },
  };
}

module.exports = { buildRaceResolutionInputFingerprint };
