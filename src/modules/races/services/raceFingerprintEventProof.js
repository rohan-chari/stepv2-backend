const { createHash } = require('node:crypto');
const { MAX_ROWS } = require('./raceFingerprintEventCache');

// Materialize once per race, before the roster fan-out. This is a fresh DB
// witness, NOT a Redis marker. Do not filter by membership, activation, or time:
// even an absent entitlement and a pending impact must invalidate negative hits.
const EVENT_PROOF_CTE = `event_proof AS MATERIALIZED (
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
        WHERE impact.race_id=$1 ORDER BY impact.id LIMIT ${MAX_ROWS + 1}) w) AS witness
  FROM races race
  LEFT JOIN event_catalog_revision catalog ON catalog.id=1
  LEFT JOIN global_step_event_boundary_cursors cursor ON cursor.key='global'
  WHERE race.id=$1
)`;
const PROOF_COLUMNS = `proof."catalogRevision" AS "f_catalogRevision",
  proof."databaseEpoch" AS "f_databaseEpoch",
  proof."precisionSafe" AS "f_precisionSafe",
  proof."startedAt" AS "f_startedAt", proof.witness AS "f_witness",
  proof."boundaryAt" AS "f_boundaryAt", proof."cursorEventId" AS "f_cursorEventId",
  proof."boundaryKind" AS "f_boundaryKind"`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function proofFromRow(row, raceId) {
  if (!row || row.f_precisionSafe !== true || typeof row.f_catalogRevision !== 'string' || !row.f_startedAt ||
      !row.f_witness || !Number.isSafeInteger(row.f_witness.count) || row.f_witness.count > MAX_ROWS ||
      !/^[a-f0-9]{64}$/.test(row.f_witness.digest)) return null;
  const cursor = row.f_boundaryAt == null ? null : {
    boundaryAt: new Date(row.f_boundaryAt).toISOString(), eventId: row.f_cursorEventId, boundaryKind: row.f_boundaryKind,
  };
  return { raceId, startedAt: new Date(row.f_startedAt).getTime(), catalogRevision: row.f_catalogRevision, databaseEpoch: row.f_databaseEpoch,
    cursorDigest: hash(cursor), localWitnessDigest: row.f_witness.digest, cursor };
}
function matches(left, right) {
  return left && right && left.catalogRevision === right.catalogRevision &&
    left.databaseEpoch === right.databaseEpoch &&
    left.cursorDigest === right.cursorDigest && left.localWitnessDigest === right.localWitnessDigest &&
    left.startedAt === right.startedAt;
}
module.exports = { EVENT_PROOF_CTE, PROOF_COLUMNS, proofFromRow, matches };
