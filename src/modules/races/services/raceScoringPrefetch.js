const { SETTLEMENT_EFFECT_TYPES } = require("./raceScoringEffectTypes");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  coordinatedOptimizationMetrics: defaultMetrics,
} = require("../../../shared/observability/coordinatedOptimizationMetrics");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_USERS_PER_CHUNK = 25;
const MAX_SAMPLE_ROWS_PER_CHUNK = 50_000;
const MAX_RETAINED_SAMPLE_ROWS_PER_USER = 50_000;
const MAX_HEAP_GROWTH_BYTES = 32 * 1024 * 1024;
const SCORING_INPUT_CACHE_MAX_USERS = 2_000;
const SCORING_INPUT_CACHE_MAX_SAMPLE_ROWS = 2_000_000;
const SCORING_INPUT_CACHE_TTL_MS = 10 * 60 * 1000;
const PREFETCH_EFFECT_TYPES = [...SETTLEMENT_EFFECT_TYPES, "HITCHHIKE"];

function createScoringInputCache({
  maxUsers = SCORING_INPUT_CACHE_MAX_USERS,
  maxSampleRows = SCORING_INPUT_CACHE_MAX_SAMPLE_ROWS,
  ttlMs = SCORING_INPUT_CACHE_TTL_MS,
  now = Date.now,
  metrics = null,
} = {}) {
  const entries = new Map();
  let retainedSampleRows = 0;
  function remove(key) {
    const entry = entries.get(key);
    if (!entry) return;
    retainedSampleRows -= entry.sampleRows;
    entries.delete(key);
  }
  function evict() {
    while (entries.size > maxUsers || retainedSampleRows > maxSampleRows) {
      remove(entries.keys().next().value);
      metrics?.increment("race_scoring_input_cache_total", { outcome: "eviction" });
    }
  }
  function observeSize() {
    metrics?.observe("race_scoring_input_cache_users", entries.size);
    metrics?.observe("race_scoring_input_cache_sample_rows", retainedSampleRows);
  }
  return {
    get({ userId, generation, sampleStartMs, sampleEndMs, dailyStartMs, dailyEndMs }) {
      const entry = entries.get(userId);
      if (!entry) {
        metrics?.increment("race_scoring_input_cache_total", { outcome: "miss_absent" });
        return null;
      }
      if (entry.expiresAt <= now() || entry.generation !== String(generation) ||
          entry.sampleStartMs > sampleStartMs || entry.sampleEndMs < sampleEndMs ||
          entry.dailyStartMs > dailyStartMs || entry.dailyEndMs < dailyEndMs) {
        remove(userId);
        metrics?.increment("race_scoring_input_cache_total", { outcome: "miss_invalid" });
        observeSize();
        return null;
      }
      entries.delete(userId);
      entries.set(userId, entry);
      metrics?.increment("race_scoring_input_cache_total", { outcome: "hit" });
      return entry;
    },
    set({ userId, generation, sampleStartMs, sampleEndMs, dailyStartMs, dailyEndMs,
      timeline, dailyRows }) {
      if (!userId || generation == null || timeline?.isPaged) return false;
      const sampleRows = Number(timeline?.length) || 0;
      if (sampleRows > maxSampleRows) return false;
      remove(userId);
      const entry = {
        generation: String(generation), sampleStartMs, sampleEndMs,
        dailyStartMs, dailyEndMs, timeline, dailyRows: [...(dailyRows || [])],
        sampleRows, expiresAt: now() + ttlMs,
      };
      entries.set(userId, entry);
      retainedSampleRows += sampleRows;
      evict();
      const retained = entries.get(userId) === entry;
      if (retained) metrics?.increment("race_scoring_input_cache_total", { outcome: "store" });
      observeSize();
      return retained;
    },
    clear() { entries.clear(); retainedSampleRows = 0; observeSize(); },
    snapshot() { return { users: entries.size, sampleRows: retainedSampleRows }; },
  };
}

const processScoringInputCache = createScoringInputCache({ metrics: defaultMetrics });

class CompactSampleTimeline {
  constructor() {
    this.segments = [];
    this.length = 0;
  }

