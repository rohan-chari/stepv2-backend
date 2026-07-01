const assert = require("node:assert/strict");
const test = require("node:test");

// ---------------------------------------------------------------------------
// Regression guard: box-progress TIMEZONE SPLIT ("summer solstice", Jul 2026).
//
// resolveRaceState reads races via Race.findActiveForUser (a LEAN `select`).
// raceTimeZone(race, fallback) returns race.timezone when present, else the
// fallback. Three race fields are read on that path and MUST be selected:
//
//  * timezone — box progress buckets days in raceTimeZone(race, "UTC"). With
//    timezone missing the sync path fell back to UTC while the display path
//    (findById includes timezone) used the race tz: evening-local steps were
//    double-counted (daily row + next-UTC-day samples), boxes minted off the
//    inflated basis, next_box ratcheted ahead, and the countdown clamped flat
//    at one full interval.
//  * endsAt — the guard that stops live-resolving a race past its end (the
//    raceExpiry cron owns settlement) reads race.endsAt; missing => never fires
//    on the sync path.
//  * timeBased — the `!race.timeBased` guard prevents target-based early finish
//    for time-based races; missing => a time-based race with targetSteps > 0
//    would finish participants from a step sync.
//
// Same lean-select bug class as the joinedAt over-grant incident
// (raceFindActiveForUserJoinedAt.test.js) — assert the select asks for the
// fields explicitly.
// ---------------------------------------------------------------------------

function withMockPrisma(mockPrisma, fn) {
  const dbModule = require("../../src/db");
  const originalPrisma = dbModule.prisma;
  Object.assign(dbModule, { prisma: mockPrisma });
  try {
    delete require.cache[require.resolve("../../src/models/race")];
    const mod = require("../../src/models/race");
    return fn(mod);
  } finally {
    Object.assign(dbModule, { prisma: originalPrisma });
    delete require.cache[require.resolve("../../src/models/race")];
  }
}

test("Race.findActiveForUser race select includes timezone/endsAt/timeBased (resolveRaceState reads them)", async () => {
  let capturedArgs = null;
  const mockPrisma = {
    race: {
      async findMany(args) {
        capturedArgs = args;
        return [];
      },
    },
  };

  await withMockPrisma(mockPrisma, async ({ Race }) => {
    await Race.findActiveForUser("user-1");
  });

  assert.ok(capturedArgs, "findMany should be called");
  const raceSelect = capturedArgs.select;
  assert.equal(
    raceSelect.timezone,
    true,
    "timezone must be selected so raceTimeZone(race, 'UTC') buckets box progress in the race tz on the sync path (not UTC)"
  );
  assert.equal(
    raceSelect.endsAt,
    true,
    "endsAt must be selected so the past-endsAt stop-resolving guard fires on the sync path"
  );
  assert.equal(
    raceSelect.timeBased,
    true,
    "timeBased must be selected so time-based races never target-finish from a step sync"
  );
});
