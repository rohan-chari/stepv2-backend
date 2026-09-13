const redis = require('../../../shared/cache/redisCache');
const { prisma } = require('../../../db');
const { coordinatedOptimizationMetrics: metrics } = require('../../../shared/observability/coordinatedOptimizationMetrics');
const { createHash } = require('node:crypto');
const DAY = 86400000;
const MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 20000;
const MAX_BATCH_BYTES = 4 * MAX_BYTES;
const MAX_BATCH_ROWS = 50000;
const TTL_MS = 600000;
const totals = { hits: 0, misses: 0, rowsReused: 0, recentRowsRead: 0, fullRowsRead: 0, proofRaces: 0 };
function count(name, value = 1) {
  totals[name] += value;
  metrics.increment('race_scoring_historical_raw_cache_total', { outcome: name }, value);
}
let telemetryTimer;
function startTelemetry() {
  if (telemetryTimer) return;
  telemetryTimer = setInterval(() => console.info(JSON.stringify({ event: 'historical_raw_sample_cache', pid: process.pid, ...totals })), 60000);
  telemetryTimer.unref();
}
const READ = `local out = {}; local remaining = tonumber(ARGV[2]); for i,key in ipairs(KEYS) do
  local size = redis.call('STRLEN',key)
  if size > 0 and size <= tonumber(ARGV[1]) and size <= remaining then
    out[i] = redis.call('GET',key); remaining = remaining - size
  else out[i] = false end
end; return out`;
function normalize(row) {
  if (!row?.historicalRawRevision || row.historicalRawCompleteGeneration == null ||
      String(row.generation) !== String(row.historicalRawCompleteGeneration)) return null;
  const cutoff = new Date(row.historicalRawProtectedCutoff).getTime();
  if (!Number.isSafeInteger(cutoff) || cutoff % DAY !== 0) return null;
  return { generation: String(row.generation), revision: row.historicalRawRevision,
    complete: String(row.historicalRawCompleteGeneration), cutoff };
}
async function proofs(bounds) {
  const rows = await prisma.$queryRawUnsafe(`/* steps:historical-raw-proof:v1 */
    SELECT user_id AS "userId",generation,
      historical_raw_revision AS "historicalRawRevision",
      historical_raw_complete_generation AS "historicalRawCompleteGeneration",
      historical_raw_protected_cutoff AS "historicalRawProtectedCutoff"
    FROM user_scoring_input_versions WHERE user_id = ANY($1::text[])`, bounds.map(b => b.userId));
  return new Map(rows.map(row => [row.userId, normalize(row)]));
}
const equal = (a, b) => a && b && a.generation === b.generation && a.revision === b.revision && a.complete === b.complete && a.cutoff === b.cutoff;
function keyFor(bound, proof, cutoff) {
  const coverage = createHash('sha256').update(JSON.stringify([bound.userId, +bound.rangeStart, cutoff])).digest('hex');
  return `historical-raw:v1:${proof.revision}:${coverage}`;
}
function validate(value, bound, proof, cutoff) {
    if (!value || value.version !== 1 || value.revision !== proof.revision || value.userId !== bound.userId ||
        value.start !== +bound.rangeStart || value.cutoff !== cutoff || !Array.isArray(value.rows) || value.rows.length > MAX_ROWS) return null;
    let previous = -Infinity;
    for (const row of value.rows) {
      if (!Array.isArray(row) || row.length !== 3 || !row.every(Number.isSafeInteger) ||
          row[0] <= previous || row[1] <= row[0] || row[1] > cutoff || row[1] <= value.start ||
          row[2] < 0 || row[2] > 2147483647) return null;
      previous = row[0];
    }
    return value;
}
function parse(raw, bound, proof, cutoff) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BYTES) return null;
  try { return validate(JSON.parse(raw), bound, proof, cutoff); }
  catch { return null; }
}
// The caller is exclusively the real worker's nontransactional source phase.
// The canonical bounded loader remains responsible for PostgreSQL paging/spill.
async function loadHistoricalRawSamples({ bounds, now, load, Timeline,
  maxRetainedSampleRowsPerUser, maxHeapGrowthBytes, memoryUsage = process.memoryUsage }) {
  // Tighter caller budgets keep the existing paging/spill loader untouched.
  // The default 32 MiB budget reserves at most 4 MiB encoded cache input,
  // 50k parsed rows and one sequential <=1 MiB publication at a time.
  if (!redis.isEnabled() || maxRetainedSampleRowsPerUser < 50000 || maxHeapGrowthBytes < 32 * 1024 * 1024) return load(bounds);
  const result = new Map();
  for (let offset = 0; offset < bounds.length; offset += 25) {
    const batch = bounds.slice(offset, offset + 25);
    const batchMemory = memoryUsage();
    const totalBytes = memory => Math.max(0, Number(memory?.heapUsed) || 0) + Math.max(0, Number(memory?.external) || 0);
    const initialBytes = totalBytes(batchMemory);
    const checkMemory = () => {
      const memory = memoryUsage();
      if (totalBytes(memory) - initialBytes > maxHeapGrowthBytes) {
        throw new Error('worker scoring input exceeded the 32 MiB process memory guard');
      }
    };
    const decisionCutoff = Math.floor(+now / DAY) * DAY - 2 * DAY;
    if (!batch.some(b => +b.rangeStart < decisionCutoff)) {
      for (const [id, timeline] of await load(batch)) result.set(id, timeline);
      continue;
    }
    startTelemetry();
    const before = await proofs(batch);
    const candidates = batch.flatMap(bound => {
      const proof = before.get(bound.userId);
      const cutoff = proof && Math.min(decisionCutoff, proof.cutoff);
      return proof && +bound.rangeStart < cutoff ? [{ bound, proof, cutoff, key: keyFor(bound, proof, cutoff) }] : [];
    });
    const hits = new Map();
    let redisReadFailed = false;
    let remainingBytes = MAX_BATCH_BYTES;
    let remainingRows = MAX_BATCH_ROWS;
    for (let index = 0; index < candidates.length && remainingBytes > 0; index += 4) {
      const chunk = candidates.slice(index, index + 4);
      const reply = await redis.evalLua(READ, chunk.map(c => c.key), [MAX_BYTES, remainingBytes], { genericError: true });
      if (!reply.ok) { redisReadFailed = true; break; }
      for (let n = 0; n < chunk.length; n++) {
        const raw = reply.result?.[n];
        if (typeof raw === 'string') remainingBytes -= Buffer.byteLength(raw);
        const c = chunk[n]; const value = parse(raw, c.bound, c.proof, c.cutoff);
        if (value && value.rows.length <= remainingRows) {
          remainingRows -= value.rows.length; hits.set(c.bound.userId, value);
        }
      }
    }
    checkMemory();
    const loaded = await load(batch.map(bound => hits.has(bound.userId)
      ? { ...bound, rangeStart: new Date(hits.get(bound.userId).cutoff) } : bound));
    const after = candidates.length && (!redisReadFailed || hits.size) ? await proofs(batch) : new Map();
    const rejectedBounds = batch.filter(bound => {
      const hit = hits.get(bound.userId);
      const timeline = loaded.get(bound.userId);
      return hit && (timeline?.isPaged || !equal(before.get(bound.userId), after.get(bound.userId)) ||
        (timeline?.length || 0) + hit.rows.length > maxRetainedSampleRowsPerUser);
    });
    const rejectedUsers = new Set(rejectedBounds.map(bound => bound.userId));
    for (const bound of rejectedBounds) {
      loaded.get(bound.userId)?.dispose?.();
      loaded.delete(bound.userId); hits.delete(bound.userId); count('proofRaces');
    }
    // An overlapping sync burst invalidates users together; preserve the
    // canonical batch read instead of introducing one fallback SELECT per user.
    if (rejectedBounds.length) for (const [id, timeline] of await load(rejectedBounds)) loaded.set(id, timeline);
    for (const bound of batch) {
      let timeline = loaded.get(bound.userId) || new Timeline();
      const hit = hits.get(bound.userId);
      if (hit) {
        count('hits'); count('rowsReused', hit.rows.length); count('recentRowsRead', timeline.length);
        const rows = hit.rows.map(([start, end, steps]) => ({ start, end, steps }));
        timeline.forEach((start, end, steps) => rows.push({ start, end, steps }));
        rows.sort((a, b) => a.start - b.start);
        const merged = new Timeline(); merged.append(rows); timeline = merged;
      } else { count('misses'); count('fullRowsRead', timeline.length); }
      result.set(bound.userId, timeline);
      checkMemory();
    }
    // Sequential publication bounds serialization/transport overhead. Unknown
    // legacy proof or any intervening writer leaves source content uncacheable.
    for (const c of candidates) {
      if (redisReadFailed || rejectedUsers.has(c.bound.userId) || hits.has(c.bound.userId) || !equal(c.proof, after.get(c.bound.userId))) continue;
      const timeline = result.get(c.bound.userId);
      if (!timeline || timeline.isPaged || timeline.length > MAX_ROWS) continue;
      const rows = [];
      timeline.forEach((start, end, steps) => { if (end <= c.cutoff) rows.push([start, end, steps]); });
      const value = { version: 1, userId: c.bound.userId, revision: c.proof.revision, start: +c.bound.rangeStart, cutoff: c.cutoff, rows };
      const payload = JSON.stringify(value);
      checkMemory();
      if (Buffer.byteLength(payload) <= MAX_BYTES && validate(value, c.bound, c.proof, c.cutoff)) {
        await redis.evalLua("return redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[2])", [c.key], [payload, TTL_MS], { genericError: true });
      }
    }
  }
  return result;
}
module.exports = { loadHistoricalRawSamples };
