const { prisma } = require('../../../db');
const { readFragment } = require('../../../shared/cache/cacheEfficiencyRead');
const { GlobalStepEvent } = require('../models/globalStepEvent');
function valid(value) {
  return value && Object.keys(value).sort().join(',') === 'endsAt,eventId,kind,multiplier,nextBoundaryAt' &&
    ['empty', 'event'].includes(value.kind) &&
    (value.nextBoundaryAt === null || Number.isFinite(Date.parse(value.nextBoundaryAt))) &&
    (value.kind === 'empty' ? value.eventId === null && value.endsAt === null && value.multiplier === null :
      typeof value.eventId === 'string' && Number.isFinite(value.multiplier) && Number.isFinite(Date.parse(value.endsAt)));
}
async function read({ userId, raceId, timeZone, now, eligibleLocal }) {
  const loaded = await readFragment({ kind: 'event',
    key: `ce:v1:event-display:${raceId}:${userId}:${encodeURIComponent(timeZone || 'UTC')}:${eligibleLocal ? 'eligible' : 'inactive'}`,
    markers: [{ domain: 'entitlement', identity: userId }, { domain: 'event', identity: raceId },
      { domain: 'event', identity: 'global' }, { domain: 'race-members', identity: raceId }],
    validate: valid,
    ttlMs: value => Math.max(0, Math.min(30000,
      value.nextBoundaryAt ? Date.parse(value.nextBoundaryAt) - now.getTime() : 30000,
      value.endsAt ? Date.parse(value.endsAt) - now.getTime() : 30000)),
    load: async () => {
      // Keep the current model's eligibility and ordering rules. This envelope
      // is used only by authenticated display, never by scoring/admission.
      const local = eligibleLocal ? await GlobalStepEvent.findViewerActive({ userId, raceId, now }) : null;
      const event = local || await GlobalStepEvent.findActiveAt(now);
      const canStore = require('../../../shared/cache/redisCache').isEnabled() &&
        !require('../../../shared/cache/derivedCache').isBypassed('ce:v1:');
      const [boundary] = canStore ? await prisma.$queryRawUnsafe(`
        SELECT min(boundary) AS "nextBoundaryAt" FROM (
          SELECT starts_at AS boundary FROM global_step_events
          WHERE schedule_mode='LEGACY_GLOBAL' AND starts_at > $1
          UNION ALL
          SELECT starts_at FROM global_step_event_entitlements
          WHERE user_id=$2 AND starts_at > $1
        ) upcoming`, now, userId) : [{ nextBoundaryAt: null }];
      return { kind: event ? 'event' : 'empty', eventId: event ? event.eventId || event.id : null,
        multiplier: event ? Number(event.multiplier) : null, endsAt: event ? new Date(event.endsAt).toISOString() : null,
        nextBoundaryAt: boundary.nextBoundaryAt?.toISOString() ?? null };
    },
  });
  const value = loaded.value;
  return value.kind === 'event' ? { active: true, multiplier: value.multiplier, endsAt: value.endsAt } : null;
}
module.exports = { read };
