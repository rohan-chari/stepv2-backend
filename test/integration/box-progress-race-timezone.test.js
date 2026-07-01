const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const {
  getTimeZoneParts,
  formatDateString,
  addDaysToDateString,
  parseDateString,
  zonedDateTimeToUtc,
} = require("../../src/utils/week");

// Regression test for the box-progress TIMEZONE SPLIT incident ("summer
// solstice", Jul 2026: countdown pegged flat at one interval while mystery
// boxes kept arriving).
//
// A race with a persisted `timezone` must bucket box progress in THAT timezone
// on every path. The bug: the live step-sync path (recordSteps /
// recordStepSamples -> resolveRaceState) reads races via Race.findActiveForUser,
// whose lean select omitted `timezone`. raceTimeZone(race, "UTC") then fell back
// to UTC, so the sync path computed box-effective steps with UTC day-bucketing
// while the display path (getRaceProgress -> findById, which includes
// `timezone`) bucketed in the race tz.
//
// Why that inflates the sync-path basis: the per-day rule is
// max(samples-in-local-day, daily-total-row). An evening-ET step sample lands on
// the NEXT UTC day, while the daily `steps` row (which already contains those
// same steps) stays keyed to the ET date — so UTC bucketing counts the evening
// steps TWICE (once via the daily row, again as next-day samples). The sync path
// then mints boxes off the inflated basis and ratchets next_box_at_steps past
// the race-tz truth; the display countdown min(next_box - raceTzBasis, interval)
// clamps flat at the full interval and never moves.
//
// Real incident numbers: ET basis 107,646 vs UTC basis 110,223; a box for
// threshold 110,000 minted off the sync path while the app showed "2000 steps to
// next box" forever.
//
// This test fails without `timezone: true` in the findActiveForUser select.

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-bptz-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  return { userId: body.user.id, token: body.sessionToken };
}

const TZ = "America/New_York";
const INTERVAL = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Onboarding welcome boxes use earned_at_steps 0/1/2; milestone boxes are
// positive multiples of the interval.
function milestoneSteps(rows) {
  return rows
    .filter((p) => p.earnedAtSteps != null && p.earnedAtSteps >= INTERVAL)
    .map((p) => p.earnedAtSteps)
    .sort((a, b) => a - b);
}

