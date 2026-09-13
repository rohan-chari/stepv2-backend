event_proof AS MATERIALIZED (
  SELECT race.id AS "raceId", race.started_at AS "startedAt",
    (race.started_at=date_trunc('milliseconds', race.started_at) AND
      (cursor.boundary_at IS NULL OR cursor.boundary_at=date_trunc('milliseconds', cursor.boundary_at))) AS "precisionSafe",
    catalog.revision::text AS "catalogRevision",
    catalog.epoch::text AS "databaseEpoch",
    cursor.boundary_at AS "boundaryAt", cursor.event_id AS "cursorEventId",
    cursor.boundary_kind AS "boundaryKind",
    (SELECT jsonb_build_object('count', COUNT(*),
      'digest',
      encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_array(w.id, w.event_id, w.user_id,
        w.fingerprint_revision::text, w.fingerprint_incarnation, w.entitlement_id,
        w.entitlement_revision::text, w.entitlement_incarnation) ORDER BY w.id), '[]'::jsonb)::text,
        'UTF8')), 'hex'))
      FROM (SELECT impact.id, impact.event_id, impact.user_id, impact.fingerprint_revision, impact.fingerprint_incarnation,
          entitlement.id AS entitlement_id, entitlement.fingerprint_revision AS entitlement_revision,
          entitlement.fingerprint_incarnation AS entitlement_incarnation
        FROM global_event_race_impacts impact
        LEFT JOIN global_step_event_entitlements entitlement
          ON entitlement.event_id=impact.event_id AND entitlement.user_id=impact.user_id
        WHERE impact.race_id=$1 ORDER BY impact.id LIMIT 8193) w) AS witness
  FROM races race
  LEFT JOIN event_catalog_revision catalog ON catalog.id=1
  LEFT JOIN global_step_event_boundary_cursors cursor ON cursor.key='global'
  WHERE race.id=$1
)