  append(rows) {
    if (!rows.length) return;
    const baseMs = new Date(rows[0].start ?? rows[0].periodStart).getTime();
    // Millisecond offsets exceed Int32 after 24.85 days. Float64 preserves
    // exact integer milliseconds for every supported race duration while the
    // step values remain compact Int32 data.
    const starts = new Float64Array(rows.length);
    const ends = new Float64Array(rows.length);
    const steps = new Int32Array(rows.length);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const startOffset = new Date(row.start ?? row.periodStart).getTime() - baseMs;
      const endOffset = new Date(row.end ?? row.periodEnd).getTime() - baseMs;
      starts[index] = startOffset;
      ends[index] = endOffset;
      steps[index] = Number(row.steps) || 0;
    }
    this.segments.push({ baseMs, starts, ends, steps });
    this.length += rows.length;
  }

  appendTimeline(other) {
    this.segments.push(...other.segments);
    this.length += other.length;
  }

  forEach(callback) {
    for (const segment of this.segments) {
      for (let index = 0; index < segment.steps.length; index += 1) {
        callback(
          segment.baseMs + segment.starts[index],
          segment.baseMs + segment.ends[index],
          segment.steps[index],
        );
      }
    }
  }

  sum(windowStartMs, windowEndMs, closedAtMs = null) {
    let total = 0;
    this.forEach((sampleStart, sampleEnd, sampleSteps) => {
      if (closedAtMs != null && sampleEnd > closedAtMs) return;
      const duration = sampleEnd - sampleStart;
      if (duration <= 0) return;
      const overlap = Math.min(sampleEnd, windowEndMs) -
        Math.max(sampleStart, windowStartMs);
      if (overlap <= 0) return;
      total += overlap >= duration
        ? sampleSteps
        : Math.round(sampleSteps * (overlap / duration));
    });
    return total;
  }

  hasAny(windowStartMs, windowEndMs) {
    let found = false;
    this.forEach((sampleStart, sampleEnd) => {
      if (sampleEnd > windowStartMs && sampleStart < windowEndMs) found = true;
    });
    return found;
  }

  view(windowStartMs, windowEndMs) {
    const timeline = this;
    let count = 0;
    this.forEach((sampleStart, sampleEnd) => {
      if (sampleEnd > windowStartMs && sampleStart < windowEndMs) count += 1;
    });
    return {
      length: count,
      *[Symbol.iterator]() {
        for (const segment of timeline.segments) {
          for (let index = 0; index < segment.steps.length; index += 1) {
            const sampleStart = segment.baseMs + segment.starts[index];
            const sampleEnd = segment.baseMs + segment.ends[index];
            if (sampleEnd <= windowStartMs || sampleStart >= windowEndMs) continue;
            yield {
              periodStart: new Date(sampleStart),
              periodEnd: new Date(sampleEnd),
              steps: segment.steps[index],
            };
          }
        }
      },
    };
  }
}

// Exceptional histories must not be replayed from PostgreSQL for each scoring
// phase, and they must not remain resident in V8. Consume the ordered database
// cursor exactly once into a private binary spool (three Float64 values per
// sample). Canonical base/effect/finish consumers then replay that exact stream
// from local disk. This is deliberately not a durable artifact: it is
// generation-local scratch data, unlinked by releaseUsers, and authoritative
// writes remain behind the existing generation fence.
class PagedSampleTimeline {
  constructor({
    bound,
    pageSize,
    loadPage,
    initialTimeline = null,
    initialRows = [],
    cursor = null,
    onPage = null,
    memoryUsage = process.memoryUsage,
    maxHeapGrowthBytes = MAX_HEAP_GROWTH_BYTES,
    createScratchDirectory = () => fs.mkdtempSync(
      path.join(os.tmpdir(), "bara-race-scoring-"),
    ),
  }) {
    this.bound = bound;
    this.pageSize = pageSize;
    this.loadPage = loadPage;
    this.initialTimeline = initialTimeline;
    this.initialRows = initialRows;
    this.cursor = cursor;
    this.onPage = onPage;
    this.memoryUsage = memoryUsage;
    this.maxHeapGrowthBytes = maxHeapGrowthBytes;
    this.createScratchDirectory = createScratchDirectory;
    this.length = 0;
    this.isPaged = true;
    this.operationTail = Promise.resolve();
    this.preparation = null;
    this.directory = null;
    this.filePath = null;
  }

  async runExclusive(operation) {
    const previous = this.operationTail;
    let release;
    this.operationTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  async prepare() {
    if (!this.preparation) this.preparation = this.prepareOnce();
    return this.preparation;
  }

  async prepareOnce() {
    const preparationStartMemory = scoringMemorySnapshot(this.memoryUsage);
    const assertWithinMemoryGuard = () => {
      const current = scoringMemorySnapshot(this.memoryUsage);
      if (
        Math.max(0, current.total - preparationStartMemory.total) >
          this.maxHeapGrowthBytes ||
        Math.max(0, current.arrayBuffers - preparationStartMemory.arrayBuffers) >
          this.maxHeapGrowthBytes
      ) {
        throw new Error("worker scoring input exceeded the 32 MiB process memory guard");
      }
    };
    this.directory = this.createScratchDirectory();
    this.filePath = path.join(this.directory, "samples.bin");
    const handle = await fs.promises.open(this.filePath, "wx", 0o600);
    const writeRows = async (rows) => {
      if (!rows.length) return;
      const buffer = Buffer.allocUnsafe(rows.length * 24);
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const offset = index * 24;
        buffer.writeDoubleLE(new Date(row.start ?? row.periodStart).getTime(), offset);
        buffer.writeDoubleLE(new Date(row.end ?? row.periodEnd).getTime(), offset + 8);
        buffer.writeDoubleLE(Number(row.steps) || 0, offset + 16);
      }
      await handle.write(buffer);
      this.length += rows.length;
      assertWithinMemoryGuard();
    };
    try {
      if (this.initialTimeline) {
        const buffer = Buffer.allocUnsafe(this.initialTimeline.length * 24);
        let index = 0;
        this.initialTimeline.forEach((start, end, steps) => {
          const offset = index * 24;
          buffer.writeDoubleLE(start, offset);
          buffer.writeDoubleLE(end, offset + 8);
          buffer.writeDoubleLE(steps, offset + 16);
          index += 1;
        });
        await handle.write(buffer);
        this.length += index;
        assertWithinMemoryGuard();
        this.initialTimeline = null;
      }
      await writeRows(this.initialRows);
      let shouldContinue = this.initialRows.length === this.pageSize;
      this.initialRows = [];
      let cursor = this.cursor;
      while (shouldContinue) {
        const page = await this.loadPage([this.bound], {
          maxRows: this.pageSize,
          cursor,
        });
        this.onPage?.(page);
        await writeRows(page);
        shouldContinue = page.length === this.pageSize;
        if (!shouldContinue) {
          page.length = 0;
          break;
        }
        const last = page[page.length - 1];
        cursor = {
          ordinal: Number(last.ordinal),
          periodStart: last.start ?? last.periodStart,
          id: last.id,
        };
        page.length = 0;
      }
      this.initialTimeline = null;
      this.initialRows = [];
    } catch (error) {
      await handle.close().catch(() => {});
      this.dispose();
      throw error;
    }
    await handle.close();
  }

