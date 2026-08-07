// C3 follow-up (spec revision v9 item 2): keep the race-detail mystery-box
// toast alive after Phase D moved `syncRacePowerupState` off the request path.
//
// ── The problem ────────────────────────────────────────────────────────────
// `powerupData.newMysteryBoxes` / `newQueuedBoxes` are a DELTA: "boxes minted
// by THIS call". The client turns a non-empty delta into the "You earned a
// mystery box!" toast (race_detail_screen.dart). With C3 on, the poll no longer
// mints — the race-keyed worker does, moments later — so the delta would be
// permanently empty and the toast would silently die. (The box itself still
// shows up in `inventory`/`queuedBoxCount`; only the celebration was lost.)
//
// ── The fix ────────────────────────────────────────────────────────────────
// The worker RECORDS each mint under the minting user's key; the next
// `/progress` overlay CONSUMES the entries for the race being viewed and folds
// them back into the same two response fields, in the same shape. No API
// change, so frozen clients keep working unchanged. Cost: the toast is 2-15s
// later than it used to be (worker debounce + snapshot cadence).
//
// ── Why not GETDEL ─────────────────────────────────────────────────────────
// The key is per USER (a user can be in several races, and the worker resolves
// each race independently), while a consume is per (user, RACE). A GETDEL would
// hand race A's poll the toast that belongs to race B and then throw it away —
// the toast would be lost exactly as before, just less predictably. So the
// consume is a Lua filter: it removes and returns ONLY the viewed race's
// entries and writes the remainder back, atomically, in one round trip. That
// atomicity is also what makes two concurrent polls toast a mint AT MOST ONCE.
//
// ── Failure behavior ───────────────────────────────────────────────────────
// Redis off, unreachable, or the flag off => empty fields. Never an error: this
// is a celebration, not state. The 60s TTL bounds an entry nobody collects.

const redisCache = require("../../../shared/cache/redisCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");
const {
  appSettings: defaultAppSettings,
} = require("../../../shared/config/appSettings");

const TTL_SECONDS = 60;
// A generous cap on unconsumed entries per user. Reaching it means nobody has
// opened race detail in a minute, in which case the oldest toast is the one
// worth dropping.
const MAX_ENTRIES = 50;

const EMPTY = { newMysteryBoxes: [], newQueuedBoxes: 0 };

// Append-not-overwrite: several races can mint between two polls of any one of
// them, and each worker run only knows about its own race.
const APPEND_LUA = `
local raw = redis.call("get", KEYS[1])
local list = {}
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == "table" then list = decoded end
end
local add = cjson.decode(ARGV[1])
for i = 1, #add do list[#list + 1] = add[i] end
local cap = tonumber(ARGV[3])
while #list > cap do table.remove(list, 1) end
redis.call("set", KEYS[1], cjson.encode(list), "EX", ARGV[2])
return #list
`;

// Remove-and-return the entries for ONE race, write the remainder back.
const CONSUME_LUA = `
local raw = redis.call("get", KEYS[1])
if not raw then return nil end
local ok, list = pcall(cjson.decode, raw)
if not ok or type(list) ~= "table" then
  redis.call("del", KEYS[1])
  return nil
end
local taken = {}
local rest = {}
for i = 1, #list do
  if list[i].raceId == ARGV[1] then
    taken[#taken + 1] = list[i]
  else
    rest[#rest + 1] = list[i]
  end
end
if #taken == 0 then return nil end
if #rest == 0 then
  redis.call("del", KEYS[1])
else
  redis.call("set", KEYS[1], cjson.encode(rest), "EX", ARGV[2])
end
return cjson.encode(taken)
`;

function buildRecentBoxMints(dependencies = {}) {
  const settings = dependencies.appSettings || defaultAppSettings;
  const cache = dependencies.redisCache || redisCache;
  const now = dependencies.now || (() => new Date());

  // The same two-condition gate the rest of C3 uses: `REDIS_URL` set AND the
  // app setting on. With the flag off the endpoint still mints inline and
  // reports the delta itself, so recording here would be dead weight.
  async function enabled() {
    if (dependencies.redisStandingsEnabled != null) {
      return dependencies.redisStandingsEnabled === true;
    }
    if (!cache.isEnabled()) return false;
    try {
      return (await settings.getFlag("redisStandingsEnabled")) === true;
    } catch {
      return false;
    }
  }

  /**
   * Record one worker sync's mints for one user. Safe to call with an empty
   * result — it writes nothing.
   *
   * @param {object} args
   * @param {string} args.userId  the user the boxes were minted for
   * @param {string} args.raceId
   * @param {{newMysteryBoxes?: any[], newQueuedBoxes?: number}} args.syncResult
   *   exactly what `syncRacePowerupState` returned.
   * @returns {Promise<boolean>} true when something was stored.
   */
  async function record({ userId, raceId, syncResult }) {
    if (!userId || !raceId || !syncResult) return false;
    const boxes = Array.isArray(syncResult.newMysteryBoxes)
      ? syncResult.newMysteryBoxes
      : [];
    const queued = Number(syncResult.newQueuedBoxes) || 0;
    if (boxes.length === 0 && queued <= 0) return false;
    if (!(await enabled())) return false;

    const mintedAt = now().toISOString();
    const entries = [
      // One entry per box, carrying the box object verbatim: the response field
      // is the box list itself, so anything less would change its shape.
      ...boxes.map((box) => ({ raceId, mintedAt, box })),
      // Queued mints have no box to show — the client only counts them.
      ...Array.from({ length: queued }, () => ({ raceId, mintedAt, queued: true })),
    ];

    try {
      const { ok } = await cache.evalLua(
        APPEND_LUA,
        [cacheKeys.userRecentMints(userId)],
        [JSON.stringify(entries), String(TTL_SECONDS), String(MAX_ENTRIES)]
      );
      return ok === true;
    } catch {
      return false;
    }
  }

  /**
   * Atomically take this viewer's unreported mints FOR THIS RACE. Entries for
   * other races are left in place for those races' own next poll.
   *
   * @returns {Promise<{newMysteryBoxes: any[], newQueuedBoxes: number}>}
   *   always the today-shape object; empty on miss, Redis error, or flag off.
   */
  async function consume({ userId, raceId }) {
    if (!userId || !raceId) return { ...EMPTY };
    if (!cache.isEnabled()) return { ...EMPTY };
    let raw;
    try {
      const result = await cache.evalLua(
        CONSUME_LUA,
        [cacheKeys.userRecentMints(userId)],
        [String(raceId), String(TTL_SECONDS)]
      );
      if (!result.ok || result.result == null) return { ...EMPTY };
      raw = result.result;
    } catch {
      return { ...EMPTY };
    }

    let taken;
    try {
      taken = JSON.parse(raw);
    } catch {
      return { ...EMPTY };
    }
    if (!Array.isArray(taken)) return { ...EMPTY };

    return {
      newMysteryBoxes: taken.filter((e) => e && e.box).map((e) => e.box),
      newQueuedBoxes: taken.filter((e) => e && e.queued === true).length,
    };
  }

  /** Test/ops helper: what is pending for a user right now (non-destructive). */
  async function peek(userId) {
    const value = await cache.getJSON(cacheKeys.userRecentMints(userId));
    return Array.isArray(value) ? value : [];
  }

  return { record, consume, peek, enabled, TTL_SECONDS, MAX_ENTRIES };
}

const recentBoxMints = buildRecentBoxMints();

module.exports = { buildRecentBoxMints, recentBoxMints, TTL_SECONDS, MAX_ENTRIES };
