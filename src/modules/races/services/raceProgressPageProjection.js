// Versioned, page-scoped race progress projection.
//
// Redis is only a disposable transport here. The resolution worker supplies
// the canonical, already-ordered result and publishes bounded chunks before
// the generation marker. Readers accept a page only when every chunk carries
// the marker selected by the index.

const redisCache = require("../../../shared/cache/redisCache");
const derivedCache = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");
const { compareParticipantsForPlacement } = require("../placementOrder");
const crypto = require("node:crypto");

const SCHEMA_VERSION = 2;
const CHUNK_SIZE = 50;
const REQUESTER_BUCKET_COUNT = 256;
// Keep each Redis request small. Sending a complete 10k-person projection as
// one pipeline makes Redis account the whole client input/output buffer at
// once; on the 100 MB tier that non-evictable memory can exceed maxmemory even
// though the final bounded key-set comfortably fits.
const PUBLISH_BATCH_SIZE = 16;
// Generations are refreshed on resolution and invalidated when their source is
// dirtied. This TTL is therefore abandoned-data cleanup, not a freshness
// deadline. Keep it comfortably beyond the five-minute event surge plus queue
// drain; a one-minute expiry caused every request to stampede into the 10k-row
// SQL fallback while an otherwise healthy generation was still authoritative.
const TTL_SECONDS = 15 * 60;
const counters = { chunkReads: 0, requesterReads: 0 };

const INSTALL_IF_NOT_OLDER = `
local current = redis.call("get", KEYS[1])
if current then
  local decoded = cjson.decode(current)
  local currentGeneration = tonumber(decoded.generation)
  if currentGeneration and currentGeneration > tonumber(ARGV[1]) then
    return 0
  end
end
redis.call("set", KEYS[1], ARGV[2], "EX", ARGV[3])
return 1
`;

function finiteGeneration(value) {
  const generation = Number(value);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : null;
}

function normalizeRow(row, sourceParticipant = null) {
  if (!row || !row.userId || !row.participantId) return null;
  return {
    participantId: row.participantId,
    userId: row.userId,
    totalSteps: Number.isFinite(Number(row.totalSteps))
      ? Math.max(0, Number(row.totalSteps))
      : 0,
    finishedAt: row.finishedAt ?? null,
    forfeitedAt: row.forfeitedAt ?? null,
    team: row.team ?? null,
    placement: row.placement ?? null,
    currentMultiplier: Number.isFinite(Number(row.currentMultiplier))
      ? Number(row.currentMultiplier)
      : 1,
    baseAdjusted: row.baseAdjusted ?? null,
    // These fields stay internal to the projection and are used only by the
    // persisted powerup-odds calculation and invalidation key enumeration.
    joinedAt: sourceParticipant?.joinedAt ?? row.joinedAt ?? null,
    rawSteps: sourceParticipant?.rawSteps ?? row.rawSteps ?? null,
    finishTotalSteps: sourceParticipant?.finishTotalSteps ?? row.finishTotalSteps ?? null,
  };
}

function requesterBucket(userId) {
  return crypto.createHash("sha256").update(String(userId)).digest()[0];
}

function projectionGenerationKeys(raceId, index) {
  const generation = finiteGeneration(index?.generation);
  if (!raceId || !generation) return [];
  const keys = [];
  for (let chunk = 0; chunk < Number(index.chunkCount || 0); chunk += 1) {
    keys.push(cacheKeys.raceProgressPage(raceId, generation, chunk));
  }
  // Buckets are sparse, but deleting all 256 deterministic names is bounded
  // and avoids needing a Redis SCAN on the request or publication path.
  for (let bucket = 0; bucket < REQUESTER_BUCKET_COUNT; bucket += 1) {
    keys.push(cacheKeys.raceProgressParticipantBucket(raceId, generation, bucket));
  }
  return keys;
}

function projectionSlotKeys(raceId, index) {
  if (!raceId) return [];
  const bank = Number.isSafeInteger(index?.slotBank) ? index.slotBank : null;
  const keys = [];
  for (let chunk = 0; chunk < Number(index?.chunkCount || 0); chunk += 1) {
    keys.push(bank == null
      ? cacheKeys.raceProgressPageSlot(raceId, chunk)
      : cacheKeys.raceProgressPageBankSlot(raceId, bank, chunk));
  }
  for (let bucket = 0; bucket < REQUESTER_BUCKET_COUNT; bucket += 1) {
    keys.push(bank == null
      ? cacheKeys.raceProgressParticipantBucketSlot(raceId, bucket)
      : cacheKeys.raceProgressParticipantBucketBankSlot(raceId, bank, bucket));
  }
  return keys;
}

