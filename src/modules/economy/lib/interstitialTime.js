const formatterCache = new Map();

function dateFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function localDateKey(instant, timeZone) {
  const parts = dateFormatter(timeZone).formatToParts(instant);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function nextCalendarDate(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

// Find the first real UTC instant belonging to the next local calendar date.
// Searching by the monotonic local date key, rather than assuming a fixed
// offset or a 24-hour day, handles DST gaps/folds and historical offset jumps.
function nextLocalMidnight(instant, timeZone) {
  const target = nextCalendarDate(localDateKey(instant, timeZone));
  let low = instant.getTime();
  let high = low + 72 * 60 * 60 * 1000;
  while (localDateKey(new Date(high), timeZone) < target) {
    high += 24 * 60 * 60 * 1000;
  }
  while (low + 1 < high) {
    const midpoint = low + Math.floor((high - low) / 2);
    if (localDateKey(new Date(midpoint), timeZone) < target) {
      low = midpoint;
    } else {
      high = midpoint;
    }
  }
  return new Date(high);
}

function capDateValue(dateKey) {
  return new Date(`${dateKey}T00:00:00.000Z`);
}

module.exports = { localDateKey, nextLocalMidnight, capDateValue };
