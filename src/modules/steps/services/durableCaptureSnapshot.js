// Metadata and chunk revisions must be selected by ONE statement. Race queue
// locks do not fence every effect/checkpoint writer. Hold the GC fence until
// the caller has pinned this saved vector in the same intake transaction.
async function readDurableCaptureSnapshot(client, { raceIds, raceWindows, effectTypes }) {
  await client.$queryRawUnsafe("SELECT pg_advisory_xact_lock_shared(904205010001::bigint)::text");
  const [snapshot] = await client.$queryRawUnsafe(`WITH
    races AS MATERIALIZED (SELECT id,started_at,ends_at,timezone,powerups_enabled
      FROM races WHERE id=ANY($1::text[])),
    participants AS MATERIALIZED (SELECT p.id,p.race_id,p.user_id,p.finished_at,p.forfeited_at,p.joined_at,p.bonus_steps
      FROM race_participants p JOIN races r ON r.id=p.race_id WHERE p.status='accepted'),
    effects AS MATERIALIZED (SELECT e.id,e.race_id,e.type,e.status,e.starts_at,e.expires_at,
      e.target_participant_id,e.target_user_id,e.source_user_id,e.metadata
      FROM race_active_effects e JOIN races r ON r.id=e.race_id
      WHERE e.type::text=ANY($3::text[]) AND e.status IN ('active_effect','expired_effect')),
    race_users AS MATERIALIZED (SELECT race_id,user_id FROM participants
      UNION SELECT race_id,source_user_id FROM effects UNION SELECT race_id,target_user_id FROM effects),
    requested_windows AS MATERIALIZED (SELECT * FROM jsonb_to_recordset($2::jsonb)
      AS w("raceId" text,"userId" text,"eventEndsAt" timestamp)),
    race_windows AS MATERIALIZED (SELECT r.id AS race_id,(r.started_at-INTERVAL '1 day')::date AS first_day,
      LEAST(w."eventEndsAt",r.ends_at,p.finished_at,p.forfeited_at)+INTERVAL '1 day' AS exclusive_end
      FROM requested_windows w JOIN races r ON r.id=w."raceId"
      JOIN participants p ON p.race_id=r.id AND p.user_id=w."userId"),
    heads AS MATERIALIZED (SELECT DISTINCT h.user_id,h.day,h.revision::text
      FROM race_windows w JOIN race_users u ON u.race_id=w.race_id
      JOIN durable_capture_fact_heads h ON h.user_id=u.user_id
      WHERE h.day=DATE '0001-01-01' OR (h.day>=w.first_day AND h.day::timestamp<w.exclusive_end))
    SELECT
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,
        'startedAt',to_char(r.started_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'endsAt',to_char(r.ends_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'timezone',r.timezone,'powerupsEnabled',r.powerups_enabled,'participants',
        coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'userId',p.user_id,
          'finishedAt',to_char(p.finished_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'forfeitedAt',to_char(p.forfeited_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'joinedAt',to_char(p.joined_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'bonusSteps',p.bonus_steps) ORDER BY p.user_id) FROM participants p WHERE p.race_id=r.id),'[]'::jsonb)
        ) ORDER BY r.id) FROM races r),'[]'::jsonb) AS races,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'raceId',e.race_id,'type',upper(e.type::text),
        'status',CASE WHEN e.status='active_effect' THEN 'ACTIVE' ELSE 'EXPIRED' END,
        'startsAt',to_char(e.starts_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'expiresAt',to_char(e.expires_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'targetParticipantId',e.target_participant_id,'targetUserId',e.target_user_id,
        'sourceUserId',e.source_user_id,'metadata',e.metadata) ORDER BY e.starts_at,e.id) FROM effects e),'[]'::jsonb) AS effects,
      coalesce((SELECT jsonb_agg(to_jsonb(h) || jsonb_build_object('scoring_input_generation',h.scoring_input_generation::text,
        'cast_day_start',to_char(h.cast_day_start,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'cast_sample_boundary_at',to_char(h.cast_sample_boundary_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'capture_through',to_char(h.capture_through,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'frozen_at',to_char(h.frozen_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'created_at',to_char(h.created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'updated_at',to_char(h.updated_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        ORDER BY h.effect_id) FROM hitchhike_attribution_captures h JOIN effects e ON e.id=h.effect_id
        WHERE e.type='hitchhike'),'[]'::jsonb) AS checkpoints,
      coalesce((SELECT jsonb_agg(jsonb_build_object('userId',h.user_id,'day',h.day::text,'revision',h.revision))
        FROM heads h),'[]'::jsonb) AS heads`, raceIds, JSON.stringify(raceWindows), effectTypes.map((type) => type.toLowerCase()));
  // Only checkpoint column names are translated; never rewrite metadata keys.
  snapshot.hitchhikeCaptures = snapshot.checkpoints.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]),
  ));
  const { coordinatedOptimizationMetrics: metrics } = require("../../../shared/observability/coordinatedOptimizationMetrics");
  metrics.observe("global_summary_capture_snapshot_head_rows", snapshot.heads.length);
  metrics.observe("global_summary_capture_snapshot_head_bytes", Buffer.byteLength(JSON.stringify(snapshot.heads)));
  return snapshot;
}

module.exports = { readDurableCaptureSnapshot };
