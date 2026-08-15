const WEEKDAY_INDEX = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// ── Intl.DateTimeFormat memoization ──────────────────────────────────────────
//
// Constructing an Intl.DateTimeFormat is expensive (ICU pattern + timezone rule
// lookup); calling `formatToParts` on an existing one is cheap. Race resolution
// calls through here once per participant per boundary, so a 440-person weekly
// resolve was constructing ~5,220 formatters per job. Memoizing cut that
// resolve's CPU roughly in half.
//
// SAFETY: a DateTimeFormat is a stateless, immutable function of (locale,
// options) — NOT of the instant being formatted. The same instance formats any
// Date correctly, including across DST transitions and in half-hour-offset
// zones, because the zone's transition rules live inside the formatter and are
// applied per call. See test/utils/weekFormatterCache.test.js, which pins that
// behavior so nobody "simplifies" the key and breaks tz handling.
//
// GROWTH: unbounded in principle, tiny in practice — the key space is
// (a handful of IANA zones) x (the two option sets literally written below).
// A size guard is kept anyway so a pathological caller passing user-supplied
// zone strings can never grow the process heap without bound.
const FORMATTER_CACHE = new Map();
const FORMATTER_CACHE_MAX = 500;

// Stable cache key: option entries are SORTED before serializing, so two
// option objects with the same pairs in a different literal order share an
// entry (and, more importantly, can never collide with a *different* set).
function formatterCacheKey(locale, options) {
  const entries = Object.entries(options)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `${locale}|${entries.map(([key, value]) => `${key}=${value}`).join("|")}`;
}

function getDateTimeFormat(locale, options) {
  const key = formatterCacheKey(locale, options);
  const cached = FORMATTER_CACHE.get(key);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat(locale, options);
  if (FORMATTER_CACHE.size >= FORMATTER_CACHE_MAX) FORMATTER_CACHE.clear();
  FORMATTER_CACHE.set(key, formatter);
  return formatter;
}

function getTimeZoneParts(date, timeZone = "America/New_York") {
  const formatter = getDateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(date);
  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return {
    weekday: values.weekday,
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function getMondayOfWeek(date = new Date(), timeZone = "America/New_York") {
  const parts = getTimeZoneParts(date, timeZone);
  const localDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const diff = (WEEKDAY_INDEX[parts.weekday] + 6) % 7;
  localDate.setUTCDate(localDate.getUTCDate() - diff);
  return localDate.toISOString().slice(0, 10);
}

function formatDateString(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDateString(value) {
  const [year, month, day] = value.split("-").map(Number);

  if (!year || !month || !day) {
    return null;
  }

  return { year, month, day };
}

function addDaysToDateString(value, days) {
  const parsed = parseDateString(value);

  if (!parsed) {
    return null;
  }

  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseOffsetMinutes(offset) {
  const match = offset.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] || 0);
  return sign * (hours * 60 + minutes);
}

function getOffsetMinutes(date, timeZone = "America/New_York") {
  const formatter = getDateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  });
  const offset = formatter
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;

  return parseOffsetMinutes(offset || "GMT+0");
}

function zonedDateTimeToUtc(
  { year, month, day, hour, minute, second = 0 },
  timeZone = "America/New_York"
) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  let offsetMinutes = getOffsetMinutes(new Date(utcGuess), timeZone);
  let timestamp = utcGuess - offsetMinutes * 60 * 1000;
  const correctedOffset = getOffsetMinutes(new Date(timestamp), timeZone);

  if (correctedOffset !== offsetMinutes) {
    timestamp = utcGuess - correctedOffset * 60 * 1000;
  }

  return new Date(timestamp);
}

function getNextMonday9amNewYork(
  date = new Date(),
  timeZone = "America/New_York"
) {
  const parts = getTimeZoneParts(date, timeZone);
  const localDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const weekday = WEEKDAY_INDEX[parts.weekday];
  let daysAhead = (8 - weekday) % 7;

  if (daysAhead === 0 && (parts.hour > 9 || (parts.hour === 9 && parts.minute > 0))) {
    daysAhead = 7;
  }

  if (daysAhead === 0 && parts.hour < 9) {
    daysAhead = 0;
  }

  localDate.setUTCDate(localDate.getUTCDate() + daysAhead);

  return zonedDateTimeToUtc(
    {
      year: localDate.getUTCFullYear(),
      month: localDate.getUTCMonth() + 1,
      day: localDate.getUTCDate(),
      hour: 9,
      minute: 0,
      second: 0,
    },
    timeZone
  ).toISOString();
}

// 00:00 (midnight) of `date`'s LOCAL calendar day in `timeZone`, as a UTC Date.
// Used to anchor seeded daily races to midnight ET. DST-correct: zonedDateTimeToUtc
// applies the offset in effect for that local midnight (EST vs EDT).
function startOfDayNewYork(date = new Date(), timeZone = "America/New_York") {
  const parts = getTimeZoneParts(date, timeZone);
  return zonedDateTimeToUtc(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone
  );
}

// 00:00 of the LOCAL day AFTER `date`'s local day in `timeZone`, as a UTC Date.
// This is the exact end boundary of a midnight-aligned daily race. DST-aware: a
// daily race is one CALENDAR day (23h on spring-forward, 25h on fall-back), not a
// fixed 24h offset, because both midnights are resolved through the tz.
function nextMidnightNewYork(date = new Date(), timeZone = "America/New_York") {
  const parts = getTimeZoneParts(date, timeZone);
  // Increment the local calendar day via a UTC anchor (handles month/year
  // rollover); zonedDateTimeToUtc then applies the correct offset for that day.
  const localDayAfter = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day)
  );
  localDayAfter.setUTCDate(localDayAfter.getUTCDate() + 1);
  return zonedDateTimeToUtc(
    {
      year: localDayAfter.getUTCFullYear(),
      month: localDayAfter.getUTCMonth() + 1,
      day: localDayAfter.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone
  );
}

// 00:00 Monday of `date`'s LOCAL week in `timeZone`, as a UTC Date. The start
// boundary of a midnight-aligned weekly race.
function startOfWeekNewYork(date = new Date(), timeZone = "America/New_York") {
  const monday = getMondayOfWeek(date, timeZone); // "YYYY-MM-DD"
  const { year, month, day } = parseDateString(monday);
  return zonedDateTimeToUtc(
    { year, month, day, hour: 0, minute: 0, second: 0 },
    timeZone
  );
}

// 00:00 of the NEXT Monday after `date`'s local week, as a UTC Date. The end
// boundary of the current weekly race / start boundary of the next one.
function nextWeekStartNewYork(date = new Date(), timeZone = "America/New_York") {
  const monday = getMondayOfWeek(date, timeZone);
  const nextMonday = addDaysToDateString(monday, 7);
  const { year, month, day } = parseDateString(nextMonday);
  return zonedDateTimeToUtc(
    { year, month, day, hour: 0, minute: 0, second: 0 },
    timeZone
  );
}

module.exports = {
  getDateTimeFormat,
  addDaysToDateString,
  formatDateString,
  getMondayOfWeek,
  getNextMonday9amNewYork,
  getTimeZoneParts,
  parseDateString,
  zonedDateTimeToUtc,
  startOfDayNewYork,
  nextMidnightNewYork,
  startOfWeekNewYork,
  nextWeekStartNewYork,
};
