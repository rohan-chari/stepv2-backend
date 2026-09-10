// Internal release-B proof. Redis contains reconstructible display data only.
// Release A rotates these identities before returning committed mutations.
const { capture, unchanged } = require('../../../shared/cache/cacheEfficiencyRead');
const { markerKey } = require('../../../shared/cache/cacheEfficiencyInvalidation');
const redis = require('../../../shared/cache/redisCache');
const derived = require('../../../shared/cache/derivedCache');
const metrics = require('../../../shared/observability/cacheEfficiencyMetrics');
const { multiplierBoundaries } = require('./effectMultiplier');
const TOKEN = /^[a-f0-9-]{36}$/;
function markers(raceId) {
  return [
    { domain: 'event', identity: 'global' },
    { domain: 'event', identity: raceId },
    { domain: 'race-members', identity: raceId },
    { domain: 'race-meta', identity: raceId },
    { domain: 'race-effects', identity: raceId },
  ];
}
function fenceFor(raceId, tokens) {
  return { keys: markers(raceId).map(({ domain, identity }) => markerKey(domain, identity)), tokens };
}
function validInput(input) {
  return input?.v === 1 && typeof input.scoredAt === 'string' && Number.isFinite(Date.parse(input.scoredAt)) &&
    Array.isArray(input.tokens) && input.tokens.length === 5 && input.tokens.every(token => typeof token === 'string' && TOKEN.test(token)) &&
    Object.prototype.hasOwnProperty.call(input, 'nextEffectBoundaryAt') &&
    (input.nextEffectBoundaryAt === null || (typeof input.nextEffectBoundaryAt === 'string' && Number.isFinite(Date.parse(input.nextEffectBoundaryAt)))) &&
    Object.keys(input).every(key => ['v', 'scoredAt', 'tokens', 'nextEffectBoundaryAt'].includes(key));
}
async function captureInputs(raceId, observedAt) {
  if (!redis.isEnabled() || derived.isBypassed('ce:v1:')) return null;
  metrics.count('standings', 'redis');
  const fence = await capture(markers(raceId));
  return fence ? { tokens: fence.tokens, capturedAt: new Date(observedAt).toISOString() } : null;
}
function scoredInput(captured, result) {
  if (!captured || !result) return null;
  const scoredAt = new Date(result.displayCapture?.asOf || captured.capturedAt).toISOString();
  const asOf = Date.parse(scoredAt);
  const effects = result.displayCapture?.activeEffects || [];
  const dates = effects.flatMap(effect => [effect.startsAt, effect.expiresAt])
    .filter(value => value != null).map(value => new Date(value).getTime());
  if (dates.some(value => !Number.isFinite(value))) return null;
  // The canonical helper handles intra-effect phases. Generic start/end bounds
  // cover non-multiplier effects as well (privacy, slots, defence, and copies).
  const horizon = dates.reduce((latest, value) => Math.max(latest, value), asOf + 1);
  const phases = multiplierBoundaries(asOf, horizon, {
    campfires: effects.filter(effect => effect.type === 'CAMPFIRE_REST'),
    ghostPeppers: effects.filter(effect => effect.type === 'GHOST_PEPPER'),
  });
  const future = [...dates, ...phases.filter(value => value < horizon)].filter(value => value > asOf);
  return { v: 1, scoredAt, tokens: captured.tokens,
    nextEffectBoundaryAt: future.length ? new Date(future.reduce((earliest, value) => Math.min(earliest, value), Infinity)).toISOString() : null };
}
function validProof(proof, asOf) {
  return proof?.v === 1 && typeof proof.scoredAt === 'string' && proof.scoredAt === asOf &&
    Number.isFinite(Date.parse(asOf)) && Array.isArray(proof.tokens) && proof.tokens.length === 5 &&
    proof.tokens.every(token => typeof token === 'string' && TOKEN.test(token)) &&
    Object.prototype.hasOwnProperty.call(proof, 'nextBoundaryAt') &&
    (proof.nextBoundaryAt === null || (typeof proof.nextBoundaryAt === 'string' &&
      Number.isFinite(Date.parse(proof.nextBoundaryAt)) && Date.parse(proof.nextBoundaryAt) > Date.parse(asOf))) &&
    Object.keys(proof).every(key => ['v', 'scoredAt', 'tokens', 'nextBoundaryAt'].includes(key));
}
function timeIsCurrent(proof, asOf, nowMs = Date.now()) {
  return validProof(proof, asOf) && nowMs >= Date.parse(asOf) &&
    (proof.nextBoundaryAt === null || nowMs < Date.parse(proof.nextBoundaryAt));
}
async function current(raceId, proof, asOf, nowMs = Date.now()) {
  if (!proof) { metrics.read('standings', 'missing'); return false; }
  if (!validProof(proof, asOf)) { metrics.read('standings', 'malformed'); return false; }
  if (!timeIsCurrent(proof, asOf, nowMs)) { metrics.read('standings', 'boundary'); return false; }
  if (!redis.isEnabled() || derived.isBypassed('ce:v1:')) { metrics.read('standings', 'bypass'); return false; }
  metrics.count('standings', 'redis');
  const valid = await unchanged(fenceFor(raceId, proof.tokens));
  if (!valid) metrics.read('standings', 'generation');
  return valid && !derived.isBypassed('ce:v1:');
}
async function build({ raceId, input, race, prisma }) {
  if (!validInput(input) || !redis.isEnabled() || derived.isBypassed('ce:v1:')) return null;
  // An ACTIVE row awaiting expiry settlement cannot certify a post-end score.
  if (race?.endsAt != null && (!Number.isFinite(new Date(race.endsAt).getTime()) ||
      new Date(race.endsAt).getTime() <= Date.parse(input.scoredAt))) return null;
  const fence = fenceFor(raceId, input.tokens);
  if (!(await unchanged(fence))) return null;
  metrics.count('standings', "source_loads");
  // One bounded result, no participant/event objects hydrated. > scoredAt is
  // intentional: a deferred task must also discover boundaries already crossed
  // while it waited. PENDING local entitlements are future display inputs.
  const rows = await prisma.$queryRawUnsafe(`/* steps:prepared-read:v1 */
    SELECT MIN(boundary) AS "nextBoundaryAt" FROM (
      SELECT starts_at AS boundary FROM global_step_events
       WHERE schedule_mode='LEGACY_GLOBAL' AND starts_at > $2::timestamp
      UNION ALL SELECT ends_at FROM global_step_events
       WHERE schedule_mode='LEGACY_GLOBAL' AND ends_at > $2::timestamp
      UNION ALL SELECT entitlement.starts_at FROM global_step_event_entitlements entitlement
       JOIN race_participants participant ON participant.user_id=entitlement.user_id
       JOIN global_step_events event ON event.id=entitlement.event_id
       WHERE participant.race_id=$1 AND participant.status='accepted'
         AND event.schedule_mode='LOCAL_ENTITLEMENTS'
         AND entitlement.start_outcome IN ('PENDING','ACTIVATED_ON_TIME','ACTIVATED_LATE_JOIN')
         AND entitlement.starts_at > $2::timestamp
      UNION ALL SELECT entitlement.ends_at FROM global_step_event_entitlements entitlement
       JOIN race_participants participant ON participant.user_id=entitlement.user_id
       JOIN global_step_events event ON event.id=entitlement.event_id
       WHERE participant.race_id=$1 AND participant.status='accepted'
         AND event.schedule_mode='LOCAL_ENTITLEMENTS'
         AND entitlement.start_outcome IN ('PENDING','ACTIVATED_ON_TIME','ACTIVATED_LATE_JOIN')
         AND entitlement.ends_at > $2::timestamp
    ) display_boundary_proof`, raceId, input.scoredAt);
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const values = [rows[0].nextBoundaryAt, input.nextEffectBoundaryAt, race?.endsAt]
    .filter(value => value != null).map(value => new Date(value).getTime());
  if (values.some(value => !Number.isFinite(value))) return null;
  const future = values.filter(value => value > Date.parse(input.scoredAt));
  const proof = { v: 1, scoredAt: input.scoredAt, tokens: input.tokens,
    nextBoundaryAt: future.length ? new Date(future.reduce((earliest, value) => Math.min(earliest, value), Infinity)).toISOString() : null };
  return await current(raceId, proof, input.scoredAt) ? proof : null;
}
module.exports = { captureInputs, scoredInput, validInput, validProof, timeIsCurrent, current, build, fenceFor };
