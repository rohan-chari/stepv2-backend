const cacheKeys = require("../../../shared/cache/cacheKeys");
const redis = require("../../../shared/cache/redisCache");
const derived = require("../../../shared/cache/derivedCache");
const { capture, unchanged } = require("../../../shared/cache/cacheEfficiencyRead");

const CACHE_VERSION = 1;
const TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_ROWS = 3;
const MAX_BYTES = 256 * 1024;
const DOMAIN_PREFIX = "ce:v1:";

function versionOf(race) {
  const date = race?.updatedAt instanceof Date ? race.updatedAt : new Date(race?.updatedAt);
  return race?.id && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function project(row) {
  return {
    id: row.id || null,
    raceId: row.raceId,
    userId: row.userId || null,
    totalSteps: Number(row.totalSteps || 0),
    placement: row.placement == null ? null : Number(row.placement),
    payoutCoins: row.payoutCoins == null ? null : Number(row.payoutCoins),
  };
}

function validRow(row, raceId) {
  if (!row || typeof row !== "object" || row.raceId !== raceId ||
      typeof row.id !== "string" || !row.id || typeof row.userId !== "string" || !row.userId ||
      !Number.isSafeInteger(row.totalSteps) || row.totalSteps < 0 ||
      !Number.isSafeInteger(row.placement) || row.placement < 1 || row.placement > 3 ||
      (row.payoutCoins != null && (!Number.isSafeInteger(row.payoutCoins) || row.payoutCoins < 0)) ||
      Object.keys(row).sort().join(",") !== "id,payoutCoins,placement,raceId,totalSteps,userId") return false;
  return true;
}

function valid(value, race, version, tokens) {
  return value?.schema === CACHE_VERSION && value.raceId === race.id &&
    value.resultVersion === version && Array.isArray(value.rows) &&
    Array.isArray(value.tokens) && value.tokens.length === 2 &&
    value.tokens.every((token, index) => token === tokens[index]) &&
    value.rows.length <= MAX_ROWS &&
    value.rows.every((row) => validRow(row, race.id)) &&
    Object.keys(value).sort().join(",") === "raceId,resultVersion,rows,schema,tokens" &&
    Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_BYTES;
}

function buildRaceListPodiumCache({ redisCache = redis, derivedCache = derived } = {}) {
  async function getMany({ races = [], load, hydrate = null, retry = true }) {
    const unique = [...new Map(races.filter((race) => race?.id && versionOf(race))
      .map((race) => [race.id, race])).values()];
    if (!unique.length || typeof load !== "function") return new Map();
    const authoritative = async (ids) => new Map((await load(ids) || []).reduce((map, row) => {
        const list = map.get(row.raceId) || []; list.push(row); map.set(row.raceId, list); return map;
      }, new Map()));
    if (!redisCache.isEnabled?.() || derivedCache.isBypassed?.(DOMAIN_PREFIX)) return authoritative(unique.map((race) => race.id));
    derivedCache.ensureSubscribed?.();
    const markers = unique.flatMap((race) => [
      { domain: "race-meta", identity: race.id },
      { domain: "participant-display", identity: `roster:${race.id}` },
    ]);
    let fence;
    try { fence = await capture(markers); } catch { fence = null; }
    if (!fence) return authoritative(unique.map((race) => race.id));
    const keys = unique.map((race) => cacheKeys.raceListPodium(race.id, versionOf(race)));
    let read;
    try { read = await redisCache.getManyJSON(keys); } catch { read = null; }
    const out = new Map();
    const misses = [];
    if (read?.ok === true) {
      unique.forEach((race, index) => {
        const value = read.values[index];
        const markerIndex = index * 2;
        if (valid(value, race, versionOf(race), fence.tokens.slice(markerIndex, markerIndex + 2))) out.set(race.id, value.rows);
        else misses.push(race);
      });
    } else misses.push(...unique);
    if (!misses.length) {
      if (await unchanged(fence)) return hydrateOutput(out, hydrate);
      if (retry) return getMany({ races: unique, load, hydrate, retry: false });
      return authoritative(unique.map((race) => race.id));
    }
    const loadedRows = await load(misses.map((race) => race.id)) || [];
    for (const row of loadedRows) {
      const list = out.get(row.raceId) || []; list.push(row); out.set(row.raceId, list);
    }
    if (!(await unchanged(fence))) {
      if (retry) return getMany({ races: unique, load, hydrate, retry: false });
      return authoritative(unique.map((race) => race.id));
    }
    {
      const entries = misses.map((race, index) => {
        const rows = loadedRows.filter((row) => row.raceId === race.id).slice(0, MAX_ROWS).map(project);
        const markerIndex = unique.indexOf(race) * 2;
        return { key: keys[unique.indexOf(race)], value: {
          schema: CACHE_VERSION, raceId: race.id, resultVersion: versionOf(race),
          tokens: fence.tokens.slice(markerIndex, markerIndex + 2), rows,
        }, ttlSeconds: TTL_SECONDS };
      }).filter((entry) => Buffer.byteLength(JSON.stringify(entry.value), "utf8") <= MAX_BYTES);
      if (entries.length) await redisCache.setManyJSON(entries);
    }
    return hydrateOutput(out, hydrate);
  }
  async function hydrateOutput(out, hydrate) {
    if (typeof hydrate !== "function") return out;
    const rows = [...out.values()].flat();
    if (!rows.some((row) => !row.user)) return out;
    const hydrated = await hydrate(rows);
    const byRace = new Map();
    for (const row of hydrated || []) {
      const list = byRace.get(row.raceId) || [];
      list.push(row);
      byRace.set(row.raceId, list);
    }
    for (const [raceId, existing] of out) {
      const replacements = byRace.get(raceId) || [];
      const byId = new Map(replacements.map((row) => [row.id, row]));
      out.set(raceId, existing.map((row) => byId.get(row.id) || row));
    }
    return out;
  }
  return { getMany };
}

const raceListPodiumCache = buildRaceListPodiumCache();

module.exports = { CACHE_VERSION, TTL_SECONDS, buildRaceListPodiumCache, raceListPodiumCache };