  async *lockedRows() {
    const previous = this.operationTail;
    let release;
    this.operationTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      for await (const row of this.rows()) yield row;
    } finally {
      release();
    }
  }

  async *rows() {
    await this.prepare();
    let remainder = Buffer.alloc(0);
    for await (const chunk of fs.createReadStream(this.filePath, { highWaterMark: 24 * 2048 })) {
      const bytes = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
      const completeBytes = bytes.length - (bytes.length % 24);
      for (let offset = 0; offset < completeBytes; offset += 24) {
        yield {
          periodStart: new Date(bytes.readDoubleLE(offset)),
          periodEnd: new Date(bytes.readDoubleLE(offset + 8)),
          steps: bytes.readDoubleLE(offset + 16),
        };
      }
      remainder = completeBytes === bytes.length
        ? Buffer.alloc(0)
        : bytes.subarray(completeBytes);
    }
    if (remainder.length) throw new Error("corrupt exceptional scoring spool");
  }

  dispose() {
    if (this.filePath) {
      try { fs.unlinkSync(this.filePath); } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (this.directory) {
      try { fs.rmdirSync(this.directory); } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    this.filePath = null;
    this.directory = null;
  }

  async sum(windowStartMs, windowEndMs, closedAtMs = null) {
    return (await this.sumMany([{ startMs: windowStartMs, endMs: windowEndMs }], closedAtMs))[0];
  }

  async sumMany(windows, closedAtMs = null) {
    return this.runExclusive(async () => {
      const totals = windows.map(() => 0);
      for await (const row of this.rows()) {
        const sampleStart = new Date(row.start ?? row.periodStart).getTime();
        const sampleEnd = new Date(row.end ?? row.periodEnd).getTime();
        if (closedAtMs != null && sampleEnd > closedAtMs) continue;
        const duration = sampleEnd - sampleStart;
        if (duration <= 0) continue;
        for (let index = 0; index < windows.length; index += 1) {
          const overlap = Math.min(sampleEnd, windows[index].endMs) -
            Math.max(sampleStart, windows[index].startMs);
          if (overlap <= 0) continue;
          totals[index] += overlap >= duration
            ? Number(row.steps) || 0
            : Math.round((Number(row.steps) || 0) * (overlap / duration));
        }
      }
      return totals;
    });
  }

  async hasAny(windowStartMs, windowEndMs) {
    return this.runExclusive(async () => {
      for await (const row of this.rows()) {
        const sampleStart = new Date(row.start ?? row.periodStart).getTime();
        const sampleEnd = new Date(row.end ?? row.periodEnd).getTime();
        if (sampleEnd > windowStartMs && sampleStart < windowEndMs) return true;
      }
      return false;
    });
  }

  view(windowStartMs, windowEndMs) {
    const timeline = this;
    return {
      length: null,
      async *[Symbol.asyncIterator]() {
        for await (const row of timeline.lockedRows()) {
          const sampleStart = new Date(row.start ?? row.periodStart).getTime();
          const sampleEnd = new Date(row.end ?? row.periodEnd).getTime();
          if (sampleEnd <= windowStartMs || sampleStart >= windowEndMs) continue;
          yield {
            periodStart: new Date(sampleStart), periodEnd: new Date(sampleEnd),
            steps: Number(row.steps) || 0,
          };
        }
      },
    };
  }
}

function appendSampleRows(timelines, rows) {
  let index = 0;
  while (index < rows.length) {
    const userId = rows[index].userId;
    let end = index + 1;
    while (end < rows.length && rows[end].userId === userId) end += 1;
    const timeline = timelines.get(userId) || new CompactSampleTimeline();
    timeline.append(rows.slice(index, end));
    timelines.set(userId, timeline);
    index = end;
  }
}

function mergeSampleTimelines(target, source) {
  for (const [userId, sourceTimeline] of source) {
    if (sourceTimeline?.isPaged) {
      target.set(userId, sourceTimeline);
      continue;
    }
    const timeline = target.get(userId) || new CompactSampleTimeline();
    timeline.appendTimeline(sourceTimeline);
    target.set(userId, timeline);
  }
}

function inCoveredRange(start, end, rangeStartMs, rangeEndMs) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  return startMs >= rangeStartMs && endMs <= rangeEndMs;
}

function scoringMemorySnapshot(memoryUsage) {
  const usage = memoryUsage() || {};
  const heapUsed = Math.max(0, Number(usage.heapUsed) || 0);
  const external = Math.max(0, Number(usage.external) || 0);
  const arrayBuffers = Math.max(0, Number(usage.arrayBuffers) || 0);
  return {
    heapUsed,
    external,
    arrayBuffers,
    // V8 reports ArrayBuffers as a subset of external. Use heap+external for
    // the guard and retain arrayBuffers independently as evidence.
    total: heapUsed + external,
  };
}

