const { prisma: defaultPrisma } = require("../../../db");
const {
  addDaysToDateString,
  formatDateString,
  getTimeZoneParts,
  parseDateString,
  zonedDateTimeToUtc,
} = require("../../../shared/time/week");

// The inactivity predicate behind the seeded-challenge prune (spec §4.2). One
// implementation shared by all three hook points (enrollment filter, promotion
// prune, weekly mid-race sweep) so they can never disagree about who is a ghost.
//
// A user is INACTIVE at instant `t` iff, for BOTH of the two most recent
// COMPLETED ET calendar days,
//
//     max( sum(step_samples in that ET day), any steps-daily-row ?? 0 ) == 0
//
// and none of the exemptions apply. Absence of data reads as zero on purpose:
// clients drop zero-step buckets at the source and only write a daily row when
// a sync runs, so a user who hasn't opened the app in two days has no rows at
// all. New accounts are therefore protected by createdAt, never by data
// presence.
//
// Three bulk queries, never per-user: this runs over the whole opted-in
// population on every seeded-race creation.

const SEED_TIMEZONE = "America/New_York";

function etDayKey(date, timeZone = SEED_TIMEZONE) {
  const parts = getTimeZoneParts(date, timeZone);
  return formatDateString(parts.year, parts.month, parts.day);
}

// The UTC instant at which the ET calendar day `dayKey` begins (DST-exact).
function etDayStart(dayKey, timeZone = SEED_TIMEZONE) {
  const { year, month, day } = parseDateString(dayKey);
  return zonedDateTimeToUtc(
    { year, month, day, hour: 0, minute: 0, second: 0 },
    timeZone
  );
}

// `steps.date` is a @db.Date holding a client-asserted LOCAL calendar date, so
// its bounds must be calendar dates at UTC midnight — NOT the 04:00/05:00Z
// ET-window instants, which would silently exclude the boundary row.
function dateColumnBound(dayKey) {
  return new Date(`${dayKey}T00:00:00.000Z`);
}

function sumByUserAndDay(samples, timeZone) {
  const totals = new Map();
  for (const sample of samples) {
    const steps = sample.steps || 0;
    if (steps <= 0) continue;
    const dayKey = etDayKey(new Date(sample.periodStart), timeZone);
    const key = `${sample.userId}|${dayKey}`;
    totals.set(key, (totals.get(key) || 0) + steps);
  }
  return totals;
}

// The subset of `userIds` that fails the two-day predicate. Returns a Set so
// callers can filter/deleteMany without a second pass.
//
// `raceCreatedAt` (promotion prune + weekly sweep only) exempts accounts born
// after the race row was minted: the weekly's PENDING row exists up to 7 days
// before it starts, and signup auto-enroll promised those users a spot in it.
async function filterInactiveUserIds({
  userIds,
  now = new Date(),
  raceCreatedAt = null,
  prisma = defaultPrisma,
  timeZone = SEED_TIMEZONE,
}) {
  const ids = [...new Set(userIds || [])];
  if (ids.length === 0) return new Set();

  // D is the ET calendar date of `now` — never now.toISOString(), which is
  // already D+1 after 20:00 ET.
  const today = etDayKey(now, timeZone);
  const dayMinus1 = addDaysToDateString(today, -1);
  const dayMinus2 = addDaysToDateString(today, -2);
  const dayMinus3 = addDaysToDateString(today, -3);

  const windowStart = etDayStart(dayMinus2, timeZone);
  const windowEnd = etDayStart(today, timeZone); // = end of D-1

  const [samples, dailyRows, users] = await Promise.all([
    // Same overlap predicate the per-user sample sums use; bucketing is by
    // periodStart's ET day, which is all a binary zero/non-zero signal needs.
    prisma.stepSample.findMany({
      where: {
        userId: { in: ids },
        periodEnd: { gt: windowStart },
        periodStart: { lt: windowEnd },
      },
      select: { userId: true, periodStart: true, steps: true },
    }),
    // LOWER BOUND ONLY (spec §4.2.3): `steps.date` is a client-asserted local
    // date, so an active user in a timezone ahead of ET can key their activity
    // to D or even D+1. Any non-zero row from D-3 onward keeps them. Over-
    // keeping is safe; over-pruning would break an active frozen client.
    prisma.step.findMany({
      where: {
        userId: { in: ids },
        date: { gte: dateColumnBound(dayMinus3) },
      },
      select: { userId: true, steps: true },
    }),
    prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, createdAt: true, isReviewAccount: true },
    }),
  ]);

  const sampleTotals = sumByUserAndDay(samples, timeZone);
  const hasDailyActivity = new Set(
    dailyRows.filter((row) => (row.steps || 0) > 0).map((row) => row.userId)
  );
  const usersById = new Map(users.map((user) => [user.id, user]));

  const inactive = new Set();
  for (const userId of ids) {
    const user = usersById.get(userId);
    // An id with no user row is not something to delete on.
    if (!user) continue;
    if (user.isReviewAccount === true) continue;
    if (user.createdAt && user.createdAt.getTime() >= windowStart.getTime()) continue;
    if (
      raceCreatedAt &&
      user.createdAt &&
      user.createdAt.getTime() >= new Date(raceCreatedAt).getTime()
    ) {
      continue;
    }
    if (hasDailyActivity.has(userId)) continue;
    if ((sampleTotals.get(`${userId}|${dayMinus1}`) || 0) > 0) continue;
    if ((sampleTotals.get(`${userId}|${dayMinus2}`) || 0) > 0) continue;
    inactive.add(userId);
  }
  return inactive;
}

// The subset of `userIds` with ANY step activity at or after `since` — the
// weekly sweep's ghost guard (D4). Same two data sources as the predicate, so a
// racer who walked early in the week is never mistaken for a ghost even if
// their persisted RaceParticipant.totalSteps hasn't caught up.
async function findUsersWithActivitySince({
  userIds,
  since,
  prisma = defaultPrisma,
  timeZone = SEED_TIMEZONE,
}) {
  const ids = [...new Set(userIds || [])];
  if (ids.length === 0 || !since) return new Set();

  const from = new Date(since);
  const [samples, dailyRows] = await Promise.all([
    prisma.stepSample.findMany({
      where: { userId: { in: ids }, periodStart: { gte: from } },
      select: { userId: true, steps: true },
    }),
    prisma.step.findMany({
      where: {
        userId: { in: ids },
        date: { gte: dateColumnBound(etDayKey(from, timeZone)) },
      },
      select: { userId: true, steps: true },
    }),
  ]);

  const active = new Set();
  for (const row of [...samples, ...dailyRows]) {
    if ((row.steps || 0) > 0) active.add(row.userId);
  }
  return active;
}

module.exports = {
  filterInactiveUserIds,
  findUsersWithActivitySince,
  etDayKey,
  SEED_TIMEZONE,
};
