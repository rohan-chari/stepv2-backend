const { randomUUID } = require('node:crypto');
const { AppError } = require('../../../shared/errors/AppError');
const { computeSummaryExpiresAt } = require('./eventRecapExpiry');
const { prisma: defaultPrisma } = require('../../../db');

const NONE = Object.freeze({ state: 'none' });
const FIELDS = `e.id,e.event_id AS "eventId",e.user_id AS "userId",e.starts_at AS "startsAt",
  e.ends_at AS "endsAt",e.local_date AS "localDate",e.timezone,e.schedule_revision AS revision,
  e.recap_race_count AS "raceCount",e.recap_count_policy_version AS policy,
  e.recap_window_revision AS "windowRevision"`;
async function latest(db, userId, now) {
  const [row] = await db.$queryRawUnsafe(`SELECT ${FIELDS}
    FROM global_step_event_entitlements e JOIN global_step_events p ON p.id=e.event_id
    WHERE e.user_id=$1 AND e.ends_at<=$2 AND p.multiplier=2 AND p.schedule_mode='LOCAL_ENTITLEMENTS'
    ORDER BY e.ends_at DESC,e.id DESC LIMIT 1`, userId, now);
  return row;
}
async function saved(db, userId, eventId) {
  const [row] = await db.$queryRawUnsafe(`SELECT id,event_id AS "eventId",extra_race_steps AS "extraRaceSteps",
    race_count AS "raceCount",settled_at AS "settledAt",expires_at AS "expiresAt",
    acknowledged_at AS "acknowledgedAt",suppressed FROM event_recaps WHERE user_id=$1 AND event_id=$2`, userId, eventId);
  return row;
}
function ready(row, now) {
  const validForMs = new Date(row.expiresAt).getTime() - now.getTime();
  if (row.acknowledgedAt || row.suppressed || row.extraRaceSteps <= 0 || validForMs <= 0) return NONE;
  const { acknowledgedAt, suppressed, ...value } = row;
  return { state: 'ready', globalEventSummary: { ...value, validForMs } };
}
function stampValid(row) {
  return row.policy === 1 && Number.isInteger(row.raceCount) && row.raceCount >= 0 && row.windowRevision === row.revision;
}
async function readEventRecap({ prisma = defaultPrisma, userId, now: clock = () => new Date() }) {
  const time = () => typeof clock === 'function' ? clock() : new Date(clock);
  const row = await latest(prisma, userId, time());
  if (!row) return NONE;
  const result = await saved(prisma, userId, row.eventId);
  const now = time();
  if (result) return ready(result, now);
  const expiresAt = computeSummaryExpiresAt(row);
  if (!expiresAt || expiresAt <= now || !stampValid(row)) return NONE;
  return { state: 'pending', event: { id: row.eventId, revision: row.revision,
    startsAt: row.startsAt, endsAt: row.endsAt, expiresAt, raceCount: row.raceCount } };
}
async function invalidateEventRecap(userId) {
  const cacheKeys = require('../../../shared/cache/cacheKeys');
  await require('../../../shared/cache/cacheEfficiencyInvalidation').afterCommit([{ domain: 'summary', identity: userId }]);
  await require('../../../shared/cache/derivedCache').invalidate({
    keys: [cacheKeys.homeImpactSummary(userId)], prefix: cacheKeys.PREFIX.HOME_IMPACT_SUMMARY,
  });
}
async function finalizeEventRecap({ prisma = defaultPrisma, userId, input, now: clock = () => new Date() }) {
  if (!input || typeof input.eventId !== 'string' || !input.eventId ||
      !Number.isInteger(input.revision) || input.revision < 0 ||
      !Number.isSafeInteger(input.rawSteps) || input.rawSteps < 0 || input.rawSteps > 2147483647) {
    throw new AppError('Invalid recap input', 'INVALID_INPUT', 400);
  }
  const result = await prisma.$transaction(async tx => {
    // Lock the authoritative entitlement, not a race/worker row. Concurrent
    // devices serialize at this small caller-only boundary.
    const [row] = await tx.$queryRawUnsafe(`SELECT ${FIELDS},p.multiplier,p.schedule_mode AS mode
      FROM global_step_event_entitlements e JOIN global_step_events p ON p.id=e.event_id
      WHERE e.event_id=$1 AND e.user_id=$2 FOR UPDATE OF e`, input.eventId, userId);
    if (!row || row.multiplier !== 2 || row.mode !== 'LOCAL_ENTITLEMENTS') throw new AppError('Event not found', 'NOT_FOUND', 404);
    // Evaluate after the row lock: a request waiting across local midnight may
    // not commit against its arrival time. Routes pass their live clock seam.
    const now = typeof clock === 'function' ? clock() : new Date(clock);
    const existing = await saved(tx, userId, row.eventId);
    const current = await latest(tx, userId, now);
    const expiresAt = computeSummaryExpiresAt(row);
    if (existing) return current?.eventId === row.eventId ? ready(existing, typeof clock === 'function' ? clock() : new Date(clock)) : NONE;
    if (row.endsAt > now) throw new AppError('Event has not ended', 'EVENT_NOT_READY', 409);
    if (!expiresAt || expiresAt <= now || current?.eventId !== row.eventId) throw new AppError('Event expired', 'EVENT_EXPIRED', 410);
    if (input.revision !== row.revision || !stampValid(row)) throw new AppError('Event changed', 'EVENT_CHANGED', 409);
    const extra = input.rawSteps * row.raceCount;
    if (!Number.isSafeInteger(extra) || extra > 2147483647) throw new AppError('Recap count overflow', 'INVALID_INPUT', 400);
    const committingAt = typeof clock === 'function' ? clock() : new Date(clock);
    if (expiresAt <= committingAt) throw new AppError('Event expired', 'EVENT_EXPIRED', 410);
    await tx.$executeRawUnsafe(`INSERT INTO event_recaps
      (id,event_id,user_id,calculation_version,raw_steps,race_count,extra_race_steps,settled_at,expires_at,suppressed)
      VALUES ($1,$2,$3,'SIMPLE_RAW_V1',$4,$5,$6,$7,$8,$9) ON CONFLICT(event_id,user_id) DO NOTHING`,
    randomUUID(), row.eventId, userId, input.rawSteps, row.raceCount, extra, committingAt, expiresAt, extra === 0);
    return ready(await saved(tx, userId, row.eventId), typeof clock === 'function' ? clock() : new Date(clock));
  });
  await invalidateEventRecap(userId);
  return result;
}
module.exports = { readEventRecap, finalizeEventRecap, invalidateEventRecap };
