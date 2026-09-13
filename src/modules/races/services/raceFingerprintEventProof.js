const { createHash } = require('node:crypto');
const { MAX_ROWS } = require('./raceFingerprintEventCache');

// The database maintains the local version and count transactionally. This
// statement and cache fills each read their own version from the same MVCC
// snapshot as their data. Missing state disables reuse; final fences stay SQL.
const EVENT_PROOF_CTE = `event_proof AS MATERIALIZED (
  SELECT race.id AS "raceId", race.started_at AS "startedAt",
    (race.started_at=date_trunc('milliseconds', race.started_at) AND
      (cursor.boundary_at IS NULL OR cursor.boundary_at=date_trunc('milliseconds', cursor.boundary_at))) AS "precisionSafe",
    catalog.revision::text AS "catalogRevision",
    catalog.epoch::text AS "databaseEpoch",
    cursor.boundary_at AS "boundaryAt", cursor.event_id AS "cursorEventId",
    cursor.boundary_kind AS "boundaryKind",
    CASE WHEN version.race_id IS NOT NULL THEN jsonb_build_object(
      'count', version.impact_count,
      'incarnation', version.incarnation::text,
      'revision', version.revision::text) END AS witness
  FROM races race
  LEFT JOIN race_event_fingerprint_versions version ON version.race_id=race.id
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
      row.f_witness.count < 0 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.f_witness.incarnation) ||
      typeof row.f_witness.revision !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.f_witness.revision)) return null;
  const cursor = row.f_boundaryAt == null ? null : {
    boundaryAt: new Date(row.f_boundaryAt).toISOString(), eventId: row.f_cursorEventId, boundaryKind: row.f_boundaryKind,
  };
  return { raceId, startedAt: new Date(row.f_startedAt).getTime(), catalogRevision: row.f_catalogRevision, databaseEpoch: row.f_databaseEpoch,
    cursorDigest: hash(cursor), localWitnessDigest: hash(['race-version-v1', row.f_witness.incarnation, row.f_witness.revision, row.f_witness.count]), cursor };
}
function matches(left, right) {
  return left && right && left.catalogRevision === right.catalogRevision &&
    left.databaseEpoch === right.databaseEpoch &&
    left.cursorDigest === right.cursorDigest && left.localWitnessDigest === right.localWitnessDigest &&
    left.startedAt === right.startedAt;
}
module.exports = { EVENT_PROOF_CTE, PROOF_COLUMNS, proofFromRow, matches };
