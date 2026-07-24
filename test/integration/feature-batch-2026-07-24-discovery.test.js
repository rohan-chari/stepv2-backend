const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const {
  renewTournamentSeeds,
} = require("../../src/modules/tournaments/jobs/tournamentSeedRenewal");

// Item 2 (2026-07-24): GET /races/discovery-summary .publicRaceCount now also
// counts featured seeded daily/weekly races AND featured Daily Dash brackets the
// viewer is NOT enrolled in, while /races/public is left unchanged.

let server;
let nextAppleId = 0;

const FEATURES = { "X-Client-Features": "tournaments,team_races" };

async function createUser(displayName) {
  const appleId = `apple-fb724disc-${++nextAppleId}`;
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

async function seedActiveDailyRace() {
  const seed = await prisma.raceSeed.findUnique({ where: { kind: "DAILY_10K" } });
  assert.ok(seed, "DAILY_10K seed exists from migrations");
  const now = Date.now();
  return prisma.race.create({
    data: {
      seedId: seed.id,
      creatorId: null,
      name: "Daily 10K",
      targetSteps: 0,
      isPublic: true,
      timeBased: true,
      timezone: "America/New_York",
      maxParticipants: 500,
      maxDurationDays: 1,
      status: "ACTIVE",
      powerupsEnabled: true,
      powerupStepInterval: 2000,
      startedAt: new Date(now - 60 * 60 * 1000),
      endsAt: new Date(now + 23 * 60 * 60 * 1000),
    },
    select: { id: true },
  });
}

async function discovery(token) {
  const res = await request(server.baseUrl, "GET", "/races/discovery-summary", { token, headers: FEATURES });
  assert.equal(res.status, 200);
  return res.json();
}

async function publicRacesLen(token) {
  const res = await request(server.baseUrl, "GET", "/races/public", { token, headers: FEATURES });
  assert.equal(res.status, 200);
  const body = await res.json();
  return (body.races || body.publicRaces || []).length;
}

describe("feature batch 2026-07-24 — discovery-summary public count", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("counts a featured race + bracket the viewer is NOT in, and excludes them once enrolled; /races/public unchanged", async () => {
    const viewer = await createUser("ViewerFB724");

    // A featured seeded daily race (viewer not a participant).
    const race = await seedActiveDailyRace();

    // A featured Daily Dash bracket (viewer not enrolled).
    await prisma.tournamentSeed.create({
      data: {
        id: "seed-fb724-dash",
        kind: "FB724_DASH",
        name: "FB724 Dash",
        bracketSize: 4,
        matchupDurationDays: 1,
        powerupsEnabled: false,
        championPrizeCoins: 150,
        active: true,
      },
    });
    await renewTournamentSeeds();
    const lobby = await prisma.tournament.findFirst({
      where: { seedId: "seed-fb724-dash", status: "PENDING" },
    });
    assert.ok(lobby, "featured bracket lobby minted");

    // /races/public lists individual public races (the ACTIVE seeded race is one)
    // — and never the bracket (brackets are tournaments, not races).
    const publicLenBefore = await publicRacesLen(viewer.token);
    assert.ok(publicLenBefore >= 1, "seeded race is a browsable public race");

    // Not enrolled → both the featured race and the bracket are counted. The
    // featured race is already in the public-race count; the bracket is the
    // additive part, so the discovery count strictly exceeds /races/public.
    const notEnrolled = await discovery(viewer.token);
    assert.equal(notEnrolled.resolved.publicRaceCount, true);
    const countNotEnrolled = notEnrolled.publicRaceCount;
    assert.equal(
      countNotEnrolled,
      publicLenBefore + 1,
      "publicRaceCount = individual public races + 1 not-enrolled featured bracket"
    );
    // The featured card + bracket both surface.
    assert.ok(notEnrolled.featuredRaces.some((r) => r.raceId === race.id));
    assert.ok(notEnrolled.featuredTournaments.some((t) => t.id === lobby.id));

    // Enroll the viewer in BOTH.
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: viewer.userId, status: "ACCEPTED" },
    });
    const joinRes = await request(server.baseUrl, "POST", `/tournaments/${lobby.id}/join`, {
      token: viewer.token,
      headers: FEATURES,
    });
    assert.ok(joinRes.status === 200 || joinRes.status === 201, `join status ${joinRes.status}`);

    const enrolled = await discovery(viewer.token);
    const countEnrolled = enrolled.publicRaceCount;

    // Both are now excluded from the count: the featured seeded race leaves the
    // public-race count (viewer joined it) and the bracket is no longer added.
    assert.equal(
      countNotEnrolled - countEnrolled,
      2,
      `expected count to drop by 2 (was ${countNotEnrolled}, now ${countEnrolled})`
    );
    // The featured cards stay pinned even though the viewer joined.
    assert.ok(enrolled.featuredRaces.some((r) => r.raceId === race.id));
    assert.ok(enrolled.featuredTournaments.some((t) => t.id === lobby.id));
  });
});
