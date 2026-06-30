const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

const {
  buildResolveRaceState,
} = require("../../src/services/raceStateResolution");
const {
  buildRecomputePlacements,
} = require("../../src/jobs/placementRecompute");

// Regression coverage for the "you slipped to 2nd, but I'm still 1st" bug.
//
// The live placement-change push comes from the placementRecompute cron, which
// scores via resolveRaceState with NO requesting user -> timeZone defaults to
// "UTC". The in-app standings come from getRaceProgress with the viewer's real
// device tz. For a USER-created race (race.timezone NULL) raceTimeZone() falls
// back to whatever the caller passed, so the two paths bucket steps by DIFFERENT
// calendar days and can rank participants differently — the notification says
// 2nd while the race screen (correctly) shows 1st.
//
// The fix: persist the creator's tz on the race at creation. Once race.timezone
// is non-null, raceTimeZone(race, "UTC") returns the canonical tz, so the cron,
// the display path, and settlement all bucket identically.

let server;
let nextAppleId = 0;

// A moment chosen so UTC and America/Los_Angeles (PDT, UTC-7 in June) disagree
// about which calendar day "today" is: 04:00 UTC on the 25th is still 21:00 on
// the 24th in LA. Steps dated the 25th therefore count under UTC windowing but
// not under LA windowing — the lever that flips the ranking.
const FIXED_NOW = new Date("2026-06-25T04:00:00Z");
const RACE_STARTED_AT = new Date("2026-06-23T12:00:00Z"); // mid-day, both tzs
const RACE_ENDS_AT = new Date("2026-06-30T12:00:00Z"); // in progress at FIXED_NOW
const CREATOR_TZ = "America/Los_Angeles";

async function createUser(displayName) {
  const appleId = `apple-race-tz-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  if (displayName) {
    await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      body: { displayName },
      token: body.sessionToken,
    });
  }
  return { userId: body.user.id, token: body.sessionToken };
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
  });
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
    body: { accept: true },
    token: b.token,
  });
}

// Create a user race as `creator`, sending their device tz in the x-timezone
// header exactly as the app does. No targetSteps (default 0) so the race never
// finishes on a target — we only care about live standings.
async function createRaceAs(creator, timeZone) {
  return request(server.baseUrl, "POST", "/races", {
    body: { name: "NFCU pt. 2", maxDurationDays: 7 },
    token: creator.token,
    headers: timeZone ? { "x-timezone": timeZone } : {},
  });
}

async function dailyRow(userId, date, steps) {
  await prisma.step.create({ data: { userId, date: new Date(date), steps } });
}

describe("race live-placement timezone", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("persists the creator's timezone on the race at creation", async () => {
    const nathan = await createUser("NathanTZA");
    const res = await createRaceAs(nathan, CREATOR_TZ);
    assert.equal(res.status, 201);
    const raceId = (await res.json()).race.id;

    const race = await prisma.race.findUnique({ where: { id: raceId } });
    assert.equal(
      race.timezone,
      CREATOR_TZ,
      "user race must carry the creator's tz so live + display + settlement agree"
    );
  });

  it("ranks a user race by its canonical tz, so the live push matches the race screen", async () => {
    const nathan = await createUser("NathanTZB");
    const rival = await createUser("RivalTZBBBB");
    await makeFriends(nathan, rival);

    const raceId = (await (await createRaceAs(nathan, CREATOR_TZ)).json()).race.id;
    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      body: { inviteeIds: [rival.userId] },
      token: nathan.token,
    });
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: rival.token,
    });
    await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
      token: nathan.token,
    });

    // Pin the race window around FIXED_NOW (the /start endpoint used real time).
    await prisma.race.update({
      where: { id: raceId },
      data: { startedAt: RACE_STARTED_AT, endsAt: RACE_ENDS_AT },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId },
      data: { joinedAt: RACE_STARTED_AT },
    });

    // Steps: the only differentiator is rival's row dated the 25th.
    //   LA windowing  (today = 24th): nathan 10000 > rival 8000  -> nathan 1st
    //   UTC windowing (today = 25th): nathan 10000 < rival 13000 -> nathan 2nd
    await dailyRow(nathan.userId, "2026-06-24", 10000);
    await dailyRow(rival.userId, "2026-06-24", 8000);
    await dailyRow(rival.userId, "2026-06-25", 5000); // only counts under UTC

    // Baseline: nathan is leading (1st), rival 2nd — what the race screen shows.
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: nathan.userId },
      data: { lastNotifiedPlacement: 1 },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: rival.userId },
      data: { lastNotifiedPlacement: 2 },
    });

    // Drive the cron exactly as production does (no requesting user), but with a
    // pinned clock and a captured event bus.
    const emitted = [];
    const resolveRaceState = buildResolveRaceState({ now: () => FIXED_NOW });
    const recompute = buildRecomputePlacements({
      now: () => FIXED_NOW,
      resolveRaceState,
      eventBus: { emit: (event, data) => emitted.push({ event, data }) },
      requestStepSyncForUsers: async () => {},
      logger: { log() {}, warn() {}, error() {} },
    });

    await recompute();

    const nathanP = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: nathan.userId },
    });
    const rivalP = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: rival.userId },
    });

    // The cron must score in the race's canonical tz (LA), not UTC: rival's
    // 25th-dated steps must NOT count, so rival sits at 8000, behind nathan.
    assert.equal(nathanP.totalSteps, 10000);
    assert.equal(
      rivalP.totalSteps,
      8000,
      "canonical-tz scoring excludes the 25th; UTC scoring would give rival 13000"
    );

    // Nobody actually changed places under the canonical tz, so no placement
    // push should fire — and certainly not one telling nathan he dropped to 2nd.
    const nathanDrops = emitted.filter(
      (e) =>
        e.event === "PLACEMENT_CHANGED" &&
        e.data.userId === nathan.userId &&
        e.data.placement !== 1
    );
    assert.equal(
      nathanDrops.length,
      0,
      "nathan leads under the canonical tz; he must not be told he slipped"
    );
    assert.equal(
      emitted.length,
      0,
      "no live rank actually changed once scored in the canonical tz"
    );
  });
});
