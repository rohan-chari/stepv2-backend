const { createHash } = require('node:crypto');
const redis = require('../../../shared/cache/redisCache');
const { coordinatedOptimizationMetrics: metrics } = require('../../../shared/observability/coordinatedOptimizationMetrics');

// Revision keys are immutable identities, not a Redis-owned 'current version'.
// An old in-flight loader can only populate its old, unreachable key. Coverage
// is checked independently so a narrower same-revision fill is only a miss.
const PREFIX = 'event-fingerprint:v2';
const MAX_ROWS = 8192;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TTL_MS = 30000;
const counts = Object.create(null);
const OUTCOMES = new Set(['hit', 'local_miss', 'global_miss', 'invalid', 'redis_error',
  'revision_mismatch', 'missing_proof', 'oversize', 'installed', 'fill_failed', 'sql_fallback']);
function count(outcome) {
  if (!OUTCOMES.has(outcome)) throw new TypeError('Invalid event cache metric');
  counts[outcome] = (counts[outcome] || 0) + 1;
  metrics.increment('event_fingerprint_cache_total', { outcome });
}
const revision = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const stamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const textOrNull = value => value === null || typeof value === 'string';
const rowKeys = 'endsAt,entitlementId,id,impactId,label,multiplier,scheduleMode,startsAt,userId';
function validRow(row, kind) {
  return row && Object.keys(row).sort().join(',') === rowKeys && typeof row.id === 'string' && row.id.length > 0 &&
    stamp(row.startsAt) && stamp(row.endsAt) && Number.isFinite(row.multiplier) && textOrNull(row.label) &&
    (kind === 'global' ? row.scheduleMode === 'LEGACY_GLOBAL' && row.entitlementId === null &&
      row.impactId === null && row.userId === null :
      row.scheduleMode === 'LOCAL_ENTITLEMENTS' && ['entitlementId', 'impactId', 'userId'].every(k => typeof row[k] === 'string'));
}
const checksum = payload => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
function key(kind, proof) {
  return kind === 'global' ? `${PREFIX}:global:${proof.databaseEpoch}:${proof.catalogRevision}:${proof.cursorDigest}` :
    `${PREFIX}:local:${proof.databaseEpoch}:${proof.raceId}:${proof.startedAt}:${proof.catalogRevision}:${proof.localWitnessDigest}`;
}
function validProof(proof) {
  return proof && /^[0-9a-f-]{36}$/.test(proof.databaseEpoch) && revision(proof.catalogRevision) && /^[a-f0-9]{64}$/.test(proof.cursorDigest) &&
    /^[a-f0-9]{64}$/.test(proof.localWitnessDigest) && Number.isFinite(proof.startedAt);
}
function valid(payload, kind, proof, now, horizon) {
  if (!payload || payload.schema !== 2 || payload.kind !== kind || payload.catalogRevision !== proof.catalogRevision ||
      payload.databaseEpoch !== proof.databaseEpoch ||
      (kind === 'global' ? payload.cursorDigest !== proof.cursorDigest :
        payload.localWitnessDigest !== proof.localWitnessDigest || payload.raceId !== proof.raceId) ||
      !Number.isFinite(payload.coversFrom) || !Number.isFinite(payload.coversThrough) ||
      payload.coversFrom > proof.startedAt || payload.coversThrough < horizon.getTime() ||
      !Number.isFinite(payload.asOf) || payload.asOf > now.getTime() ||
      !Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now() ||
      !Array.isArray(payload.events) || payload.events.length > MAX_ROWS) return false;
  const { checksum: digest, ...facts } = payload;
  if (typeof digest !== 'string' || checksum(facts) !== digest || Buffer.byteLength(JSON.stringify(payload)) > MAX_BYTES) return false;
  if (kind === 'global' && !(payload.cursor === null || (payload.cursor && stamp(payload.cursor.boundaryAt) &&
      typeof payload.cursor.eventId === 'string' && ['START', 'END'].includes(payload.cursor.boundaryKind)))) return false;
  const seen = new Set();
  if (kind === 'global' && (!Array.isArray(payload.pendingBoundaries) || payload.pendingBoundaries.length > MAX_ROWS * 2 ||
      !payload.pendingBoundaries.every(b => b && stamp(b.at) && stamp(b.endsAt)))) return false;
  const orderKeys = new Set();
  for (const row of payload.events) {
    if (!row || typeof row !== 'object') return false;
    const rowKind = row.scheduleMode === 'LEGACY_GLOBAL' ? 'global' : 'local';
    if (!validRow(row, kind === 'global' ? kind : rowKind)) return false;
    const identity = rowKind === 'global' ? row.id : row.entitlementId + ':' + row.impactId;
    if (seen.has(identity)) return false;
    seen.add(identity);
    const orderKey = row.startsAt + ':' + row.id;
    if (orderKeys.has(orderKey)) return false;
    orderKeys.add(orderKey);
  }
  return true;
}
async function read(proof, now, horizon) {
  const result = await redis.getManyJSON([key('global', proof), key('local', proof)]);
  if (!result.ok) { count('redis_error'); return null; }
  const [global, local] = result.values;
  const globalValid = valid(global, 'global', proof, now, horizon);
  const localValid = valid(local, 'local', proof, now, horizon);
  if (global && !globalValid || local && !localValid) count('invalid');
  return { global: globalValid ? global : null, local: localValid ? local : null };
}
async function write(kind, proof, rows, { coversThrough, now, cursor = null, pendingBoundaries = [] }) {
  if (rows.length > MAX_ROWS) { count('oversize'); return; }
  const events = rows.map(row => Object.fromEntries(rowKeys.split(',').map(k =>
    [k, row[k] instanceof Date ? row[k].toISOString() : row[k]])));
  if (!events.every(row => validRow(row, kind === 'global' ? kind : row.scheduleMode === 'LEGACY_GLOBAL' ? 'global' : 'local'))) { count('invalid'); return; }
  const boundaries = events.flatMap(row => [Date.parse(row.startsAt), Date.parse(row.endsAt)]).filter(t => t > now.getTime());
  const ttlMs = Math.min(MAX_TTL_MS, ...boundaries.map(t => t - now.getTime()));
  const payload = { schema: 2, kind, catalogRevision: proof.catalogRevision, databaseEpoch: proof.databaseEpoch,
    ...(kind === 'global' ? { cursorDigest: proof.cursorDigest, cursor, pendingBoundaries } :
      { localWitnessDigest: proof.localWitnessDigest, raceId: proof.raceId }),
    coversFrom: proof.startedAt, coversThrough: coversThrough.getTime(), asOf: now.getTime(),
    expiresAt: Date.now() + ttlMs, events };
  payload.checksum = checksum(payload);
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_BYTES) { count('oversize'); return; }
  count(await redis.setJSONWithTtlMs(key(kind, proof), payload, ttlMs) ? 'installed' : 'fill_failed');
}
function materialize(global, local, proof, now, horizon) {
  const eligible = row => Date.parse(row.endsAt) > proof.startedAt && Date.parse(row.startsAt) <= horizon.getTime();
  const cursor = global.cursor;
  // PostgreSQL performed ALL text ordering and cursor tuple comparisons at fill.
  // Retain its full ordered vector (including duplicate event IDs for users),
  // never reproduce database collation with a JavaScript string comparator.
  const current = cursor !== null && !global.pendingBoundaries.some(b =>
    Date.parse(b.endsAt) > proof.startedAt && Date.parse(b.at) <= now.getTime());
  const rows = local.events.filter(eligible)
    .map(row => ({ ...row, startsAt: new Date(row.startsAt), endsAt: new Date(row.endsAt), globalBoundaryScheduleCurrent: current }));
  return rows.length ? rows : [{ id: null, globalBoundaryScheduleCurrent: current }];
}
// Read-only, process-local diagnostic snapshot; no per-race/user metric labels.
function diagnostics() { return { schema: 1, mode: 'worker-planning-only', finalFence: 'postgresql',
  completionBypass: false, maxRows: MAX_ROWS, maxBytes: MAX_BYTES, maxTtlMs: MAX_TTL_MS, counts: { ...counts } }; }
module.exports = { read, write, materialize, validProof, count, diagnostics, MAX_ROWS };
