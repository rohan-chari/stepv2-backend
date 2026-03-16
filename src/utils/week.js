const WEEKDAY_INDEX = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getTimeZoneParts(date, timeZone = "America/New_York") {
  const formatter = new Intl.DateTimeFormat("en-US", {
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

function parseOffsetMinutes(offset) {
  const match = offset.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] || 0);
  return sign * (hours * 60 + minutes);
}

function getOffsetMinutes(date, timeZone = "America/New_York") {
  const formatter = new Intl.DateTimeFormat("en-US", {
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

module.exports = {
  getMondayOfWeek,
  getNextMonday9amNewYork,
};
