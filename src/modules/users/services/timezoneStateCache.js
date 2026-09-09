const crypto = require('node:crypto');
const redis = require('../../../shared/cache/redisCache');
const derived = require('../../../shared/cache/derivedCache');
const session = require('./authSessionUserCache');
const PREFIX = 'v1:user:timezone';
const TTL_SECONDS = 60;
const key = id => `${PREFIX}:${id}`;
const epochKey = id => `${key(id)}:epoch`;
// Epoch CAS prevents a read started before a timezone commit from refilling
// its old snapshot after invalidation. The epoch lives twice the value TTL.
async function read(id, load) {
  if (!redis.isEnabled() || derived.isBypassed?.(key(id))) return load();
  const started=Date.now();
  const observed = await redis.evalLua("return {redis.call('GET',KEYS[1]) or '',redis.call('GET',KEYS[2]) or ''}", [key(id),epochKey(id)]);
  if (!observed.ok) return load();
  const [cached, epoch] = observed.result;
  if (cached) {
    try { return JSON.parse(cached); } catch {}
  }
  const fresh = await load();
  if (fresh && Date.now()-started<TTL_SECONDS*1000) await redis.evalLua(`if (redis.call('GET',KEYS[2]) or '') == ARGV[1] then
    redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]); return 1 end return 0`,
    [key(id),epochKey(id)], [epoch,JSON.stringify(fresh),TTL_SECONDS]);
  return fresh;
}
async function invalidate(id) {
  session.invalidate(id);
  return derived.invalidate({ prefix:key(id), keys:[key(id)], run: async()=>{
    const result=await redis.evalLua("redis.call('SET',KEYS[2],ARGV[1],'EX',ARGV[2]); redis.call('DEL',KEYS[1]); return 1",[key(id),epochKey(id)],[crypto.randomUUID(),TTL_SECONDS*2]);
    return {ok:result.ok,disabled:result.disabled};
  }});
}
derived.onInvalidate(PREFIX,message=>{
  const id=(message?.key || message?.prefix || '').slice(PREFIX.length+1).split(':')[0];
  if(id) session.invalidate(id); else session.clear();
});
module.exports={read,invalidate,PREFIX,TTL_SECONDS};
