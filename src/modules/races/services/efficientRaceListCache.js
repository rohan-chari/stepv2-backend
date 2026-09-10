const redis = require("../../../shared/cache/redisCache");
const derived = require("../../../shared/cache/derivedCache");
const { capture, unchanged } = require("../../../shared/cache/cacheEfficiencyRead");
const { PREFIX } = require("../../../shared/cache/cacheEfficiencyInvalidation");
const metrics = require("../../../shared/observability/cacheEfficiencyMetrics");
const TTL = Object.freeze({ membership: 120, pending: 60, completed: 900 });
const KINDS = Object.keys(TTL);
const MAX_RACES = 128;
const MAX_BYTES = 512 * 1024;
const INSTALL = `
for i = 2, #KEYS do
  if redis.call('GET', KEYS[i]) ~= ARGV[i + 1] then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;
function projection(rows) {
  const { projectStableRaces } = require("./raceListCache");
  return projectStableRaces(rows).map(({ creator, winner, ...race }) => race);
}
function valid(value) {
  if (!value || value.schema !== 1 || !Array.isArray(value.races) || !Array.isArray(value.raceTokens) ||
      value.races.length > MAX_RACES || value.races.length !== value.raceTokens.length) return false;
  const allowed = new Set(require("./raceListCache").classifyRaceListFields().stable.filter(field => field !== "creator" && field !== "winner"));
  if (Object.keys(value).sort().join(",") !== "raceTokens,races,schema" || value.raceTokens.some(token => typeof token !== "string" || !/^[a-f0-9-]{36}$/.test(token))) return false;
  if (value.races.some((race) => !race || Array.isArray(race) || typeof race.id !== "string" ||
      !["PENDING", "ACTIVE", "COMPLETED", "CANCELLED"].includes(race.status) || Object.keys(race).some(field => !allowed.has(field)))) return false;
  return Buffer.byteLength(JSON.stringify(value)) <= MAX_BYTES;
}
async function getStableMembership({ userId, variant = "legacy", load, loadFragment, validateSources, hydrate, retry = true }) {
  const fallback = async (reason) => {
    metrics.read("list", reason);
    metrics.count("list", "source_loads");
    return { races: require("./raceListCache").projectStableRaces(await load()), source: "postgres" };
  };
  if (!redis.isEnabled() || !loadFragment || !validateSources || !hydrate || derived.isBypassed(PREFIX)) return fallback("bypass");
  derived.ensureSubscribed();
  const userFence = await capture([{ domain: "list", identity: userId }]);
  if (!userFence) return fallback("error");
  const keys = KINDS.map((kind) => `ce:v1:list:${userId}:${variant}:${kind}:${userFence.tokens[0]}`);
  const read = await redis.getManyJSON(keys);
  metrics.count("list", "redis", 2);
  if (!read.ok) return fallback("error");
  const fragments = new Map();
  const misses = [];
  for (let index = 0; index < KINDS.length; index++) {
    const box = read.values[index];
    if (valid(box)) fragments.set(KINDS[index], box);
    else misses.push(KINDS[index]);
  }
  const hits = [...fragments.values()];
  const cachedRows = hits.flatMap((box) => box.races);
  if (cachedRows.length > MAX_RACES) return fallback("malformed");
  if (cachedRows.length) {
    const cachedFence = await capture(cachedRows.map((race) => ({ domain: "race-meta", identity: race.id })));
    metrics.count("list", "redis");
    const expected = hits.flatMap((box) => box.raceTokens);
    if (!cachedFence || !cachedFence.tokens.every((token, index) => token === expected[index])) {
      metrics.read("list", "generation");
      await redis.del(keys);
      return retry ? getStableMembership({ userId, variant, load, loadFragment, validateSources, hydrate, retry: false }) : fallback("generation");
    }
  }
  for (const kind of misses) {
    metrics.count("list", "source_loads");
    const rows = projection(await loadFragment(kind));
    if (rows.length > MAX_RACES) return fallback("malformed");
    const raceFence = rows.length ? await capture(rows.map((race) => ({ domain: "race-meta", identity: race.id }))) : { keys: [], tokens: [] };
    if (!raceFence) return fallback("error");
    // IDs are not known until the bounded source load. Capture their tokens,
    // then prove those loaded row versions still match PostgreSQL before CAS.
    metrics.count("list", "source_loads");
    if (!(await validateSources(rows))) return fallback("generation");
    const box = { schema: 1, races: rows, raceTokens: raceFence.tokens };
    if (!valid(box)) return fallback("malformed");
    const installed = await redis.evalLua(INSTALL, [keys[KINDS.indexOf(kind)], ...userFence.keys, ...raceFence.keys], [
      JSON.stringify(box), TTL[kind], ...userFence.tokens, ...raceFence.tokens,
    ]);
    metrics.count("list", "redis", rows.length ? 2 : 1);
    if (!installed.ok || installed.result !== 1) return fallback(installed.ok ? "generation" : "error");
    fragments.set(kind, box);
  }
  const all = KINDS.flatMap((kind) => fragments.get(kind).races);
  if (all.length > MAX_RACES || Buffer.byteLength(JSON.stringify(all)) > MAX_BYTES || new Set(all.map((race) => race.id)).size !== all.length) return fallback("generation");
  const allFence = {
    keys: [...userFence.keys, ...all.map((race) => require("../../../shared/cache/cacheEfficiencyInvalidation").markerKey("race-meta", race.id))],
    tokens: [...userFence.tokens, ...KINDS.flatMap((kind) => fragments.get(kind).raceTokens)],
  };
  metrics.count("list", "redis");
  if (!(await unchanged(allFence)) || derived.isBypassed(PREFIX)) return fallback("generation");
  metrics.read("list", misses.length ? "missing" : "hit");
  return { races: require("./raceListCache").projectStableRaces(await hydrate(all)), source: misses.length === 0 ? "redis" : misses.length === KINDS.length ? "postgres" : "mixed" };
}
module.exports = { getStableMembership, TTL };