function buildRaceProgressPageProjection({
  raceId,
  generation,
  scoringTimeZone,
  asOf,
  race,
  participants = [],
  sourceParticipants = [],
}) {
  const safeGeneration = finiteGeneration(generation);
  if (!raceId || !safeGeneration || !scoringTimeZone) {
    throw new TypeError("race projection requires raceId, generation, and scoringTimeZone");
  }
  const sourceById = new Map(
    sourceParticipants
      .filter((participant) => participant?.id)
      .map((participant) => [participant.id, participant])
  );
  const rows = participants
    .map((participant) => normalizeRow(participant, sourceById.get(participant.participantId)))
    .filter(Boolean);
  rows.sort(compareParticipantsForPlacement);
  const chunks = [];
  for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
    chunks.push({
      v: SCHEMA_VERSION,
      generation: safeGeneration,
      asOf: new Date(asOf).toISOString(),
      rows: rows.slice(offset, offset + CHUNK_SIZE),
    });
  }
  const participantBuckets = new Map();
  for (const row of rows) {
    const bucket = requesterBucket(row.userId);
    const entries = participantBuckets.get(bucket) || {};
    entries[row.userId] = row;
    participantBuckets.set(bucket, entries);
  }
  const index = {
    v: SCHEMA_VERSION,
    generation: safeGeneration,
    asOf: new Date(asOf).toISOString(),
    scoringTimeZone,
    raceId,
    race: race || {},
    totalCount: rows.length,
    chunkSize: CHUNK_SIZE,
    chunkCount: chunks.length,
    requesterBucketCount: REQUESTER_BUCKET_COUNT,
    slotBank: safeGeneration % 2,
    // Chunk descriptors are the ordered ranking index. The request path reads
    // only the descriptors needed for its page, never a presentation roster.
    chunks: chunks.map((_, chunk) => chunk),
  };
  return { index, chunks, participantBuckets };
}

async function currentGenerationIsValid(currentGeneration, generation) {
  if (typeof currentGeneration !== "function") return true;
  try {
    return Number(await currentGeneration()) === Number(generation);
  } catch {
    return false;
  }
}

async function publishRaceProgressPageProjectionUnlocked({
  raceId,
  generation,
  snapshot,
  currentGeneration,
  ttlSeconds = TTL_SECONDS,
  allowSupersededComplete = false,
}) {
  const safeGeneration = finiteGeneration(generation);
  if (!safeGeneration || !snapshot || snapshot.index?.raceId !== raceId) return false;
  if (!redisCache.isEnabled()) return false;
  if (
    !allowSupersededComplete &&
    !(await currentGenerationIsValid(currentGeneration, safeGeneration))
  ) return false;

  const existing = await redisCache.getJSON(cacheKeys.raceProgressIndex(raceId));
  if (existing && finiteGeneration(existing.generation) > safeGeneration) return false;
  const entries = [];
  const existingBank = Number.isSafeInteger(existing?.slotBank)
    ? existing.slotBank
    : null;
  // Always fill the inactive bank. Generation parity is only a cold-start
  // default: coalescing can skip generations, so parity can otherwise select
  // the bank readers are actively using and expose a mixed generation while
  // the bounded batches are still being written.
  const bank = existingBank == null
    ? snapshot.index.slotBank
    : existingBank === 0 ? 1 : 0;
  const installedIndex = { ...snapshot.index, slotBank: bank };
  for (const [chunk, value] of (snapshot.chunks || []).entries()) {
    entries.push({
      key: cacheKeys.raceProgressPageBankSlot(raceId, bank, chunk),
      value,
      ttlSeconds,
    });
  }
  for (const [bucket, rowsByUserId] of snapshot.participantBuckets || []) {
    entries.push({
      key: cacheKeys.raceProgressParticipantBucketBankSlot(raceId, bank, bucket),
      value: {
        v: SCHEMA_VERSION,
        generation: safeGeneration,
        asOf: snapshot.index.asOf,
        rowsByUserId,
      },
      ttlSeconds,
    });
  }
  if (
    !allowSupersededComplete &&
    !(await currentGenerationIsValid(currentGeneration, safeGeneration))
  ) return false;
  for (let offset = 0; offset < entries.length; offset += PUBLISH_BATCH_SIZE) {
    const batch = entries.slice(offset, offset + PUBLISH_BATCH_SIZE);
    const written = await redisCache.setManyJSON(batch);
    if (!written.ok || written.count !== batch.length) return false;
  }
  const installed = await redisCache.evalLua(
    INSTALL_IF_NOT_OLDER,
    [cacheKeys.raceProgressIndex(raceId)],
    [safeGeneration, JSON.stringify(installedIndex), ttlSeconds],
  );
  if (!installed.ok || Number(installed.result) !== 1) return false;
  if (existing) {
    // Coalescing can skip generations. Because the bounded banks are selected
    // by generation parity, a skipped generation may legitimately reuse the
    // same bank as the prior index. Those keys now contain the new generation
    // and must not be deleted after the index flip.
    await redisCache.del([
      ...(existingBank !== bank ? projectionSlotKeys(raceId, existing) : []),
      ...projectionGenerationKeys(raceId, existing),
    ]);
  }
  return allowSupersededComplete
    ? true
    : currentGenerationIsValid(currentGeneration, safeGeneration);
}

