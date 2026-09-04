const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_USERS = 2_000;
const DEFAULT_MAX_ROWS = 100_000;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function utcDateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function sampleKey(row) {
  return row.rowId || [row.userId, new Date(row.periodStart).toISOString(),
    new Date(row.periodEnd).toISOString(), row.steps].join(":");
}

function dailyKey(row) {
  return row.rowId || `${row.userId}:${utcDateKey(row.date)}`;
}

function mergeRows(left, right, keyFor) {
  const rows = new Map();
  for (const row of [...(left || []), ...(right || [])]) rows.set(keyFor(row), row);
  return [...rows.values()];
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter(([start, end]) => start < end)
    .sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || interval[0] > previous[1]) {
      merged.push([...interval]);
    } else {
      previous[1] = Math.max(previous[1], interval[1]);
    }
  }
  return merged;
}

function uncoveredIntervals(start, end, covered) {
  const gaps = [];
  let cursor = start;
  for (const [coveredStart, coveredEnd] of mergeIntervals(covered || [])) {
    if (coveredEnd <= cursor) continue;
    if (coveredStart >= end) break;
    if (coveredStart > cursor) gaps.push([cursor, Math.min(coveredStart, end)]);
    cursor = Math.max(cursor, coveredEnd);
    if (cursor >= end) break;
  }
  if (cursor < end) gaps.push([cursor, end]);
  return gaps;
}

function dateKeyToDay(value) {
  return Math.floor(new Date(`${value}T00:00:00.000Z`).getTime() / DAY_MS);
}

function dayToDateKey(value) {
  return utcDateKey(value * DAY_MS);
}

function compareGenerations(left, right) {
  if (String(left) === String(right)) return 0;
  try {
    return BigInt(left) < BigInt(right) ? -1 : 1;
  } catch (_error) {
    return null;
  }
}

function materialize(entry, request) {
  return {
    samples: entry.samples.filter((row) =>
      new Date(row.periodEnd).getTime() > request.sampleStartMs &&
      new Date(row.periodStart).getTime() < request.sampleEndMs)
      .sort((left, right) => left.userId.localeCompare(right.userId) ||
        new Date(left.periodStart) - new Date(right.periodStart) ||
        String(left.rowId).localeCompare(String(right.rowId)))
      .map(({ rowId: _rowId, ...row }) => row),
    dailySteps: entry.dailySteps.filter((row) => {
      const date = utcDateKey(row.date);
      return date >= request.dailyStart && date <= request.dailyEnd;
    }).sort((left, right) => left.userId.localeCompare(right.userId) ||
      new Date(left.date) - new Date(right.date) ||
      String(left.rowId).localeCompare(String(right.rowId)))
      .map(({ rowId: _rowId, ...row }) => row),
  };
}

function createGlobalEventCaptureFactCache({
  maxUsers = DEFAULT_MAX_USERS,
  maxRows = DEFAULT_MAX_ROWS,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
} = {}) {
  const entries = new Map();
  const pending = new Map();
  let retainedRows = 0;

  function remove(userId) {
    const entry = entries.get(userId);
    if (!entry) return;
    entries.delete(userId);
    retainedRows -= entry.samples.length + entry.dailySteps.length;
  }

  function validEntry(request) {
    const entry = entries.get(request.userId);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      remove(request.userId);
      return null;
    }
    const generationOrder = compareGenerations(entry.generation, request.generation);
    if (generationOrder !== 0) {
      if (generationOrder === -1 || generationOrder === null) remove(request.userId);
      return null;
    }
    entries.delete(request.userId);
    entries.set(request.userId, entry);
    return entry;
  }

  function boundsFor(entry, request) {
    const sampleGaps = uncoveredIntervals(
      request.sampleStartMs,
      request.sampleEndMs,
      entry?.sampleIntervals,
    );
    const dailyStartDay = dateKeyToDay(request.dailyStart);
    const dailyEndExclusive = dateKeyToDay(request.dailyEnd) + 1;
    const dailyGaps = uncoveredIntervals(
      dailyStartDay,
      dailyEndExclusive,
      entry?.dailyIntervals,
    );
    return Array.from({ length: Math.max(sampleGaps.length, dailyGaps.length) }, (_, index) => {
      const sample = sampleGaps[index];
      const daily = dailyGaps[index];
      return {
        userId: request.userId,
        sampleStart: sample ? new Date(sample[0]) : null,
        sampleEnd: sample ? new Date(sample[1]) : null,
        dailyStart: daily ? dayToDateKey(daily[0]) : null,
        dailyEnd: daily ? dayToDateKey(daily[1] - 1) : null,
      };
    });
  }

  function inspect(request) {
    const entry = validEntry(request);
    const bounds = boundsFor(entry, request);
    if (entry && bounds.length === 0) {
      return { outcome: "hit", facts: materialize(entry, request) };
    }
    const pendingKey = `${request.userId}:${request.generation}`;
    const existingFill = pending.get(pendingKey);
    if (existingFill) return { outcome: "wait", wait: existingFill.promise };

    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    const fill = { promise, settle };
    pending.set(pendingKey, fill);
    const temporary = (loaded) => ({
      userId: request.userId,
      generation: String(request.generation),
      sampleIntervals: mergeIntervals([
        ...(entry?.sampleIntervals || []),
        [request.sampleStartMs, request.sampleEndMs],
      ]),
      dailyIntervals: mergeIntervals([
        ...(entry?.dailyIntervals || []),
        [dateKeyToDay(request.dailyStart), dateKeyToDay(request.dailyEnd) + 1],
      ]),
      samples: mergeRows(entry?.samples, loaded.samples, sampleKey),
      dailySteps: mergeRows(entry?.dailySteps, loaded.dailySteps, dailyKey),
      expiresAt: now() + ttlMs,
    });
    return {
      outcome: "miss",
      bounds,
      facts(loaded) { return materialize(temporary(loaded), request); },
      commit(loaded) {
        const next = temporary(loaded);
        const current = entries.get(request.userId);
        const generationOrder = current
          ? compareGenerations(current.generation, next.generation)
          : null;
        if (!current || generationOrder === 0 || generationOrder === -1) {
          remove(request.userId);
          const nextRows = next.samples.length + next.dailySteps.length;
          if (nextRows <= maxRows) {
            entries.set(request.userId, next);
            retainedRows += nextRows;
            while (entries.size > maxUsers || retainedRows > maxRows) {
              remove(entries.keys().next().value);
            }
          }
        }
        if (pending.get(pendingKey) === fill) pending.delete(pendingKey);
        settle(true);
      },
      rollback() {
        if (pending.get(pendingKey) === fill) pending.delete(pendingKey);
        settle(false);
      },
    };
  }

  return {
    inspect,
    clear() {
      entries.clear();
      retainedRows = 0;
      for (const fill of pending.values()) fill.settle(false);
      pending.clear();
    },
  };
}

const processGlobalEventCaptureFactCache = createGlobalEventCaptureFactCache();

module.exports = {
  createGlobalEventCaptureFactCache,
  processGlobalEventCaptureFactCache,
};
