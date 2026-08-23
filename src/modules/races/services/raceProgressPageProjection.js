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

const SCHEMA_VERSION = 1;
const CHUNK_SIZE = 50;
const TTL_SECONDS = 60;
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
    totalSteps: Number.isFinite(Number(row.totalSteps)) ? Number(row.totalSteps) : 0,
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
    // Chunk descriptors are the ordered ranking index. The request path reads
    // only the descriptors needed for its page, never a presentation roster.
    chunks: chunks.map((_, chunk) => chunk),
  };
  return { index, chunks, participantRows: rows };
}

async function currentGenerationIsValid(currentGeneration, generation) {
  if (typeof currentGeneration !== "function") return true;
  try {
    return Number(await currentGeneration()) === Number(generation);
  } catch {
    return false;
  }
}

async function publishRaceProgressPageProjection({
  raceId,
  generation,
  snapshot,
  currentGeneration,
  ttlSeconds = TTL_SECONDS,
}) {
  const safeGeneration = finiteGeneration(generation);
  if (!safeGeneration || !snapshot || snapshot.index?.raceId !== raceId) return false;
  if (!redisCache.isEnabled()) return false;
  if (!(await currentGenerationIsValid(currentGeneration, safeGeneration))) return false;

  const existing = await redisCache.getJSON(cacheKeys.raceProgressIndex(raceId));
  if (existing && finiteGeneration(existing.generation) > safeGeneration) return false;

  const entries = [];
  for (const [chunk, value] of (snapshot.chunks || []).entries()) {
    entries.push({
      key: cacheKeys.raceProgressPage(raceId, safeGeneration, chunk),
      value,
      ttlSeconds,
    });
  }
  for (const row of snapshot.participantRows || []) {
    entries.push({
      key: cacheKeys.raceProgressParticipant(raceId, safeGeneration, row.userId),
      value: {
        v: SCHEMA_VERSION,
        generation: safeGeneration,
        asOf: snapshot.index.asOf,
        row,
      },
      ttlSeconds,
    });
  }
  const written = await redisCache.setManyJSON(entries);
  if (!written.ok || written.count !== entries.length) return false;

  // Chunks are durable before this marker becomes visible. The marker is a
  // Redis-side generation fence, so an older worker cannot repoint a reader at
  // its generation after a newer worker has published.
  if (!(await currentGenerationIsValid(currentGeneration, safeGeneration))) return false;
  const installed = await redisCache.evalLua(
    INSTALL_IF_NOT_OLDER,
    [cacheKeys.raceProgressIndex(raceId)],
    [safeGeneration, JSON.stringify(snapshot.index), ttlSeconds]
  );
  if (!installed.ok || Number(installed.result) !== 1) return false;
  return currentGenerationIsValid(currentGeneration, safeGeneration);
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
  const chunkKeys = chunkNumbers.map((chunk) =>
    cacheKeys.raceProgressPage(raceId, generation, chunk)
  );
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
    const requester = await redisCache.getJSON(
      cacheKeys.raceProgressParticipant(raceId, generation, requesterUserId)
    );
    counters.requesterReads += 1;
    if (!requester || requester.v !== SCHEMA_VERSION ||
        finiteGeneration(requester.generation) !== generation ||
        requester.asOf !== index.asOf || !normalizeRow(requester.row)) return null;
    requesterRow = requester.row;
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
  const keys = [cacheKeys.raceProgressIndex(raceId)];
  const generation = finiteGeneration(index?.generation);
  if (generation) {
    for (let chunk = 0; chunk < Number(index.chunkCount || 0); chunk += 1) {
      keys.push(cacheKeys.raceProgressPage(raceId, generation, chunk));
    }
  }
  return derivedCache.invalidate({
    keys,
    prefix: cacheKeys.PREFIX.RACE_PROGRESS,
  });
}

module.exports = {
  SCHEMA_VERSION,
  CHUNK_SIZE,
  TTL_SECONDS,
  buildRaceProgressPageProjection,
  publishRaceProgressPageProjection,
  readRaceProgressPageProjection,
  invalidateRaceProgressPageProjection,
  __private: { INSTALL_IF_NOT_OLDER },
  __counters: counters,
  __resetCounters() {
    counters.chunkReads = 0;
    counters.requesterReads = 0;
  },
};
