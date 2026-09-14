const { recordCacheStage: stage, recordCacheRows: reasonRows, recordCacheIO: io, observeCoverage, setLegacySnapshot } = require('./historicalCacheTelemetry');
const { performance } = require('node:perf_hooks');
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
setLegacySnapshot(() => totals);
const READ = `local out = {}; local remaining = tonumber(ARGV[2]); for i,key in ipairs(KEYS) do
  local size = redis.call('STRLEN',key)
  if size == 0 then out[i] = {'absent_unknown',0}
  elseif size > tonumber(ARGV[1]) then out[i] = {'oversized',size}
  elseif size > remaining then out[i] = {'batch_byte_budget',size}
  else out[i] = {'accepted',size,redis.call('GET',key)}; remaining = remaining-size end
end; return out`;
function proofReason(row) {
  if (!row) return 'missing';
  if (!row.historicalRawRevision || row.historicalRawCompleteGeneration == null || row.generation == null) return 'missing';
  if (String(row.generation) !== String(row.historicalRawCompleteGeneration)) return 'incomplete_generation';
  if (!normalize(row)) return 'malformed';
  return null;
}
function normalize(row) {
  if (!row?.historicalRawRevision || row.historicalRawCompleteGeneration == null ||
      String(row.generation) !== String(row.historicalRawCompleteGeneration)) return null;
  const cutoff = new Date(row.historicalRawProtectedCutoff).getTime();
  if (!Number.isSafeInteger(cutoff) || cutoff % DAY !== 0) return null;
  return { generation: String(row.generation), revision: row.historicalRawRevision,
    complete: String(row.historicalRawCompleteGeneration), cutoff };
}
async function proofs(bounds) {
  const started = performance.now();
  const rows = await prisma.$queryRawUnsafe(`/* steps:historical-raw-proof:v1 */
    SELECT user_id AS "userId",generation,
      historical_raw_revision AS "historicalRawRevision",
      historical_raw_complete_generation AS "historicalRawCompleteGeneration",
      historical_raw_protected_cutoff AS "historicalRawProtectedCutoff"
    FROM user_scoring_input_versions WHERE user_id = ANY($1::text[])`, bounds.map(b => b.userId));
  io('proof', { operations: 1, rows: rows.length, elapsedMs: performance.now() - started });
  return new Map(rows.map(row => [row.userId, { proof: normalize(row), reason: proofReason(row) }]));
}
// A one-attempt opaque capability, never a process-cache entry. Each user may
// supply its initial proof only once; retry/repeated loads use a fresh SELECT.
const initialReads = new WeakMap();
function captureInitialProofRead(rows, userIds, attempt) {
  const expected = new Set(userIds);
  if (!attempt || expected.size !== userIds.length || !Array.isArray(rows)) return null;
  const captured = new Map();
  for (const row of rows) {
    if (!expected.has(row.userId) || captured.has(row.userId)) return null;
    if (!Object.hasOwn(row, 'historicalRawRevision') || !Object.hasOwn(row, 'historicalRawCompleteGeneration') ||
        !Object.hasOwn(row, 'historicalRawProtectedCutoff')) return null;
    const proof = normalize(row);
    captured.set(row.userId, Object.freeze({ proof: proof && Object.freeze(proof), reason: proofReason(row) }));
  }
  // Missing database rows are authoritative missing proof, not fabricated data.
  for (const id of expected) if (!captured.has(id)) captured.set(id, Object.freeze({ proof: null, reason: 'missing' }));
  const handle = Object.freeze({});
  initialReads.set(handle, { attempt, captured, consumed: new Set() });
  return handle;
}
function consumeInitialProofRead(handle, attempt, bounds) {
  const read = handle && initialReads.get(handle);
  const ids = bounds.map(bound => bound.userId);
  if (!read || read.attempt !== attempt || new Set(ids).size !== ids.length ||
      ids.some(id => !read.captured.has(id) || read.consumed.has(id))) return null;
  for (const id of ids) read.consumed.add(id);
  return new Map(ids.map(id => [id, read.captured.get(id)]));
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
  maxRetainedSampleRowsPerUser, maxHeapGrowthBytes, memoryUsage = process.memoryUsage, initialProofRead = null, sourceAttempt = null, telemetryContext = null }) {
  // Tighter caller budgets keep the existing paging/spill loader untouched.
  // The default 32 MiB budget reserves at most 4 MiB encoded cache input,
  // 50k parsed rows and one sequential <=1 MiB publication at a time.
  const bypass = !redis.isEnabled() ? 'redis_disabled'
    : maxRetainedSampleRowsPerUser < 50000 || maxHeapGrowthBytes < 32 * 1024 * 1024 ? 'caller_budget' : null;
  if (bypass) {
    for (const bound of bounds) telemetryContext?.recordRedisEligibility?.('cache_disabled_or_budget');
    stage('raw', bypass, bounds.length);
    const loaded = await load(bounds);
    io('full', { rows: [...loaded.values()].reduce((sum, timeline) => sum + (timeline?.length || 0), 0) });
    return loaded;
  }
  const result = new Map();
  for (let offset = 0; offset < bounds.length; offset += 25) {
    const batch = bounds.slice(offset, offset + 25);
    const terminalUsers = new Set();
    try {
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
      for (const bound of batch) telemetryContext?.recordRedisEligibility?.('recent_mutable_range');
      stage('raw', 'no_historical_range', batch.length);
      for (const bound of batch) terminalUsers.add(bound.userId);
      for (const [id, timeline] of await load(batch)) { result.set(id, timeline); io('full', { rows: timeline?.length || 0 }); }
      continue;
    }
    const before = consumeInitialProofRead(initialProofRead, sourceAttempt, batch) || await proofs(batch);
    const outcomes = new Map();
    const candidates = batch.flatMap(bound => {
      const proof = before.get(bound.userId)?.proof;
      const cutoff = proof && Math.min(decisionCutoff, proof.cutoff);
      if (!proof) { outcomes.set(bound.userId, before.get(bound.userId)?.reason || 'missing'); telemetryContext?.recordRedisEligibility?.('no_historical_proof'); }
      else if (!(+bound.rangeStart < cutoff)) { outcomes.set(bound.userId, 'no_historical_range'); telemetryContext?.recordRedisEligibility?.('recent_mutable_range'); }
      else telemetryContext?.recordRedisEligibility?.('eligible');
      const coverageReason = proof && +bound.rangeStart < cutoff ? observeCoverage(bound, proof, cutoff) : null;
      return proof && +bound.rangeStart < cutoff ? [{ bound, proof, cutoff, coverageReason, key: keyFor(bound, proof, cutoff) }] : [];
    });
    const hits = new Map();
    let redisReadFailed = false;
    let remainingBytes = MAX_BATCH_BYTES;
    let remainingRows = MAX_BATCH_ROWS;
    for (let index = 0; index < candidates.length; index += 4) {
      const chunk = candidates.slice(index, index + 4);
      if (remainingBytes <= 0 || redisReadFailed) {
        for (const c of chunk) { const reason = redisReadFailed ? 'unavailable' : 'batch_byte_budget';
          outcomes.set(c.bound.userId, reason); stage('lookup', reason); }
        continue;
      }
      const started = performance.now();
      const reply = await redis.evalLua(READ, chunk.map(c => c.key), [MAX_BYTES, remainingBytes], { genericError: true });
      let readBytes = 0;
      for (let n = 0; n < chunk.length; n++) {
        const c = chunk[n];
        const item = reply.ok && Array.isArray(reply.result?.[n]) ? reply.result[n] : null;
        let reason = item?.[0] || 'unavailable';
        if (!reply.ok || !item) redisReadFailed = true;
        if (reason === 'accepted') {
          const raw = item[2];
          const bytes = typeof raw === 'string' ? Buffer.byteLength(raw) : 0;
          remainingBytes -= bytes; readBytes += bytes;
          const value = parse(raw, c.bound, c.proof, c.cutoff);
          if (!value) reason = 'malformed_payload';
          else if (value.rows.length > remainingRows) reason = 'batch_row_budget';
          else { remainingRows -= value.rows.length; hits.set(c.bound.userId, value); }
          telemetryContext?.recordRedisOutcome?.(reason === 'accepted' ? 'hit' : 'miss', reason === 'accepted' ? undefined : reason);
          if (reason === 'accepted') telemetryContext?.recordRedisRows?.(value?.rows?.length || 0);
        }
        if (!['unavailable','absent_unknown','oversized','batch_byte_budget','malformed_payload','batch_row_budget','accepted'].includes(reason)) reason = 'unavailable';
        outcomes.set(c.bound.userId, reason); stage('lookup', reason);
      }
      io('redis_read', { operations: 1, bytes: readBytes, elapsedMs: performance.now() - started });
    }
    checkMemory();
    const loaded = await load(batch.map(bound => hits.has(bound.userId)
      ? { ...bound, rangeStart: new Date(hits.get(bound.userId).cutoff) } : bound));
    const after = candidates.length && (!redisReadFailed || hits.size) ? await proofs(batch) : new Map();
    const rejectedBounds = batch.filter(bound => {
      const hit = hits.get(bound.userId);
      const timeline = loaded.get(bound.userId);
      return hit && (timeline?.isPaged || !equal(before.get(bound.userId)?.proof, after.get(bound.userId)?.proof) ||
        (timeline?.length || 0) + hit.rows.length > maxRetainedSampleRowsPerUser);
    });
    const rejectedUsers = new Set(rejectedBounds.map(bound => bound.userId));
    for (const bound of rejectedBounds) {
      const reason = loaded.get(bound.userId)?.isPaged ? 'paged_tail'
        : !equal(before.get(bound.userId)?.proof, after.get(bound.userId)?.proof) ? 'proof_changed' : 'merged_row_cap';
      outcomes.set(bound.userId, reason); stage('post', reason);
      io('recent', { rows: loaded.get(bound.userId)?.length || 0 });
      loaded.get(bound.userId)?.dispose?.();
      loaded.delete(bound.userId); hits.delete(bound.userId); count('proofRaces');
    }
    // An overlapping sync burst invalidates users together; preserve the
    // canonical batch read instead of introducing one fallback SELECT per user.
    if (rejectedBounds.length) for (const [id, timeline] of await load(rejectedBounds)) loaded.set(id, timeline);
    for (const bound of batch) {
      let timeline = loaded.get(bound.userId) || new Timeline();
      const hit = hits.get(bound.userId);
      stage('raw', outcomes.get(bound.userId));
      terminalUsers.add(bound.userId);
      reasonRows('raw', outcomes.get(bound.userId), timeline.length);
      const coverage = candidates.find(candidate => candidate.bound.userId === bound.userId)?.coverageReason;
      if (!hit && coverage) reasonRows('coverage', coverage, timeline.length);
      io(hit ? 'recent' : 'full', { rows: timeline.length });
      if (hit) {
        count('hits'); count('rowsReused', hit.rows.length); count('recentRowsRead', timeline.length);
        telemetryContext?.recordRecentTailRows?.(timeline.length);
        const rows = hit.rows.map(([start, end, steps]) => ({ start, end, steps }));
        timeline.forEach((start, end, steps) => rows.push({ start, end, steps }));
        rows.sort((a, b) => a.start - b.start);
        const merged = new Timeline(); merged.append(rows); timeline = merged;
      } else { count('misses'); count('fullRowsRead', timeline.length); }
      result.set(bound.userId, timeline);
      checkMemory();
    }
    // Publication reasons have their own precedence and are never raw outcomes.
    for (const bound of batch) {
      if (!before.get(bound.userId)?.proof) stage('publication', 'no_proof');
    }
    for (const c of candidates) {
      if (hits.has(c.bound.userId)) continue;
      if (redisReadFailed) { stage('publication', 'unavailable_failure'); continue; }
      if (rejectedUsers.has(c.bound.userId) || !equal(c.proof, after.get(c.bound.userId)?.proof)) {
        stage('publication', 'changed_proof'); continue;
      }
      const timeline = result.get(c.bound.userId);
      if (!timeline || timeline.isPaged) { stage('publication', 'paged_source'); continue; }
      if (timeline.length > MAX_ROWS) { stage('publication', 'total_timeline_cap_legacy'); reasonRows('publication', 'total_timeline_cap_legacy', timeline.length); continue; }
      const rows = [];
      timeline.forEach((start, end, steps) => { if (end <= c.cutoff) rows.push([start, end, steps]); });
      if (rows.length > MAX_ROWS) { stage('publication', 'historical_row_cap'); continue; }
      const value = { version: 1, userId: c.bound.userId, revision: c.proof.revision, start: +c.bound.rangeStart, cutoff: c.cutoff, rows };
      const payload = JSON.stringify(value);
      try { checkMemory(); } catch (error) { stage('publication', 'memory_guard'); throw error; }
      const bytes = Buffer.byteLength(payload);
      if (bytes > MAX_BYTES) { stage('publication', 'encoded_byte_cap'); continue; }
      if (!validate(value, c.bound, c.proof, c.cutoff)) { stage('publication', 'no_proof'); continue; }
      const started = performance.now();
      const reply = await redis.evalLua("return redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[2])", [c.key], [payload, TTL_MS], { genericError: true });
      io('redis_write', { operations: 1, bytes, elapsedMs: performance.now() - started });
      stage('publication', reply.ok ? 'success' : 'unavailable_failure');
    }

    } catch (error) {
      const reason = /process memory guard/.test(error.message) ? 'memory_guard' : 'source_failure';
      for (const bound of batch) if (!terminalUsers.has(bound.userId)) stage('raw', reason);
      throw error;
    }
  }
  return result;
}
module.exports = { loadHistoricalRawSamples, captureInitialProofRead };
