const { prisma: defaultPrisma } = require('../../../db');
const { prorateSamplesIntoWindow } = require('../../steps/models/stepSample');
const { readEventRecap, finalizeEventRecap } = require('./eventRecap');
const MAX_SAMPLES = 1000;

async function finalizeLegacyEventRecap({ prisma = defaultPrisma, userId, now: clock = () => new Date() }) {
  const now = typeof clock === 'function' ? clock() : new Date(clock);
  const candidate = await readEventRecap({ prisma, userId, now });
  if (candidate.state !== 'pending') return;
  const { event } = candidate;
  const rows = await prisma.$queryRawUnsafe(`SELECT period_start AS start,period_end AS "end",steps
    FROM step_samples WHERE user_id=$1 AND period_end>$2 AND period_start<$3
    ORDER BY period_start,period_end LIMIT $4`, userId, event.startsAt, event.endsAt, MAX_SAMPLES + 1);
  if (!rows.length || rows.length > MAX_SAMPLES) return;
  let coveredThrough = new Date(event.startsAt).getTime();
  let previousEnd = null;
  for (const row of rows) {
    const start = new Date(row.start).getTime(), end = new Date(row.end).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > now.getTime() ||
        !Number.isInteger(row.steps) || row.steps < 0 || start > coveredThrough ||
        (previousEnd !== null && start < previousEnd)) return;
    previousEnd = end;
    coveredThrough = end;
  }
  if (coveredThrough < new Date(event.endsAt).getTime()) return;
  const rawSteps = prorateSamplesIntoWindow(rows, new Date(event.startsAt).getTime(), new Date(event.endsAt).getTime());
  await finalizeEventRecap({ prisma, userId, now: clock, input: { eventId: event.id, revision: event.revision, rawSteps } });
}
module.exports = { finalizeLegacyEventRecap, MAX_SAMPLES };
