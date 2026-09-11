const cache = require('./raceFingerprintEventCache');
const { FULL_EVENT_SQL } = require('./raceFingerprintEventSql');
const { EVENT_PROOF_CTE, PROOF_COLUMNS, proofFromRow, matches } = require('./raceFingerprintEventProof');

// Same predicate and fields as the deployed local UNION branch. MATERIALIZED
// ensures an empty impact/entitlement result cannot drive a parent catalog scan.
// The parent is fetched by PK for each bounded input via a parameterized lateral
// lookup; OFFSET 0 retains that direction even when the result is empty.
const LOCAL_EVENT_SQL = `/* steps:prepared-read:v1 */ /* event-fingerprint:local */
WITH race_window AS (SELECT started_at FROM races WHERE id=$1),
${EVENT_PROOF_CTE}, local_candidates AS MATERIALIZED (
  SELECT impact.id AS "impactId", impact.event_id,
    entitlement.id AS "entitlementId", entitlement.user_id AS "userId",
    entitlement.starts_at AS "startsAt", entitlement.ends_at AS "endsAt"
  FROM global_event_race_impacts impact
  JOIN global_step_event_entitlements entitlement
    ON entitlement.event_id=impact.event_id AND entitlement.user_id=impact.user_id
  CROSS JOIN race_window race
  WHERE impact.race_id=$1
    AND entitlement.start_outcome IN ('ACTIVATED_ON_TIME','ACTIVATED_LATE_JOIN')
    AND entitlement.ends_at > race.started_at AND entitlement.starts_at <= $2
  ORDER BY entitlement.starts_at, impact.event_id, entitlement.id, impact.id, entitlement.user_id LIMIT ${cache.MAX_ROWS + 1}
), local_events AS (
  SELECT event.id, candidate."startsAt", candidate."endsAt", event.multiplier, event.label,
    event.schedule_mode AS "scheduleMode",
    candidate."entitlementId", candidate."impactId", candidate."userId"
  FROM local_candidates candidate
  CROSS JOIN LATERAL (SELECT * FROM global_step_events parent
    WHERE parent.id=candidate.event_id AND parent.schedule_mode='LOCAL_ENTITLEMENTS' OFFSET 0) event
  UNION ALL
  SELECT id, "startsAt", "endsAt", multiplier, label, "scheduleMode",
    "entitlementId", "impactId", "userId"
  FROM jsonb_to_recordset($3::jsonb) AS cached(id text, "startsAt" timestamp, "endsAt" timestamp,
    multiplier double precision, label text, "scheduleMode" text,
    "entitlementId" text, "impactId" text, "userId" text)
)
SELECT event.*, ${PROOF_COLUMNS},
  COUNT(*) OVER (PARTITION BY event."startsAt", event.id, event."entitlementId", event."impactId", event."userId") AS "f_orderTies",
  (event.id IS NULL OR (event."startsAt"=date_trunc('milliseconds',event."startsAt") AND
    event."endsAt"=date_trunc('milliseconds',event."endsAt"))) AS "f_eventPrecisionSafe"
FROM event_proof proof
LEFT JOIN local_events event ON TRUE ORDER BY event."startsAt", event.id, event."entitlementId", event."impactId", event."userId"`;

// One statement stamps rows AND cursor/witnesses from the same MVCC snapshot.
// The nested deployed query keeps its precise ordering and half-open predicates.
const FILL_SQL = `/* steps:prepared-read:v1 */ /* event-fingerprint:fill */
WITH ${EVENT_PROOF_CTE}, event_rows AS MATERIALIZED (
  ${FULL_EVENT_SQL} LIMIT ${cache.MAX_ROWS + 1}
)
SELECT event.*, ${PROOF_COLUMNS},
  COUNT(*) OVER (PARTITION BY event."startsAt", event.id, event."entitlementId", event."impactId", event."userId") AS "f_orderTies",
  (event.id IS NULL OR (event."startsAt"=date_trunc('milliseconds',event."startsAt") AND
    event."endsAt"=date_trunc('milliseconds',event."endsAt"))) AS "f_eventPrecisionSafe",
  (event."startsAt", event.id, 'START'::text) >
    (proof."boundaryAt", proof."cursorEventId", proof."boundaryKind"::text) AS "f_startPending",
  (event."endsAt", event.id, 'END'::text) >
    (proof."boundaryAt", proof."cursorEventId", proof."boundaryKind"::text) AS "f_endPending"
FROM event_rows event
CROSS JOIN event_proof proof ORDER BY event."startsAt", event.id, event."entitlementId", event."impactId", event."userId"`;

