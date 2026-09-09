#!/usr/bin/env node
// One-account support repair. Read-only preview by default; --apply requires
// explicit production approval under AGENTS.md. Started events stay immutable.
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config({ quiet: true });

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !/^--(db=(local|prod)|user-id=.+|apply)$/.test(arg))) {
    throw new Error('Usage: --db=local|prod --user-id=UUID [--apply]');
  }
  const target = args.find(arg => arg.startsWith('--db='))?.slice(5) || 'local';
  const userId = args.find(arg => arg.startsWith('--user-id='))?.slice(10);
  if (!userId) throw new Error('--user-id is required');
  if (target === 'prod') {
    if (!process.env.PROD_DATABASE_URL) throw new Error('PROD_DATABASE_URL is required');
    process.env.DATABASE_URL = process.env.PROD_DATABASE_URL;
  }
  if (target === 'local') {
    const url = new URL(process.env.DATABASE_URL || '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('--db=local requires a loopback database; use --db=prod explicitly for production');
    }
  }
  const { prisma } = require('../src/db');
  const { localEventWindowForZone } = require('../src/modules/steps/globalStepEvent');
  const { buildGlobalEventTimezoneReconciliation } = require('../src/modules/steps/services/globalEventTimezoneReconciliation');
  const { invalidateHomeActiveGlobalEvent } = require('../src/modules/steps/services/globalStepEventEntitlement');
  try {
    const current = new Date();
    const { user, rows } = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (!user.timezone || user.timezone !== user.globalEventTimezone) {
        throw new Error('Repair requires matching device and stable timezones');
      }
      const rows = [];
      let cursor = null;
      for (;;) {
        const page = await tx.globalStepEventEntitlement.findMany({
          where: { userId, timezone: { not: user.timezone }, startProcessedAt: null, endProcessedAt: null,
            startsAt: { gt: current }, event: { scheduleMode: 'LOCAL_ENTITLEMENTS' },
            ...(cursor ? { OR: [ { startsAt: { gt: cursor.startsAt } },
              { startsAt: cursor.startsAt, id: { gt: cursor.id } } ] } : {}),
          },
          include: { event: true }, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }], take: 100,
        });
        rows.push(...page);
        if (page.length < 100) break;
        cursor = page[page.length - 1];
      }
      return { user, rows };
    });
    const preview = rows.map(row => {
      const window = localEventWindowForZone({ eventDay: row.event.eventDay,
        localStartMinute: row.event.localStartMinute, durationMinutes: row.event.durationMinutes,
        timeZone: user.timezone });
      return { id: row.id, fromTimezone: row.timezone, toTimezone: user.timezone,
        oldStartsAt: row.startsAt, oldEndsAt: row.endsAt,
        newStartsAt: window.startsAt, newEndsAt: window.endsAt };
    });
    console.log(JSON.stringify({ target, userId, apply: args.includes('--apply'), candidates: preview }));
    if (args.includes('--apply')) {
      // The shared transaction rechecks future windows, activation, overlap,
      // race fences and worker readiness, then appends revised schedule events.
      const result = await buildGlobalEventTimezoneReconciliation()({
        user, observedTimezone: user.timezone, repairPending: true,
      });
      if (result?.relocated?.length) await invalidateHomeActiveGlobalEvent([user.id]);
      console.log(JSON.stringify({ deferred: Boolean(result?.deferred), relocated: result?.relocated || [] }));
    }
  } finally { await prisma.$disconnect(); }
}
main().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