// Fetch the race-wide scoring inputs once, then expose the same model methods
// the canonical scoring helpers already use. This changes query round-trips,
// not scoring math: every sum still runs through prorateSamplesIntoWindow and
// every out-of-range request falls back to the real model.
async function prefetchRaceScoringModelsImpl({
  races,
  now,
  stepsModel,
  stepSampleModel,
  raceActiveEffectModel,
  powerupEventModel = null,
  scoringParticipantIds = null,
  strictWorkerMode = false,
  deferredSampleLoading = false,
  maxUsersPerChunk = MAX_USERS_PER_CHUNK,
  maxSampleRowsPerChunk = MAX_SAMPLE_ROWS_PER_CHUNK,
  maxRetainedSampleRowsPerUser = MAX_RETAINED_SAMPLE_ROWS_PER_USER,
  maxHeapGrowthBytes = MAX_HEAP_GROWTH_BYTES,
  memoryUsage = process.memoryUsage,
  metrics = defaultMetrics,
  ownedTransientTimelines,
  createScoringScratchDirectory,
  scoringInputCache = null,
  scoringInputVersionModel = null,
}) {
  const started = (races || []).filter((race) => race?.startedAt);
  if (started.length === 0) return null;
  if (
    typeof stepSampleModel?.findRowsForUsersInRange !== "function" &&
      typeof stepSampleModel?.findRowsForUserRanges !== "function" ||
    typeof stepsModel?.findByUserIdsAndDateRange !== "function" ||
    typeof raceActiveEffectModel?.findEffectsForRaceParticipantsByTypes !==
      "function"
  ) {
    if (strictWorkerMode) {
      throw new Error("bounded worker scoring input model is unavailable");
    }
    return null;
  }

  const currentTime = new Date(now);
  const earliestStartMs = Math.min(
    ...started.map((race) => new Date(race.startedAt).getTime())
  );
  const sampleRangeStart = new Date(earliestStartMs);
  // Round the future coverage boundary up so successive generations can reuse
  // the same immutable input-version entry instead of missing by milliseconds.
  const coverageCeilingMs = Math.ceil(currentTime.getTime() / DAY_MS) * DAY_MS;
  const sampleRangeEnd = new Date(coverageCeilingMs + 7 * DAY_MS);
  const dailyRangeStart = new Date(earliestStartMs - 3 * DAY_MS);
  const dailyRangeEnd = new Date(coverageCeilingMs + 3 * DAY_MS);
  const scoringIds = Array.isArray(scoringParticipantIds)
    ? new Set(scoringParticipantIds)
    : null;
  const scoringParticipants = started.flatMap((race) =>
    (race.participants || []).filter((participant) =>
      !scoringIds || scoringIds.has(participant.id)
    )
  );
  if (scoringIds && scoringParticipants.length !== scoringIds.size) return null;
  const userIds = [
    ...new Set(
      scoringParticipants.map((participant) => participant.userId)
    ),
  ];
  metrics.observe("race_resolution_participants", scoringParticipants.length);
  const powerupRaces = started.filter((race) => race.powerupsEnabled);
  const participantIds = powerupRaces.flatMap((race) =>
    (race.participants || [])
      .filter((participant) => !scoringIds || scoringIds.has(participant.id))
      .map((participant) => participant.id)
  );
  const raceIds = powerupRaces.map((race) => race.id);

  const participantByUserId = new Map(
    scoringParticipants.map((participant) => [participant.userId, participant])
  );
  const exactSampleBounds = userIds.map((userId, ordinal) => {
    const participant = participantByUserId.get(userId);
    const joinedAt = participant?.joinedAt
      ? new Date(participant.joinedAt)
      : sampleRangeStart;
    return {
      userId,
      rangeStart:
        joinedAt.getTime() > sampleRangeStart.getTime()
          ? joinedAt
          : sampleRangeStart,
      rangeEnd: sampleRangeEnd,
      ordinal,
    };
  });
  let versionsByUser = new Map();
  if (scoringInputCache && scoringInputVersionModel?.findMany) {
    const versions = await scoringInputVersionModel.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, generation: true },
    });
    versionsByUser = new Map((versions || []).map((row) => [
      row.userId, String(row.generation),
    ]));
  }
  const cachedByUser = new Map();
  for (const bound of exactSampleBounds) {
    const generation = versionsByUser.get(bound.userId);
    if (generation == null) continue;
    const cached = scoringInputCache?.get({
      userId: bound.userId, generation,
      sampleStartMs: bound.rangeStart.getTime(),
      sampleEndMs: sampleRangeEnd.getTime(),
      dailyStartMs: dailyRangeStart.getTime(),
      dailyEndMs: dailyRangeEnd.getTime(),
    });
    if (cached) cachedByUser.set(bound.userId, cached);
  }
  const samplesByUser = new Map(
    [...cachedByUser].map(([userId, entry]) => [userId, entry.timeline])
  );
  const preparedSampleUsers = new Set(cachedByUser.keys());
  const sampleBoundByUser = new Map(exactSampleBounds.map((bound) => [bound.userId, bound]));
  let dailyByUser = null;
  const cachePreparedUser = (userId) => {
    if (!dailyByUser || cachedByUser.has(userId)) return;
    const generation = versionsByUser.get(userId);
    const bound = sampleBoundByUser.get(userId);
    const timeline = samplesByUser.get(userId);
    if (generation == null || !bound || !timeline) return;
    const dailyRows = dailyByUser.get(userId) || [];
    if (scoringInputCache?.set({
      userId, generation,
      sampleStartMs: bound.rangeStart.getTime(),
      sampleEndMs: sampleRangeEnd.getTime(),
      dailyStartMs: dailyRangeStart.getTime(),
      dailyEndMs: dailyRangeEnd.getTime(),
      timeline, dailyRows,
    })) cachedByUser.set(userId, { timeline, dailyRows });
  };
  const loadSampleBounds = async (requestedBounds) => {
    if (typeof stepSampleModel.findRowsForUserRanges !== "function") {
      if (strictWorkerMode) {
        throw new Error("bounded worker scoring input model is unavailable");
      }
      const legacyRows = await stepSampleModel.findRowsForUsersInRange(
        requestedBounds.map((bound) => bound.userId),
        sampleRangeStart,
        sampleRangeEnd
      );
      const timelines = new Map();
      appendSampleRows(timelines, legacyRows || []);
      for (const bound of requestedBounds) preparedSampleUsers.add(bound.userId);
      return timelines;
    }
    const loadBounds = async (bounds, pageSize) => {
      const loaded = new Map();
      let cursor = null;
      let loadStartMemory = null;
      let loadedRows = 0;
      for (;;) {
        const memoryBefore = scoringMemorySnapshot(memoryUsage);
        loadStartMemory ||= memoryBefore;
        const chunkRows = await stepSampleModel.findRowsForUserRanges(bounds, {
          maxRows: pageSize,
          cursor,
        });
        const retainedRowCeiling = Math.max(
          1,
          Number(maxRetainedSampleRowsPerUser) || MAX_RETAINED_SAMPLE_ROWS_PER_USER,
        );
        if (bounds.length === 1 && loadedRows + chunkRows.length > retainedRowCeiling) {
          const bound = bounds[0];
          const last = chunkRows[chunkRows.length - 1];
          const memoryAfterExceptionalFetch = scoringMemorySnapshot(memoryUsage);
          if (
            Math.max(0, memoryAfterExceptionalFetch.total - memoryBefore.total) >
              maxHeapGrowthBytes ||
            Math.max(0, memoryAfterExceptionalFetch.total - loadStartMemory.total) >
              maxHeapGrowthBytes ||
            Math.max(
              0,
              memoryAfterExceptionalFetch.arrayBuffers - memoryBefore.arrayBuffers,
            ) > maxHeapGrowthBytes
          ) {
            loaded.clear();
            chunkRows.length = 0;
            throw new Error("worker scoring input exceeded the 32 MiB process memory guard");
          }
          const paged = new PagedSampleTimeline({
            bound,
            pageSize,
            loadPage: stepSampleModel.findRowsForUserRanges.bind(stepSampleModel),
            initialTimeline: loaded.get(bound.userId) || null,
            initialRows: chunkRows,
            cursor: last ? {
              ordinal: Number(last.ordinal),
              periodStart: last.start ?? last.periodStart,
              id: last.id,
            } : null,
            onPage(page) {
              metrics.observe("race_resolution_batch_rows", page.length, { kind: "samples" });
            },
            memoryUsage,
            maxHeapGrowthBytes,
            ...(createScoringScratchDirectory
              ? { createScratchDirectory: createScoringScratchDirectory }
              : {}),
          });
          // Register before preparation. A later recursive sibling or parallel
          // bulk input can fail before this timeline reaches samplesByUser;
          // prefetch's construction owner must still be able to unlink it.
          ownedTransientTimelines.add(paged);
          // Finish the sole PostgreSQL cursor pass before returning. This drops
          // the detection buffers before any scoring phase can request data.
          await paged.prepare();
          loaded.clear();
          chunkRows.length = 0;
          return new Map([[bound.userId, paged]]);
        }
        appendSampleRows(loaded, chunkRows);
        loadedRows += chunkRows.length;
        const memoryAfter = scoringMemorySnapshot(memoryUsage);
        const heapGrowth = Math.max(0, memoryAfter.heapUsed - memoryBefore.heapUsed);
        const externalGrowth = Math.max(0, memoryAfter.external - memoryBefore.external);
        const arrayBufferGrowth = Math.max(0, memoryAfter.arrayBuffers - memoryBefore.arrayBuffers);
        const totalGrowth = Math.max(0, memoryAfter.total - memoryBefore.total);
        const retainedGrowth = Math.max(0, memoryAfter.total - loadStartMemory.total);
        metrics.observe("race_resolution_batch_rows", chunkRows.length, { kind: "samples" });
        metrics.observe("race_resolution_batch_bytes", totalGrowth, { kind: "samples" });
        metrics.observe("race_resolution_batch_heap_bytes", heapGrowth, { kind: "samples" });
        metrics.observe("race_resolution_batch_external_bytes", externalGrowth, { kind: "samples" });
        metrics.observe("race_resolution_batch_array_buffer_bytes", arrayBufferGrowth, { kind: "samples" });
        if (chunkRows.length > pageSize || totalGrowth > maxHeapGrowthBytes ||
            retainedGrowth > maxHeapGrowthBytes ||
            externalGrowth > maxHeapGrowthBytes || arrayBufferGrowth > maxHeapGrowthBytes) {
          if (bounds.length > 1) {
            metrics.increment("race_scoring_batch_fallback_total", { reason: "split_users" });
            loaded.clear();
            chunkRows.length = 0;
            const middle = Math.ceil(bounds.length / 2);
            const left = await loadBounds(bounds.slice(0, middle), pageSize);
            const right = await loadBounds(bounds.slice(middle), pageSize);
            mergeSampleTimelines(left, right);
            return left;
          }
          if (pageSize > 1) {
            metrics.increment("race_scoring_batch_fallback_total", { reason: "split_page" });
            loaded.clear();
            chunkRows.length = 0;
            return loadBounds(bounds, Math.max(1, Math.floor(pageSize / 2)));
          }
          throw new Error(
            totalGrowth > maxHeapGrowthBytes || retainedGrowth > maxHeapGrowthBytes ||
              externalGrowth > maxHeapGrowthBytes ||
              arrayBufferGrowth > maxHeapGrowthBytes
              ? "worker scoring input exceeded the 32 MiB process memory guard"
              : "worker scoring input exceeded the row chunk guard",
          );
        }
        if (bounds.length > 1 && chunkRows.length === pageSize) {
          // Do not discover a pathological user by retaining several users'
          // first pages at once. Clear the probe before recursively reloading
          // whole-user halves so the parent frame cannot duplicate memory.
          metrics.increment("race_scoring_batch_fallback_total", { reason: "split_users" });
          loaded.clear();
          chunkRows.length = 0;
          const middle = Math.ceil(bounds.length / 2);
          const left = await loadBounds(bounds.slice(0, middle), pageSize);
          const right = await loadBounds(bounds.slice(middle), pageSize);
          mergeSampleTimelines(left, right);
          return left;
        }
        if (chunkRows.length < pageSize) return loaded;
        const last = chunkRows[chunkRows.length - 1];
        cursor = {
          ordinal: Number(last.ordinal),
          periodStart: last.start ?? last.periodStart,
          id: last.id,
        };
      }
    };
    const timelines = new Map();
    for (let offset = 0; offset < requestedBounds.length; offset += maxUsersPerChunk) {
      const bounds = requestedBounds.slice(offset, offset + maxUsersPerChunk);
      mergeSampleTimelines(
        timelines,
        await loadBounds(bounds, maxSampleRowsPerChunk),
      );
      for (const bound of bounds) preparedSampleUsers.add(bound.userId);
    }
    return timelines;
  };
  const prepareSampleUsers = async (requestedUserIds) => {
    const requested = [...new Set(requestedUserIds || [])];
    for (const userId of requested) {
      const cached = cachedByUser.get(userId);
      if (!preparedSampleUsers.has(userId) && cached) {
        samplesByUser.set(userId, cached.timeline);
        preparedSampleUsers.add(userId);
      }
    }
    const bounds = requested
      .filter((userId) => !preparedSampleUsers.has(userId))
      .map((userId) => sampleBoundByUser.get(userId))
      .filter(Boolean);
    if (!bounds.length) return;
    mergeSampleTimelines(samplesByUser, await loadSampleBounds(bounds));
    for (const bound of bounds) cachePreparedUser(bound.userId);
  };
  const sampleRowsPromise = deferredSampleLoading
    ? Promise.resolve(samplesByUser)
    : prepareSampleUsers(userIds).then(() => samplesByUser);

  const uncachedUserIds = userIds.filter((userId) => !cachedByUser.has(userId));
  const completeEffectSnapshot = participantIds.length > 0 &&
    typeof raceActiveEffectModel.findResolutionEffectsForRaces === "function";
  const [, dailyRows, prefetchedEffects, powerupEvents] = await Promise.all([
    sampleRowsPromise,
    uncachedUserIds.length > 0
      ? stepsModel.findByUserIdsAndDateRange(
          uncachedUserIds, dailyRangeStart, dailyRangeEnd
        )
      : Promise.resolve([]),
    participantIds.length > 0
      ? completeEffectSnapshot
        ? raceActiveEffectModel.findResolutionEffectsForRaces(
            raceIds, PREFETCH_EFFECT_TYPES,
          )
        : raceActiveEffectModel.findEffectsForRaceParticipantsByTypes(
            raceIds,
            participantIds,
            PREFETCH_EFFECT_TYPES
          )
      : Promise.resolve({}),
    powerupEventModel && typeof powerupEventModel.findByRaceAsc === "function"
      ? Promise.all(started.map((race) => powerupEventModel.findByRaceAsc(race.id)))
      : Promise.resolve([]),
  ]);

  dailyByUser = new Map(
    [...cachedByUser].map(([userId, entry]) => [userId, entry.dailyRows])
  );
  for (const row of dailyRows || []) {
    const list = dailyByUser.get(row.userId) || [];
    list.push(row);
    dailyByUser.set(row.userId, list);
  }
  if (!deferredSampleLoading) {
    for (const userId of uncachedUserIds) cachePreparedUser(userId);
  }

  const sampleStartMs = sampleRangeStart.getTime();
  const sampleEndMs = sampleRangeEnd.getTime();
  const dailyStartMs = dailyRangeStart.getTime();
  const dailyEndMs = dailyRangeEnd.getTime();
  const prefetchedTypes = new Set(PREFETCH_EFFECT_TYPES);
  const effectsByParticipant = completeEffectSnapshot
    ? Object.fromEntries(participantIds.map((participantId) => [participantId, {}]))
    : prefetchedEffects;
  if (completeEffectSnapshot) {
    for (const effect of prefetchedEffects || []) {
      const byType = (effectsByParticipant[effect.targetParticipantId] ||= {});
      (byType[effect.type] ||= []).push(effect);
    }
  }

  function fallbackOrThrow(message, operation) {
    if (strictWorkerMode) {
      throw new Error(`${message} outside the bounded worker scoring input`);
    }
    return operation();
  }

  const scopedStepSamples = {
    ...stepSampleModel,
    prepareUsers: prepareSampleUsers,
    releaseUsers(requestedUserIds) {
      for (const userId of requestedUserIds || []) {
        // Exceptional users are generation-scoped, not phase-scoped. Base
        // scoring, Hitchhike/Leech/impact attribution, and expiry finish
        // crossing may ask for the same user after an intermediate
        // releaseUsers call. Keep only the disk spool (no V8 timeline) until
        // releaseAll so those later phases never reopen the PostgreSQL cursor.
        if (samplesByUser.get(userId)?.isPaged) continue;
        samplesByUser.delete(userId);
        preparedSampleUsers.delete(userId);
      }
    },
    releaseAll() {
      for (const timeline of ownedTransientTimelines) timeline?.dispose?.();
      ownedTransientTimelines.clear();
      samplesByUser.clear();
      preparedSampleUsers.clear();
    },
    retainedUserCount() {
      return samplesByUser.size;
    },
    retainedSampleRowCount() {
      let count = 0;
      for (const timeline of samplesByUser.values()) {
        if (!timeline?.isPaged) count += Number(timeline?.length) || 0;
      }
      return count;
    },
    async sumStepsInWindows(userId, windows) {
      if (!windows || windows.length === 0) return [];
      if (
        !windows.every((window) =>
          inCoveredRange(
            window.start,
            window.end,
            sampleStartMs,
            sampleEndMs
          )
        )
      ) {
        return fallbackOrThrow("sample window", () =>
          stepSampleModel.sumStepsInWindows(userId, windows));
      }
      if (strictWorkerMode && !preparedSampleUsers.has(userId)) {
        throw new Error("sample user outside the prepared worker scoring chunk");
      }
      const timeline = samplesByUser.get(userId) || new CompactSampleTimeline();
      const normalized = windows.map((window) => ({
        startMs: new Date(window.start).getTime(), endMs: new Date(window.end).getTime(),
      }));
      if (typeof timeline.sumMany === "function") return timeline.sumMany(normalized);
      return Promise.all(normalized.map((window) => timeline.sum(window.startMs, window.endMs)));
    },
    async sumStepsInWindow(userId, start, end) {
      const [sum] = await this.sumStepsInWindows(userId, [{ start, end }]);
      return sum || 0;
    },
    async sumClosedStepsInWindows(userId, windows, closedAt) {
      if (!windows || windows.length === 0) return [];
      if (
        !windows.every((window) =>
          inCoveredRange(
            window.start,
            window.end,
            sampleStartMs,
            sampleEndMs
          )
        )
      ) {
        return fallbackOrThrow("closed sample window", () =>
          stepSampleModel.sumClosedStepsInWindows(userId, windows, closedAt));
      }
      const closedAtMs = new Date(closedAt).getTime();
      if (strictWorkerMode && !preparedSampleUsers.has(userId)) {
        throw new Error("sample user outside the prepared worker scoring chunk");
      }
      const timeline = samplesByUser.get(userId) || new CompactSampleTimeline();
      const normalized = windows.map((window) => ({
        startMs: new Date(window.start).getTime(), endMs: new Date(window.end).getTime(),
      }));
      if (typeof timeline.sumMany === "function") return timeline.sumMany(normalized, closedAtMs);
      return Promise.all(normalized.map((window) => timeline.sum(
        window.startMs, window.endMs, closedAtMs,
      )));
    },
    async sumClosedStepsInWindow(userId, start, end, closedAt) {
      const [sum] = await this.sumClosedStepsInWindows(
        userId,
        [{ start, end }],
        closedAt
      );
      return sum || 0;
    },
    async hasAnyInWindow(userId, start, end) {
      if (!inCoveredRange(start, end, sampleStartMs, sampleEndMs)) {
        return fallbackOrThrow("sample existence window", () =>
          stepSampleModel.hasAnyInWindow(userId, start, end));
      }
      const startMs = new Date(start).getTime();
      const endMs = new Date(end).getTime();
      if (strictWorkerMode && !preparedSampleUsers.has(userId)) {
        throw new Error("sample user outside the prepared worker scoring chunk");
      }
      return await (samplesByUser.get(userId) || new CompactSampleTimeline())
        .hasAny(startMs, endMs);
    },
    async findByUserIdAndTimeRange(userId, start, end) {
      if (!inCoveredRange(start, end, sampleStartMs, sampleEndMs)) {
        return fallbackOrThrow("finish timeline", () =>
          stepSampleModel.findByUserIdAndTimeRange(userId, start, end));
      }
      const startMs = new Date(start).getTime();
      const endMs = new Date(end).getTime();
      if (strictWorkerMode && !preparedSampleUsers.has(userId)) {
        throw new Error("sample user outside the prepared worker scoring chunk");
      }
      return (samplesByUser.get(userId) || new CompactSampleTimeline())
        .view(startMs, endMs);
    },
  };

  const scopedSteps = {
    ...stepsModel,
    async findByUserIdAndDate(userId, date) {
      const dateMs = new Date(date).getTime();
      if (dateMs < dailyStartMs || dateMs > dailyEndMs) {
        return fallbackOrThrow("daily row", () =>
          stepsModel.findByUserIdAndDate(userId, date));
      }
      return (
        (dailyByUser.get(userId) || []).find(
          (row) => new Date(row.date).getTime() === dateMs
        ) || null
      );
    },
    async findByUserIdAndDateRange(userId, start, end) {
      const startMs = new Date(start).getTime();
      const endMs = new Date(end).getTime();
      if (startMs < dailyStartMs || endMs > dailyEndMs) {
        return fallbackOrThrow("daily range", () =>
          stepsModel.findByUserIdAndDateRange(userId, start, end));
      }
      return (dailyByUser.get(userId) || []).filter((row) => {
        const dateMs = new Date(row.date).getTime();
        return dateMs >= startMs && dateMs <= endMs;
      });
    },
  };

  // Keep the model's global createdAt ordering for race-wide consumers. In
  // particular, Trail Mines are sequential and must not be reordered by the
  // participant/type grouping used for participant-local scoring reads.
  const allEffects = completeEffectSnapshot
    ? prefetchedEffects || []
    : Object.values(effectsByParticipant || {}).flatMap(
        (byType) => Object.values(byType || {}).flat()
      );
  const scopedEffects = {
    ...raceActiveEffectModel,
    async findEffectsForRaceByTypes(raceId, participantId, types) {
      if (!types.every((type) => prefetchedTypes.has(type))) {
        return fallbackOrThrow("participant effects", () =>
          raceActiveEffectModel.findEffectsForRaceByTypes(
          raceId,
          participantId,
          types
          ));
      }
      const source = effectsByParticipant?.[participantId] || {};
      return Object.fromEntries(
        types.map((type) => [type, source[type] || []])
      );
    },
    async findEffectsForRaceByType(raceId, participantId, type) {
      if (!prefetchedTypes.has(type)) {
        return fallbackOrThrow("participant effect", () =>
          raceActiveEffectModel.findEffectsForRaceByType(
          raceId,
          participantId,
          type
          ));
      }
      return effectsByParticipant?.[participantId]?.[type] || [];
    },
    async findRaceEffectsByType(raceId, type) {
      if (!prefetchedTypes.has(type)) {
        return fallbackOrThrow("race effects", () =>
          raceActiveEffectModel.findRaceEffectsByType(raceId, type));
      }
      return allEffects.filter(
        (effect) => effect.raceId === raceId && effect.type === type
      );
    },
    async findActiveForRace(raceId) {
      if (!completeEffectSnapshot) {
        return raceActiveEffectModel.findActiveForRace(raceId);
      }
      return allEffects.filter(
        (effect) => effect.raceId === raceId && effect.status === "ACTIVE"
      );
    },
    async findActiveByTypeForParticipant(participantId, type, options = {}) {
      if (!completeEffectSnapshot) {
        return raceActiveEffectModel.findActiveByTypeForParticipant(
          participantId, type, options,
        );
      }
      const expiresAfter = options?.expiresAfter
        ? new Date(options.expiresAfter).getTime()
        : null;
      return (effectsByParticipant?.[participantId]?.[type] || []).find(
        (effect) => effect.status === "ACTIVE" &&
          (expiresAfter == null || (effect.expiresAt &&
            new Date(effect.expiresAt).getTime() > expiresAfter))
      ) || null;
    },
    async update(id, fields) {
      const updated = await raceActiveEffectModel.update(id, fields);
      if (completeEffectSnapshot) {
        const cached = allEffects.find((effect) => effect.id === id);
        if (cached) Object.assign(cached, fields, updated || {});
      }
      return updated;
    },
  };

  const eventsByRaceId = new Map(
    started.map((race, index) => [race.id, powerupEvents[index] || []])
  );
  const scopedPowerupEvents = powerupEventModel
    ? {
        ...powerupEventModel,
        async findByRaceAsc(raceId) {
          if (eventsByRaceId.has(raceId)) return eventsByRaceId.get(raceId);
          return fallbackOrThrow("race power-up timeline", () =>
            powerupEventModel.findByRaceAsc(raceId));
        },
      }
    : powerupEventModel;

  return {
    stepsModel: scopedSteps,
    stepSampleModel: scopedStepSamples,
    raceActiveEffectModel: scopedEffects,
    powerupEventModel: scopedPowerupEvents,
    sampleDependencyUserIds: [...new Set(allEffects.flatMap((effect) => [
      effect.sourceUserId,
      effect.targetUserId,
    ]).filter(Boolean))],
  };
}

async function prefetchRaceScoringModels(options) {
  const ownedTransientTimelines = new Set();
  try {
    return await prefetchRaceScoringModelsImpl({
      ...options,
      ownedTransientTimelines,
    });
  } catch (error) {
    // Construction can fail after a recursive left branch has already created
    // its exceptional-user spool but before the adapter/map is returned. The
    // construction owner is the only reachable teardown surface in that gap.
    for (const timeline of ownedTransientTimelines) {
      try { timeline.dispose(); } catch { /* preserve the construction error */ }
    }
    ownedTransientTimelines.clear();
    throw error;
  }
}

module.exports = {
  PREFETCH_EFFECT_TYPES,
  SCORING_INPUT_CACHE_MAX_USERS,
  SCORING_INPUT_CACHE_MAX_SAMPLE_ROWS,
  SCORING_INPUT_CACHE_TTL_MS,
  MAX_USERS_PER_CHUNK,
  MAX_SAMPLE_ROWS_PER_CHUNK,
  MAX_RETAINED_SAMPLE_ROWS_PER_USER,
  MAX_HEAP_GROWTH_BYTES,
  createScoringInputCache,
  processScoringInputCache,
  prefetchRaceScoringModels,
};
