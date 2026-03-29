const validTimezones = new Set();
const invalidTimezones = new Set();

function isValidTimeZone(tz) {
  if (!tz || typeof tz !== "string") return false;
  if (validTimezones.has(tz)) return true;
  if (invalidTimezones.has(tz)) return false;

  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    validTimezones.add(tz);
    return true;
  } catch {
    invalidTimezones.add(tz);
    return false;
  }
}

function extractTimezone(req, res, next) {
  const header = req.headers["x-timezone"];
  req.timeZone = isValidTimeZone(header) ? header : "America/New_York";
  next();
}

module.exports = { extractTimezone };
