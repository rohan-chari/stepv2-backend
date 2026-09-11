const efficiency = require('../../../shared/cache/cacheEfficiencyInvalidation');
async function entitlementsChanged(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return;
  await efficiency.afterCommit(ids.flatMap(identity => [
    { domain: 'entitlement', identity }, { domain: 'summary', identity },
  ]));
  const { deferUntilAfterCommitBatch } = require('../../../db');
  if (require('../../../shared/cache/redisCache').isEnabled()) {
    await deferUntilAfterCommitBatch('entitlement-race-display', ids, async (users) => {
      const unique = [...new Set(users)];
      const { prisma } = require('../../../db');
      const raceIds = new Set();
      try {
        // Entitlement changes are low-frequency batched worker/timezone writes.
        // Start from indexed participant.user_id, never add this to step noops.
        for (let offset = 0; offset < unique.length; offset += 256) {
          const rows = await prisma.$queryRawUnsafe(`
            SELECT DISTINCT participant.race_id AS id
              FROM race_participants participant
              JOIN races race ON race.id=participant.race_id
             WHERE participant.user_id=ANY($1::text[])
               AND participant.status='accepted' AND race.status='active'
             LIMIT 10001`, unique.slice(offset, offset + 256));
          if (rows.length >= 10001) throw new Error('Entitlement race invalidation bound exceeded');
          for (const row of rows) raceIds.add(row.id);
          if (raceIds.size > 10000) throw new Error('Entitlement race invalidation bound exceeded');
        }
        await raceEventDisplayChanged([...raceIds]);
      } catch {
        // Failed or truncated discovery must never certify an incomplete set.
        await efficiency.advance([{ domain: 'event', identity: 'global' }]);
      }
    });
  }
  await deferUntilAfterCommitBatch('home-event-display', ids, async (users) => {
    const derived = require('../../../shared/cache/derivedCache');
    const keys = require('../../../shared/cache/cacheKeys');
    await derived.invalidate({
      keys: [...new Set(users)].map(id => keys.homeActiveGlobalEvent(id)),
      prefix: keys.PREFIX.HOME_ACTIVE_GLOBAL_EVENT,
    });
    await derived.invalidate({
      keys: [...new Set(users)].map(id => keys.homeImpactSummary(id)),
      prefix: keys.PREFIX.HOME_IMPACT_SUMMARY,
    });
  });
}
async function raceEventDisplayChanged(raceIds) {
  await efficiency.afterCommit([...new Set((raceIds || []).filter(Boolean))].map(identity => ({
    domain: 'event', identity,
  })));
}
module.exports = { entitlementsChanged, raceEventDisplayChanged };
