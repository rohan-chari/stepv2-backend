const MAX_SAMPLES = 2048;

const RANGE_REASONS = [
  'seven_day_reuse_horizon', 'utc_rounding', 'multiple_races',
  'participant_join_time', 'effect_closed_step_window', 'timezone_fallback',
  'recent_mutable_tail', 'other',
];
const REDIS_ELIGIBILITY = [
  'eligible', 'recent_mutable_range', 'no_historical_proof', 'cache_disabled_or_budget', 'other',
];
const REDIS_MISS_REASONS = ['absent', 'invalid', 'oversized', 'unavailable', 'batch_budget', 'other'];

function bucketDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 3600000) return 'lt_1h';
  if (value < 86400000) return '1_24h';
  if (value < 3 * 86400000) return '1_3d';
  if (value < 7 * 86400000) return '3_7d';
  if (value < 14 * 86400000) return '7_14d';
  return '14d_plus';
}

function emptyState() {
  return {
    sourceLoads: 0, futureCoverageDays: null, sourceRowsReturned: 0, rowsConsumed: 0,
    rowsOutsideScoringWindows: 0, postgresRows: 0, postgresFullRows: 0,
    postgresRecentTailRows: 0, redisHistoricalRows: 0,
    processCacheHits: 0, processCacheMisses: 0,
    redisHistoricalHits: 0, redisHistoricalMisses: 0,
    eligibleHistoricalLookups: 0, ineligibleHistoricalLookups: 0,
    rangeExpansionMs: { seven_day_reuse_horizon: 0, utc_rounding: 0,
      multiple_races: 0, participant_join_time: 0,
      effect_closed_step_window: 0, timezone_fallback: 0,
      recent_mutable_tail: 0, other: 0 },
    reasonCounts: Object.fromEntries(RANGE_REASONS.map(reason => [reason, 0])),
    requestedDurationMs: [], requiredDurationMs: [],
    requestedRangeStartMs: null, requestedRangeEndMs: null,
    requiredRangeStartMs: null, requiredRangeEndMs: null,
    batchUsers: [], batchRaces: [], perRaceRequiredDurationsMs: [],
    redisEligibility: Object.fromEntries(REDIS_ELIGIBILITY.map(reason => [reason, 0])),
    redisMissReasons: Object.fromEntries(REDIS_MISS_REASONS.map(reason => [reason, 0])),
    unknownConsumption: 0, processCacheRows: 0, lookupDurationMs: [],
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function addSample(values, value) {
  if (values.length < MAX_SAMPLES) values.push(Math.max(0, Number(value) || 0));
}

function createContext(telemetry, { bounds = [], races = [], futureCoverageDays = null } = {}) {
  const requestedByUser = new Map(bounds.map(bound => [bound.userId, bound]));
  const windowsByUser = new Map();
  const consumedByUser = new Map();
  const timelinesByUser = new Map();
  const context = {
    recordSourceLoad(loadedBounds, requestedBounds = loadedBounds) {
      const starts = requestedBounds.map(bound => new Date(bound.rangeStart).getTime()).filter(Number.isFinite);
      const ends = requestedBounds.map(bound => new Date(bound.rangeEnd).getTime()).filter(Number.isFinite);
      return telemetry.sourceLoad({ bounds: requestedBounds, races,
        futureCoverageDays, requestedStartMs: Math.min(...starts), requestedEndMs: Math.max(...ends) });
    },
    recordProcessCache(outcome, rows = 0) { telemetry.processCache(outcome, rows); },
    recordSourceLoadDuration(token, durationMs) { telemetry.sourceLoadDuration(token, durationMs); },
    recordRedisEligibility(outcome) { telemetry.redisEligibility(outcome); },
    recordRedisOutcome(outcome, reason) { telemetry.redisHistorical(outcome, reason); },
    recordRedisRows(count) { telemetry.redisRows(count); },
    recordPostgresRows({ bounds: loadedBounds, rows, recent = false, full = false }) {
      telemetry.postgresRows(loadedBounds, rows, { recent, full });
    },
    recordPostgresTimelines(timelines, { full = false } = {}) {
      telemetry.postgresTimelineRows(timelines, { full });
    },
    recordRecentTailRows(count) { telemetry.recentTailRows(count); },
    recordTimeline(userId, timeline) { timelinesByUser.set(userId, timeline); },
    recordWindow(userId, start, end, reason = 'other') {
      const startMs = new Date(start).getTime();
      const endMs = new Date(end).getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;
      const windows = windowsByUser.get(userId) || [];
      windows.push({ startMs, endMs, reason });
      windowsByUser.set(userId, windows);
    },
    recordConsumed(userId, key) {
      let keys = consumedByUser.get(userId);
      if (!keys) { keys = new Set(); consumedByUser.set(userId, keys); }
      keys.add(String(key));
    },
    finish() { telemetry.finishContext({ context, bounds, races, requestedByUser, windowsByUser, consumedByUser, timelinesByUser }); },
  };
  return context;
}

function createStepHistoryRangeTelemetry({ logger = console } = {}) {
  let state = emptyState();
  let timer = null;

  function ensureTimer() {
    if (timer) return;
    const write = logger.info || logger.log;
    timer = setInterval(() => write?.call(logger, JSON.stringify({
      event: 'race_step_history_range_telemetry', schemaVersion: 1,
      intervalMs: 60000, ...snapshot(),
    })), 60000);
    timer.unref?.();
  }
  function addRangeReason(reason, expansionMs) {
    const key = RANGE_REASONS.includes(reason) ? reason : 'other';
    state.reasonCounts[key] += 1;
    state.rangeExpansionMs[key] += Math.max(0, Number(expansionMs) || 0);
  }
  function sourceLoad({ bounds = [], races = [], futureCoverageDays = null, requestedStartMs, requestedEndMs }) {
    ensureTimer();
    state.sourceLoads += 1;
    if (state.futureCoverageDays == null && Number.isFinite(Number(futureCoverageDays))) {
      state.futureCoverageDays = Number(futureCoverageDays);
    }
    state.batchUsers.push(Math.min(25, bounds.length));
    state.batchRaces.push(Math.min(64, races.length));
    const start = Number(requestedStartMs), end = Number(requestedEndMs);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      addSample(state.requestedDurationMs, end - start);
      state.requestedRangeStartMs = state.requestedRangeStartMs == null ? start : Math.min(state.requestedRangeStartMs, start);
      state.requestedRangeEndMs = state.requestedRangeEndMs == null ? end : Math.max(state.requestedRangeEndMs, end);
    }
    return state.sourceLoads - 1;
  }
  function sourceLoadDuration(token, durationMs) {
    if (Number.isInteger(token) && token >= 0) addSample(state.lookupDurationMs, durationMs);
  }
  function snapshot() {
    const requested = state.sourceRowsReturned + state.redisHistoricalRows + state.processCacheRows;
    return {
      sourceLoads: state.sourceLoads,
      futureCoverageDays: state.futureCoverageDays,
      rows: { returned: requested, consumed: state.rowsConsumed, outsideScoringWindows: state.rowsOutsideScoringWindows, postgres: state.postgresRows, postgresFull: state.postgresFullRows, postgresRecentTail: state.postgresRecentTailRows, redisHistorical: state.redisHistoricalRows, processCache: state.processCacheRows },
      overReadPercent: requested ? (Math.max(0, requested - state.rowsConsumed) / requested) * 100 : null,
      requestedRange: { startMinMs: state.requestedRangeStartMs, endMaxMs: state.requestedRangeEndMs, durationMs: summarize(state.requestedDurationMs) },
      requiredRange: { startMinMs: state.requiredRangeStartMs, endMaxMs: state.requiredRangeEndMs, durationMs: summarize(state.requiredDurationMs) },
      lookupDurationMs: summarize(state.lookupDurationMs),
      batchUsers: summarize(state.batchUsers), batchRaces: summarize(state.batchRaces),
      perRaceRequiredDurationMs: summarize(state.perRaceRequiredDurationsMs),
      rangeExpansionMs: { ...state.rangeExpansionMs }, reasonCounts: { ...state.reasonCounts },
      processCache: { hits: state.processCacheHits, misses: state.processCacheMisses },
      redisHistoricalCache: { hits: state.redisHistoricalHits, misses: state.redisHistoricalMisses, eligibility: { ...state.redisEligibility }, missReasons: { ...state.redisMissReasons } },
      unknownConsumption: state.unknownConsumption,
    };
  }
  return {
    createContext(boundsAndRaces) {
      const context = createContext(this, boundsAndRaces);
      return context;
    },
    sourceLoad,
    processCache(outcome, rows = 0) {
      if (outcome === 'hit') state.processCacheHits += 1;
      else state.processCacheMisses += 1;
      if (outcome === 'hit') state.processCacheRows += Math.max(0, Number(rows) || 0);
    },
    sourceLoadDuration,
    redisEligibility(outcome) {
      const key = REDIS_ELIGIBILITY.includes(outcome) ? outcome : 'other';
      if (key === 'eligible') state.eligibleHistoricalLookups += 1;
      else state.ineligibleHistoricalLookups += 1;
      state.redisEligibility[key] += 1;
    },
    redisHistorical(outcome, reason = 'other') {
      if (outcome === 'hit') state.redisHistoricalHits += 1;
      else {
        state.redisHistoricalMisses += 1;
        const key = REDIS_MISS_REASONS.includes(reason) ? reason : 'other';
        state.redisMissReasons[key] += 1;
      }
    },
    postgresRows(bounds = [], rows = [], { recent = false, full = false } = {}) {
      const count = Array.isArray(rows) ? rows.length : Number(rows) || 0;
      state.postgresRows += count;
      state.sourceRowsReturned += count;
      if (recent) state.postgresRecentTailRows += count;
      if (full) state.postgresFullRows += count;
    },
    postgresTimelineRows(timelines = new Map(), { full = false } = {}) {
      let count = 0;
      for (const timeline of timelines.values()) count += Math.max(0, Number(timeline?.length) || 0);
      state.postgresRows += count;
      state.sourceRowsReturned += count;
      if (full) state.postgresFullRows += count;
    },
    recentTailRows(count) {
      const value = Math.max(0, Number(count) || 0);
      state.postgresRecentTailRows += value;
    },
    redisRows(count) { state.redisHistoricalRows += Math.max(0, Number(count) || 0); },
    finishContext({ context, bounds, races, requestedByUser, windowsByUser, consumedByUser, timelinesByUser }) {
      for (const windows of windowsByUser.values()) {
        const start = Math.min(...windows.map(window => window.startMs));
        const end = Math.max(...windows.map(window => window.endMs));
        addSample(state.requiredDurationMs, end - start);
        state.requiredRangeStartMs = state.requiredRangeStartMs == null ? start : Math.min(state.requiredRangeStartMs, start);
        state.requiredRangeEndMs = state.requiredRangeEndMs == null ? end : Math.max(state.requiredRangeEndMs, end);
        for (const window of windows) addRangeReason(window.reason, 0);
      }
      for (const race of races) {
        const start = new Date(race.startedAt).getTime();
        const end = new Date(race.endsAt || race.startedAt).getTime();
        if (Number.isFinite(start) && Number.isFinite(end)) addSample(state.perRaceRequiredDurationsMs, Math.max(0, end - start));
      }
      for (const [userId, timeline] of timelinesByUser) {
        const windows = windowsByUser.get(userId) || [];
        let consumedKeys = consumedByUser.get(userId);
        if (!consumedKeys) { consumedKeys = new Set(); consumedByUser.set(userId, consumedKeys); }
        if (typeof timeline?.forEach === 'function') {
          let rowIndex = 0;
          timeline.forEach((start, end, steps, key) => {
            if (windows.some(window => end > window.startMs && start < window.endMs)) {
              consumedKeys.add(String(key ?? rowIndex));
            }
            rowIndex += 1;
          });
        }
        const consumed = consumedKeys.size;
        state.rowsConsumed += consumed;
        const total = Number(timeline?.length);
        if (Number.isFinite(total)) state.rowsOutsideScoringWindows += Math.max(0, total - consumed);
        else state.unknownConsumption += 1;
      }
      for (const bound of bounds) {
        const windows = windowsByUser.get(bound.userId) || [];
        const requested = requestedByUser.get(bound.userId);
        if (!requested || !windows.length) continue;
        const requiredStart = Math.min(...windows.map(window => window.startMs));
        const requiredEnd = Math.max(...windows.map(window => window.endMs));
        const requestedStart = new Date(requested.rangeStart).getTime();
        const requestedEnd = new Date(requested.rangeEnd).getTime();
        if (requestedStart < requiredStart) addRangeReason('utc_rounding', requiredStart - requestedStart);
        if (requestedEnd > requiredEnd) addRangeReason('seven_day_reuse_horizon', requestedEnd - requiredEnd);
        if (races.length > 1) addRangeReason('multiple_races', Math.max(0, requestedEnd - requestedStart - (requiredEnd - requiredStart)));
        if (requestedStart > requiredStart) addRangeReason('participant_join_time', requestedStart - requiredStart);
      }
    },
    reset() { state = emptyState(); },
    snapshot,
  };
}

function summarize(values) {
  return { count: values.length, median: percentile(values, 0.5), p95: percentile(values, 0.95), total: values.reduce((sum, value) => sum + value, 0) };
}

const stepHistoryRangeTelemetry = createStepHistoryRangeTelemetry();

module.exports = { createStepHistoryRangeTelemetry, stepHistoryRangeTelemetry, bucketDuration };