async function publishRaceProgressPageProjection(options) {
  const raceId = options?.raceId;
  if (!raceId || !redisCache.isEnabled()) return false;
  const published = await redisCache.withLock(
    cacheKeys.raceProgressPagePublishLock(raceId),
    30_000,
    () => publishRaceProgressPageProjectionUnlocked(options),
  );
  return published === true;
}

function validChunk(value, generation, asOf) {
  return Boolean(
    value &&
      value.v === SCHEMA_VERSION &&
      finiteGeneration(value.generation) === generation &&
      value.asOf === asOf &&
      Array.isArray(value.rows)
  );
}

async function readRaceProgressPageProjection({
  raceId,
  offset = 0,
  limit = 15,
  requesterUserId = null,
  scoringTimeZone = null,
}) {
  if (!raceId || !redisCache.isEnabled()) return null;
  if (derivedCache.isBypassed(cacheKeys.PREFIX.RACE_PROGRESS)) return null;
  const index = await redisCache.getJSON(cacheKeys.raceProgressIndex(raceId));
  const generation = finiteGeneration(index?.generation);
  if (
    !index ||
    index.v !== SCHEMA_VERSION ||
    !generation ||
    typeof index.asOf !== "string" ||
    !Number.isSafeInteger(index.totalCount) ||
    index.chunkSize !== CHUNK_SIZE ||
    index.requesterBucketCount !== REQUESTER_BUCKET_COUNT ||
    (scoringTimeZone && index.scoringTimeZone !== scoringTimeZone)
  ) return null;

  const total = index.totalCount;
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const safeLimit = Math.max(1, Math.min(CHUNK_SIZE, Math.floor(Number(limit) || 1)));
  const end = Math.min(total, start + safeLimit);
  const firstChunk = Math.floor(start / CHUNK_SIZE);
  const lastChunk = end > start ? Math.floor((end - 1) / CHUNK_SIZE) : firstChunk;
  const chunkNumbers = end > start
    ? Array.from({ length: lastChunk - firstChunk + 1 }, (_, i) => firstChunk + i)
    : [];
  const bank = Number.isSafeInteger(index.slotBank) ? index.slotBank : null;
  const chunkKeys = chunkNumbers.map((chunk) => bank == null
    ? cacheKeys.raceProgressPageSlot(raceId, chunk)
    : cacheKeys.raceProgressPageBankSlot(raceId, bank, chunk));
  const chunkResult = await redisCache.getManyJSON(chunkKeys);
  counters.chunkReads = chunkKeys.length;
  if (!chunkResult.ok) return null;
  const chunks = chunkResult.values;
  if (chunks.some((chunk) => !validChunk(chunk, generation, index.asOf))) return null;

  const allRows = chunks.flatMap((chunk) => chunk.rows);
  const rows = allRows.slice(start - firstChunk * CHUNK_SIZE, end - firstChunk * CHUNK_SIZE);
  if (rows.length !== end - start) return null;
  if (rows.some((row) => !normalizeRow(row))) return null;

  let requesterRow = null;
  if (requesterUserId && !rows.some((row) => row.userId === requesterUserId)) {
    const bucket = await redisCache.getJSON(
      bank == null
        ? cacheKeys.raceProgressParticipantBucketSlot(
            raceId, requesterBucket(requesterUserId))
        : cacheKeys.raceProgressParticipantBucketBankSlot(
            raceId, bank, requesterBucket(requesterUserId))
    );
    counters.requesterReads += 1;
    const row = bucket?.rowsByUserId?.[requesterUserId];
    if (!bucket || bucket.v !== SCHEMA_VERSION ||
        finiteGeneration(bucket.generation) !== generation ||
        bucket.asOf !== index.asOf || !normalizeRow(row)) return null;
    requesterRow = row;
  }
  return {
    index,
    generation,
    asOf: index.asOf,
    rows,
    requesterRow,
    total,
    offset: start,
    limit: safeLimit,
  };
}

async function invalidateRaceProgressPageProjection(raceId) {
  if (!raceId || !redisCache.isEnabled()) return true;
  const index = await redisCache.getJSON(cacheKeys.raceProgressIndex(raceId));
  const keys = [
    cacheKeys.raceProgressIndex(raceId),
    ...projectionSlotKeys(raceId, index),
    ...projectionGenerationKeys(raceId, index),
  ];
  return derivedCache.invalidate({
    keys,
    prefix: cacheKeys.PREFIX.RACE_PROGRESS,
  });
}

module.exports = {
  SCHEMA_VERSION,
  CHUNK_SIZE,
  REQUESTER_BUCKET_COUNT,
  PUBLISH_BATCH_SIZE,
  TTL_SECONDS,
  projectionGenerationKeys,
  projectionSlotKeys,
  buildRaceProgressPageProjection,
  publishRaceProgressPageProjection,
  readRaceProgressPageProjection,
  invalidateRaceProgressPageProjection,
  __counters: counters,
  __resetCounters() {
    counters.chunkReads = 0;
    counters.requesterReads = 0;
  },
};