async function readRaceFingerprintEvents({ client, raceId, now, horizon, proof }) {
  const fallback = () => {
    cache.count('sql_fallback');
    return client.$queryRawUnsafe(FULL_EVENT_SQL, raceId, horizon, now.getTime());
  };
  if (!cache.validProof(proof)) { cache.count('missing_proof'); return fallback(); }
  const cached = await cache.read(proof, now, horizon);
  if (!cached) return fallback();
  if (cached.global && cached.local) {
    cache.count('hit');
    return cache.materialize(cached.global, cached.local, proof, now, horizon);
  }
  // Minute-rounded extra coverage lets the next request's moving ten-minute
  // horizon reuse this exact vector. Filtering restores the caller's horizon.
  const coversThrough = new Date(Math.ceil(horizon.getTime() / 60000) * 60000 + 60000);
  const localOnly = !!cached.global;
  cache.count(localOnly ? 'local_miss' : 'global_miss');
  const loaded = await client.$queryRawUnsafe(localOnly ? LOCAL_EVENT_SQL : FILL_SQL,
    raceId, coversThrough, localOnly ? JSON.stringify(cached.global.events) : now.getTime());
  const loadedProof = proofFromRow(loaded[0], raceId);
  if (!matches(proof, loadedProof)) { cache.count('revision_mismatch'); return fallback(); }
  const events = loaded.filter(row => row.id);
  // The full and cached queries share a total order, including per-user rows.
  // Retain a fail-closed guard for duplicate complete identities.
  if (events.some(row => Number(row.f_orderTies) !== 1)) { cache.count('missing_proof'); return fallback(); }
  if (loaded.some(row => row.f_eventPrecisionSafe !== true)) { cache.count('missing_proof'); return fallback(); }
  if (events.length > cache.MAX_ROWS) { cache.count('oversize'); return fallback(); }
  const pendingBoundaries = events.filter(row => row.scheduleMode === 'LEGACY_GLOBAL').flatMap(row => [
    ...(row.f_startPending ? [{ at: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString() }] : []),
    ...(row.f_endPending ? [{ at: row.endsAt.toISOString(), endsAt: row.endsAt.toISOString() }] : []),
  ]);
  // A split refresh can only claim the intersection with global coverage.
  const completeThrough = localOnly ? new Date(Math.min(coversThrough.getTime(), cached.global.coversThrough)) : coversThrough;
  await cache.write('local', proof, events, { coversThrough: completeThrough, now });
  if (!localOnly) {
    await cache.write('global', proof, events.filter(row => row.scheduleMode === 'LEGACY_GLOBAL'),
      { coversThrough, now, cursor: loadedProof.cursor, pendingBoundaries });
  }
  // Materialize the DB rows without re-reading Redis or trusting a successful
  // cache write. All extra metadata stays outside the immutable event digest.
  const clean = rows => rows.map(row => Object.fromEntries([
    'id', 'startsAt', 'endsAt', 'multiplier', 'label', 'scheduleMode',
    'entitlementId', 'impactId', 'userId',
  ].map(k => [k, row[k] instanceof Date ? row[k].toISOString() : row[k]])));
  return cache.materialize(localOnly ? cached.global : {
    events: clean(events.filter(row => row.scheduleMode === 'LEGACY_GLOBAL')), cursor: loadedProof.cursor, pendingBoundaries,
  }, { events: clean(events) }, proof, now, horizon);
}
module.exports = { readRaceFingerprintEvents };
