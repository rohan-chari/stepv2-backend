// Resolve the timezone whose calendar-day boundaries should bucket a race's
// steps. Seeded daily/weekly races carry a canonical `timezone` (e.g.
// "America/New_York") so that "midnight" is the same instant for every
// participant and the live display agrees with settlement. User-created races
// leave `timezone` NULL and fall back to the caller-supplied tz (the requester's
// header tz on the live path, "UTC" at settlement) — exactly the legacy behavior.
//
// Centralized so every scoring call site (getRaceProgress, raceExpiry,
// getHomeRaceCard, resolveRaceState) resolves it identically; a divergence here
// would re-introduce the live-vs-settlement mismatch this exists to prevent.
function raceTimeZone(race, fallback) {
  const tz = race && typeof race.timezone === "string" ? race.timezone.trim() : "";
  return tz || fallback;
}

module.exports = { raceTimeZone };