describe("race with persisted timezone buckets box progress in that tz on the step-sync path", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("evening-ET steps + daily total mint boxes off the RACE-TZ basis, not a UTC double-count", async () => {
    const walker = await createUser("SolsticeWalker");

    // ET calendar anchors relative to now: Y = yesterday (ET), race started the
    // day before Y at noon ET (partial start day in BOTH bucketings, so the
    // start-day rule contributes 0 either way and stays out of this test).
    const nowParts = getTimeZoneParts(new Date(), TZ);
    const todayEt = formatDateString(nowParts.year, nowParts.month, nowParts.day);
    const yEt = addDaysToDateString(todayEt, -1);
    const y = parseDateString(yEt);
    const startEt = parseDateString(addDaysToDateString(yEt, -1));
    const startedAt = zonedDateTimeToUtc(
      { year: startEt.year, month: startEt.month, day: startEt.day, hour: 12, minute: 0, second: 0 },
      TZ
    );
    const endsAt = new Date(Date.now() + 4 * DAY_MS);

    // User-created powerup race with a PERSISTED creator timezone — the shape
    // every user race has had since the creator-tz backfill.
    const createRes = await request(server.baseUrl, "POST", "/races", {
      body: {
        name: "summer solstice repro",
        targetSteps: 0,
        maxDurationDays: 14,
        powerupsEnabled: true,
        powerupStepInterval: INTERVAL,
        isPublic: true,
      },
      token: walker.token,
    });
    assert.ok(
      createRes.status >= 200 && createRes.status < 300,
      `create race failed: ${createRes.status}`
    );
    const raceId = (await createRes.json()).race.id;

    await prisma.race.update({
      where: { id: raceId },
      data: {
        status: "ACTIVE",
        timeBased: true,
        timezone: TZ,
        startedAt,
        endsAt,
        powerupsEnabled: true,
        powerupStepInterval: INTERVAL,
      },
    });
    // On-time participant: joined at race start with the box gate armed at the
    // first interval (exactly what startRace produces).
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: walker.userId },
      data: { joinedAt: startedAt, nextBoxAtSteps: INTERVAL },
    });

    // Yesterday's walking, synced the way real devices sync it:
    //  * one 3000-step sample late in the ET evening (23:00-23:30 ET — always
    //    03:00+ UTC on the NEXT UTC day), and
    //  * the daily `steps` row for that ET date containing the same 3000 steps.
    // Race-tz basis:  max(3000 samples, 3000 daily) = 3000 for day Y.
    // UTC-bucketed:   day Y  -> max(0 samples, 3000 daily) = 3000
    //                 day Y+1 -> 3000 samples               = 3000  (double count)
    const eveningStart = zonedDateTimeToUtc(
      { year: y.year, month: y.month, day: y.day, hour: 23, minute: 0, second: 0 },
      TZ
    );
    const eveningEnd = zonedDateTimeToUtc(
      { year: y.year, month: y.month, day: y.day, hour: 23, minute: 30, second: 0 },
      TZ
    );
    await prisma.stepSample.create({
      data: {
        userId: walker.userId,
        periodStart: eveningStart,
        periodEnd: eveningEnd,
        steps: 3000,
      },
    });
    await prisma.step.create({
      data: {
        userId: walker.userId,
        steps: 3000,
        date: new Date(Date.UTC(y.year, y.month - 1, y.day)),
      },
    });

    // ONE live sync (a tiny fresh sample), exercising recordStepSamples ->
    // resolveRaceState -> syncRacePowerupState — the exact path that minted off
    // the wrong basis in the incident. Device tz header matches the race tz.
    const syncRes = await request(server.baseUrl, "POST", "/steps/samples", {
      body: {
        samples: [
          {
            periodStart: new Date(Date.now() - 60 * 1000).toISOString(),
            periodEnd: new Date().toISOString(),
            steps: 120,
          },
        ],
      },
      token: walker.token,
      headers: { "x-timezone": TZ },
    });
    assert.ok(
      syncRes.status >= 200 && syncRes.status < 300,
      `step sync failed: ${syncRes.status}`
    );

    // Race-tz box basis is 3000 + 120 = 3120: exactly ONE milestone crossed.
    // The bug computes a UTC basis of 6120 and mints 2000/4000/6000.
    const boxes = await prisma.racePowerup.findMany({
      where: { raceId, userId: walker.userId },
    });
    assert.deepEqual(
      milestoneSteps(boxes),
      [2000],
      `sync path must mint off the race-tz basis (3120 -> one box at 2000); ` +
        `got milestones at [${milestoneSteps(boxes).join(", ")}] — a UTC-bucketed ` +
        `basis double-counts the evening steps and over-mints`
    );

    // The gate must ratchet to the race-tz next boundary (4000), not past the
    // player's real progress (the bug leaves it at 8000).
    const participant = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: walker.userId },
    });
    assert.equal(
      participant.nextBoxAtSteps,
      2 * INTERVAL,
      `next_box_at_steps must be the race-tz next boundary, got ${participant.nextBoxAtSteps}`
    );

    // And the displayed countdown must move: 4000 - 3120 = 880. With the split,
    // next_box sits at 8000 while the display path (findById, race tz) computes
    // 3120, so min(8000 - 3120, INTERVAL) pegs the countdown flat at 2000 —
    // Amogh's "steps stuck at 2000".
    const progressRes = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/progress`,
      { token: walker.token, headers: { "x-timezone": TZ } }
    );
    assert.equal(progressRes.status, 200);
    const { progress } = await progressRes.json();
    assert.equal(
      progress.powerupData.stepsUntilNextPowerup,
      2 * INTERVAL - 3120,
      `countdown must track the race-tz basis (880 to go), got ` +
        `${progress.powerupData.stepsUntilNextPowerup} — the full-interval clamp ` +
        `firing here means next_box ratcheted off a different tz basis`
    );
  });
});
