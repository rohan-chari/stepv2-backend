const { prisma: defaultPrisma } = require("../../../db");
const {
  appSettings: defaultAppSettings,
} = require("../../../shared/config/appSettings");
// Concrete-path imports, not the module indexes: this service is loaded from
// the enrollment command and the renewal cron, both of which sit inside the
// races module's own require cycle.
const { User } = require("../../users/models/user");
const {
  RacePowerupEvent,
} = require("../../powerups/models/racePowerupEvent");
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

// The UTC instant the inactivity window opens at `now`: the start of the ET day
// D-2. Exported so the auto-enroll flip's box-open query bounds on EXACTLY the
// instant the steps predicate does — one window, two data sources, no way for
// them to drift apart.
function inactivityWindowStart(now = new Date(), timeZone = SEED_TIMEZONE) {
  const today = etDayKey(now, timeZone);
  return etDayStart(addDaysToDateString(today, -2), timeZone);
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
  const dayMinus3 = addDaysToDateString(today, -3);

  const windowStart = inactivityWindowStart(now, timeZone); // = start of D-2
  const windowEnd = etDayStart(today, timeZone); // = end of D-1

  const [samples, dailyRows, users] = await Promise.all([
    // The old replay summed positive samples by periodStart's ET date. A
    // positive sample whose start lies in either completed day is equivalent,
    // including at DST boundaries; a sample starting before D-2 never counted.
    // EXISTS stops at the first match and returns at most one row per user.
    prisma.$queryRawUnsafe(`SELECT u.id AS "userId" FROM users u
      WHERE u.id=ANY($1::text[]) AND EXISTS (
        SELECT 1 FROM step_samples s WHERE s.user_id=u.id AND s.steps>0
          AND s.period_start >= $2::timestamp AND s.period_start < $3::timestamp
          AND s.period_end > $2::timestamp
      )`, ids, windowStart, windowEnd),
    // LOWER BOUND ONLY (spec §4.2.3): `steps.date` is a client-asserted local
    // date, so an active user in a timezone ahead of ET can key their activity
    // to D or even D+1. Any non-zero row from D-3 onward keeps them. Over-
    // keeping is safe; over-pruning would break an active frozen client.
    prisma.$queryRawUnsafe(`SELECT u.id AS "userId" FROM users u
      WHERE u.id=ANY($1::text[]) AND EXISTS (
        SELECT 1 FROM steps s WHERE s.user_id=u.id AND s.steps>0 AND s.date >= $2::date
      )`, ids, dateColumnBound(dayMinus3)),
    prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, createdAt: true, isReviewAccount: true },
    }),
  ]);

  const hasSampleActivity = new Set(samples.map((row) => row.userId));
  const hasDailyActivity = new Set(dailyRows.map((row) => row.userId));
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
    if (hasSampleActivity.has(userId)) continue;
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

// ── Auto-enroll flip for ghosts (batch 2026-08-10 item 1) ──────────────────
//
// The prune removes ghosts from a seeded race; the renewal cron then re-enrolls
// the very same accounts into the next one, forever. This closes that loop:
//
//   inactive-by-steps (filterInactiveUserIds, whose exemptions we therefore
//   inherit) AND zero MYSTERY_BOX_OPENED events since the window opened
//     => users.auto_join_featured_races = false
//
// A user who still opens boxes is engaged — maybe HealthKit is broken — so the
// flag stays on even though the steps-only prune still drops them from the race.
const MYSTERY_BOX_OPENED_EVENT = "MYSTERY_BOX_OPENED";

// pm2 logs rotate, so never dump an unbounded id list; the durable restore
// list is a SQL query over the flipped rows.
const FLIP_LOG_ID_CAP = 10;

// `userIds` is the OUTPUT of filterInactiveUserIds — the caller's ghost set.
// Returns the ids actually flipped (empty when the sub-switch is off, when
// everyone opened a box, or when the guard found nothing left to write).
// Idempotent: the `autoJoinFeaturedRaces: true` guard makes a repeat a no-op.
async function disableAutoEnrollForInactive({
  userIds,
  now = new Date(),
  prisma = defaultPrisma,
  timeZone = SEED_TIMEZONE,
  appSettings = defaultAppSettings,
  userModel = User,
  racePowerupEventModel = RacePowerupEvent,
  logger = console,
}) {
  const ids = [...new Set(userIds || [])];
  if (ids.length === 0) return [];

  // Sub-switch, checked here so all three hooks are covered by one read. It
  // only ever runs inside the prune hooks, so the parent prune switch is
  // already on by construction.
  if ((await appSettings.getFlag("seededInactivityAutoEnrollOffEnabled")) !== true) {
    return [];
  }

  // Deliberately NO upper bound: a box opened today — after the two-day steps
  // window closed — still protects the flag. Someone who opened a box an hour
  // ago is engaged, whatever their step data says.
  const engaged = await racePowerupEventModel.findActorIdsWithEventSince({
    userIds: ids,
    eventType: MYSTERY_BOX_OPENED_EVENT,
    since: inactivityWindowStart(now, timeZone),
    prisma,
  });

  const doomed = ids.filter((id) => !engaged.has(id));
  if (doomed.length === 0) return [];

  const flipped = await userModel.disableAutoJoinFeaturedRaces(doomed, { prisma });
  if (flipped.length > 0) {
    const shown = flipped.slice(0, FLIP_LOG_ID_CAP).join(", ");
    logger.log(
      `[CRON] Auto-enroll disabled for ${flipped.length} inactive user(s): ${shown}` +
        (flipped.length > FLIP_LOG_ID_CAP ? ", …" : "")
    );
  }
  return flipped;
}

module.exports = {
  filterInactiveUserIds,
  findUsersWithActivitySince,
  disableAutoEnrollForInactive,
  inactivityWindowStart,
  etDayKey,
  SEED_TIMEZONE,
};
