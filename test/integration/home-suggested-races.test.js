const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  startServer,
  createTestUser,
} = require("./setup");

const ALL_FEATURES = {
  "X-Client-Features":
    "home_suggested_races,team_races,tournaments",
};
const NO_TOURNAMENTS = {
  "X-Client-Features": "home_suggested_races,team_races",
};

const FEATURED_KEYS = [
  "endsAt",
  "finishReward",
  "id",
  "isFull",
  "joinAction",
  "kind",
  "maxParticipants",
  "name",
  "participantCount",
  "powerupsEnabled",
  "payoutRoundingVersion",
  "prizePool",
  "seedKind",
  "status",
  "teamPayoutVersion",
  "teamWinnerRewardCoins",
].sort();

const PUBLIC_KEYS = [
  "buyInAmount",
  "endsAt",
  "id",
  "isTeamRace",
  "joinAction",
  "kind",
  "maxDurationDays",
  "maxParticipants",
  "name",
  "participantCount",
  "payoutPreset",
  "powerupsEnabled",
  "payoutRoundingVersion",
  "prizePool",
  "startedAt",
  "status",
  "teamAName",
  "teamBName",
  "teamPayoutVersion",
  "teamSize",
  "teamWinnerRewardCoins",
  "teams",
].sort();

const TOURNAMENT_KEYS = [
  "acceptedCount",
  "bracketSize",
  "buyInAmount",
  "createdAt",
  "id",
  "joinAction",
  "kind",
  "matchupDurationDays",
  "name",
  "potCoins",
  "powerupStepInterval",
  "powerupsEnabled",
  "prizePool",
  "seedKind",
  "status",
].sort();

let server;
let ownerSequence = 0;

function iso(value) {
  return new Date(value).toISOString();
}

async function createOwner(overrides = {}) {
  ownerSequence += 1;
  return prisma.user.create({
    data: {
      appleId: `home-suggestions-owner-${ownerSequence}`,
      displayName: `Owner ${ownerSequence}`,
      ...overrides,
    },
  });
}

async function createRace(overrides = {}) {
  return prisma.race.create({
    data: {
      name: "Public race",
      targetSteps: 10000,
      status: "PENDING",
      maxDurationDays: 1,
      buyInAmount: 0,
      payoutPreset: "TOP_HALF",
      powerupsEnabled: true,
      powerupStepInterval: 2000,
      isPublic: true,
      maxParticipants: 10,
      timeBased: true,
      ...overrides,
    },
  });
}

async function raceSeed(kind) {
  const cadence = kind === "DAILY_10K" ? "DAILY" : "WEEKLY";
  return prisma.raceSeed.upsert({
    where: { kind },
    update: {
      name: kind === "DAILY_10K" ? "Daily 10K" : "Weekly 50K",
      active: true,
      timeBased: true,
      maxParticipants: 100,
    },
    create: {
      id: `home-suggestions-${kind.toLowerCase()}`,
      kind,
      name: kind === "DAILY_10K" ? "Daily 10K" : "Weekly 50K",
      targetSteps: kind === "DAILY_10K" ? 10000 : 50000,
      durationHours: kind === "DAILY_10K" ? 24 : 168,
      cadence,
      maxParticipants: 100,
      powerupsEnabled: true,
      powerupStepInterval: 2000,
      timeBased: true,
      active: true,
    },
  });
}

async function createFeaturedRace(kind, overrides = {}) {
  const seed = await raceSeed(kind);
  const start = new Date("2026-08-11T12:00:00.000Z");
  const end =
    kind === "DAILY_10K"
      ? new Date("2099-08-12T12:00:00.000Z")
      : new Date("2099-08-18T12:00:00.000Z");
  return createRace({
    seedId: seed.id,
    creatorId: null,
    name: seed.name,
    status: "ACTIVE",
    maxDurationDays: kind === "DAILY_10K" ? 1 : 7,
    startedAt: start,
    endsAt: end,
    maxParticipants: seed.maxParticipants,
    ...overrides,
  });
}

async function createTournamentSeed(kind, overrides = {}) {
  return prisma.tournamentSeed.create({
    data: {
      id: `home-suggestions-tournament-seed-${kind.toLowerCase()}`,
      kind,
      name: kind.replaceAll("_", " "),
      bracketSize: 8,
      matchupDurationDays: 1,
      powerupsEnabled: true,
      powerupStepInterval: 2000,
      championPrizeCoins: 800,
      active: true,
      ...overrides,
    },
  });
}

async function createTournament(overrides = {}) {
  return prisma.tournament.create({
    data: {
      name: "Public tournament",
      status: "PENDING",
      bracketSize: 8,
      matchupDurationDays: 1,
      buyInAmount: 0,
      potCoins: 0,
      powerupsEnabled: true,
      powerupStepInterval: 2000,
      isPublic: true,
      totalRounds: 3,
      ...overrides,
    },
  });
}

async function addRaceParticipant(raceId, userId, status = "ACCEPTED") {
  return prisma.raceParticipant.create({
    data: { raceId, userId, status },
  });
}

async function addTournamentParticipant(
  tournamentId,
  userId,
  status = "ACCEPTED",
  overrides = {}
) {
  return prisma.tournamentParticipant.create({
    data: { tournamentId, userId, status, ...overrides },
  });
}

async function fetchSuggestions(
  token,
  { baseUrl = server.baseUrl, headers = ALL_FEATURES } = {}
) {
  return request(baseUrl, "GET", "/home/suggested-races", {
    token,
    headers,
  });
}

function assertResolution(body, expected) {
  assert.deepEqual(Object.keys(body).sort(), ["resolved", "suggestions"]);
  assert.deepEqual(
    Object.keys(body.resolved).sort(),
    ["featuredRaces", "publicRaces", "tournaments"]
  );
  assert.deepEqual(body.resolved, expected);
  for (const value of Object.values(body.resolved)) {
    assert.equal(typeof value, "boolean");
  }
}

function assertFeaturedContract(entry) {
  assert.deepEqual(Object.keys(entry).sort(), FEATURED_KEYS);
  assert.equal(entry.kind, "FEATURED_RACE");
  assert.ok(typeof entry.id === "string" && entry.id.length > 0);
  assert.ok(["DAILY_10K", "WEEKLY_50K"].includes(entry.seedKind));
  assert.ok(typeof entry.name === "string" && entry.name.length > 0);
  assert.equal(entry.status, "ACTIVE");
  assert.equal(iso(entry.endsAt), entry.endsAt);
  assert.ok(Number.isInteger(entry.participantCount));
  assert.ok(entry.participantCount >= 0);
  assert.ok(Number.isInteger(entry.maxParticipants));
  assert.ok(entry.maxParticipants > 0);
  assert.equal(typeof entry.isFull, "boolean");
  assert.equal(typeof entry.powerupsEnabled, "boolean");
  assert.ok(entry.prizePool === null || typeof entry.prizePool === "object");
  assert.ok(
    entry.finishReward === null || typeof entry.finishReward === "object"
  );
  assert.equal(entry.teamPayoutVersion, null);
  assert.equal(entry.teamWinnerRewardCoins, null);
  assert.equal(entry.joinAction, "JOIN");
}

function assertPublicContract(entry) {
  assert.deepEqual(Object.keys(entry).sort(), PUBLIC_KEYS);
  assert.equal(entry.kind, "PUBLIC_RACE");
  assert.ok(typeof entry.id === "string" && entry.id.length > 0);
  assert.ok(typeof entry.name === "string" && entry.name.length > 0);
  assert.ok(["PENDING", "ACTIVE"].includes(entry.status));
  assert.ok(Number.isInteger(entry.maxDurationDays));
  assert.ok(entry.maxDurationDays > 0);
  for (const date of [entry.endsAt, entry.startedAt]) {
    assert.ok(date === null || iso(date) === date);
  }
  assert.ok(Number.isInteger(entry.participantCount));
  assert.ok(entry.participantCount >= 0);
  assert.ok(
    entry.maxParticipants === null ||
      (Number.isInteger(entry.maxParticipants) && entry.maxParticipants > 0)
  );
  assert.ok(Number.isInteger(entry.buyInAmount));
  assert.ok(entry.buyInAmount >= 0);
  assert.ok(entry.payoutPreset === null || typeof entry.payoutPreset === "string");
  assert.equal(typeof entry.powerupsEnabled, "boolean");
  assert.ok(entry.prizePool === null || typeof entry.prizePool === "object");
  assert.equal(typeof entry.isTeamRace, "boolean");
  assert.ok(
    entry.teamSize === null ||
      (Number.isInteger(entry.teamSize) && entry.teamSize > 0)
  );
  assert.ok(entry.teamAName === null || typeof entry.teamAName === "string");
  assert.ok(entry.teamBName === null || typeof entry.teamBName === "string");
  assert.ok(entry.teams === null || typeof entry.teams === "object");
  assert.equal(entry.teamPayoutVersion, null);
  assert.equal(entry.teamWinnerRewardCoins, null);
  assert.equal(entry.joinAction, "JOIN");
}

function assertTournamentContract(entry) {
  assert.deepEqual(Object.keys(entry).sort(), TOURNAMENT_KEYS);
  assert.equal(entry.kind, "TOURNAMENT");
  assert.ok(typeof entry.id === "string" && entry.id.length > 0);
  assert.ok(typeof entry.name === "string" && entry.name.length > 0);
  assert.equal(entry.status, "PENDING");
  assert.ok(Number.isInteger(entry.bracketSize) && entry.bracketSize > 0);
  assert.ok(
    Number.isInteger(entry.matchupDurationDays) &&
      entry.matchupDurationDays > 0
  );
  assert.ok(Number.isInteger(entry.acceptedCount));
  assert.ok(entry.acceptedCount >= 0);
  assert.ok(entry.seedKind === null || typeof entry.seedKind === "string");
  assert.ok(Number.isInteger(entry.buyInAmount) && entry.buyInAmount >= 0);
  assert.ok(Number.isInteger(entry.potCoins) && entry.potCoins >= 0);
  assert.ok(entry.prizePool === null || typeof entry.prizePool === "object");
  assert.equal(typeof entry.powerupsEnabled, "boolean");
  assert.ok(
    entry.powerupStepInterval === null ||
      (Number.isInteger(entry.powerupStepInterval) &&
        entry.powerupStepInterval > 0)
  );
  assert.equal(iso(entry.createdAt), entry.createdAt);
  assert.equal(entry.joinAction, "JOIN");
  assert.equal("scheduledStartAt" in entry, false);
}

function canonicalFeatured(id, seedKind = "DAILY_10K") {
  return {
    raceId: id,
    seedKind,
    name: seedKind === "DAILY_10K" ? "Daily 10K" : "Weekly 50K",
    endsAt: new Date("2099-08-12T12:00:00.000Z"),
    participantCount: 0,
    maxParticipants: 100,
    isFull: false,
    powerupsEnabled: true,
    prizePool: null,
    finishReward: null,
    myStatus: null,
    upcoming: null,
  };
}

function canonicalPublic(id, createdAt = "2026-08-11T12:00:00.000Z") {
  return {
    id,
    name: `Race ${id}`,
    status: "PENDING",
    maxDurationDays: 1,
    endsAt: null,
    startedAt: null,
    targetSteps: 10000,
    participantCount: 0,
    maxParticipants: 10,
    buyInAmount: 0,
    payoutPreset: "TOP_HALF",
    powerupsEnabled: true,
    powerupStepInterval: 2000,
    projectedPotCoins: 0,
    prizePool: null,
    payouts: null,
    payoutTiers: null,
    finishReward: null,
    creator: null,
    createdAt: new Date(createdAt),
    isTeamRace: false,
    teamSize: null,
    teamAName: null,
    teamBName: null,
    teams: null,
    teamAOpenSlots: null,
    teamBOpenSlots: null,
  };
}

function canonicalTournament(
  id,
  { seedKind = null, joinable = true, createdAt = "2026-08-11T12:00:00.000Z" } = {}
) {
  return {
    id,
    name: `Tournament ${id}`,
    status: "PENDING",
    bracketSize: 8,
    matchupDurationDays: 1,
    acceptedCount: 0,
    buyInAmount: 0,
    potCoins: 0,
    prizePool: null,
    powerupsEnabled: true,
    powerupStepInterval: 2000,
    createdAt: new Date(createdAt),
    seedKind,
    joinable,
  };
}

describe("GET /home/suggested-races", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    ownerSequence = 0;
  });

  it("requires the existing authenticated error contract", async () => {
    const response = await request(
      server.baseUrl,
      "GET",
      "/home/suggested-races",
      { headers: ALL_FEATURES }
    );
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(typeof body.error, "string");
  });

  it("returns the exact discriminated contracts in Daily → Weekly → public → featured tournament → public tournament order", async () => {
    const { user, token } = await createTestUser({
      appleId: "home-suggestions-viewer-shape",
      displayName: "Suggestion Viewer",
    });
    const owner = await createOwner();

    const daily = await createFeaturedRace("DAILY_10K", {
      id: "featured-daily",
      payoutRoundingVersion: 1,
      fundedPrize: true,
    });
    const weekly = await createFeaturedRace("WEEKLY_50K", {
      id: "featured-weekly",
      payoutRoundingVersion: 1,
      fundedPrize: true,
    });
    await addRaceParticipant(daily.id, owner.id);

    const publicOld = await createRace({
      id: "public-old",
      creatorId: owner.id,
      name: "Older public",
      createdAt: new Date("2026-08-11T10:00:00.000Z"),
    });
    const publicTieA = await createRace({
      id: "public-a",
      creatorId: owner.id,
      name: "Newer public A",
      createdAt: new Date("2026-08-11T11:00:00.000Z"),
      payoutRoundingVersion: 1,
    });
    const publicTieB = await createRace({
      id: "public-b",
      creatorId: owner.id,
      name: "Newer public B",
      createdAt: new Date("2026-08-11T11:00:00.000Z"),
    });

    const seed = await createTournamentSeed("DAILY_DASH");
    const featuredTournament = await createTournament({
      id: "tournament-featured",
      seedId: seed.id,
      creatorId: null,
      name: "Daily Dash",
      potCoins: 800,
      createdAt: new Date("2026-08-11T08:00:00.000Z"),
    });
    const publicTournament = await createTournament({
      id: "tournament-public",
      creatorId: owner.id,
      name: "Public bracket",
      createdAt: new Date("2026-08-11T12:00:00.000Z"),
    });
    await addTournamentParticipant(featuredTournament.id, owner.id);

    const response = await fetchSuggestions(token);
    assert.equal(response.status, 200);
    const body = await response.json();

    assertResolution(body, {
      featuredRaces: true,
      publicRaces: true,
      tournaments: true,
    });
    assert.deepEqual(
      body.suggestions.map((entry) => entry.id),
      [
        daily.id,
        weekly.id,
        publicTieA.id,
        publicTieB.id,
        publicOld.id,
        featuredTournament.id,
        publicTournament.id,
      ]
    );

    assertFeaturedContract(body.suggestions[0]);
    assertFeaturedContract(body.suggestions[1]);
    assertPublicContract(body.suggestions[2]);
    assertPublicContract(body.suggestions[3]);
    assertPublicContract(body.suggestions[4]);
    assertTournamentContract(body.suggestions[5]);
    assertTournamentContract(body.suggestions[6]);
    assert.equal(body.suggestions[0].participantCount, 1);
    assert.equal(body.suggestions[0].payoutRoundingVersion, 1);
    assert.equal(body.suggestions[1].payoutRoundingVersion, 1);
    assert.equal(body.suggestions[2].payoutRoundingVersion, 1);
    assert.equal(body.suggestions[0].prizePool?.coins % 5, 0);
    assert.equal(body.suggestions[0].id, daily.id, "raceId maps to id");
    assert.equal(body.suggestions[5].acceptedCount, 1);
    assert.equal(body.suggestions[5].seedKind, "DAILY_DASH");
    assert.equal(user.id.length > 0, true);
  });

  it("hides joined and invited current featured seeds independently and never substitutes upcoming races", async () => {
    const { user, token } = await createTestUser({
      appleId: "home-suggestions-viewer-featured-membership",
    });
    const daily = await createFeaturedRace("DAILY_10K", {
      id: "joined-daily",
    });
    const weekly = await createFeaturedRace("WEEKLY_50K", {
      id: "invited-weekly",
    });
    await createRace({
      id: "upcoming-daily",
      seedId: daily.seedId,
      creatorId: null,
      name: "Next Daily",
      status: "PENDING",
      scheduledStartAt: new Date("2099-08-13T12:00:00.000Z"),
      endsAt: new Date("2099-08-14T12:00:00.000Z"),
    });

    await addRaceParticipant(daily.id, user.id, "ACCEPTED");
    let response = await fetchSuggestions(token);
    assert.equal(response.status, 200);
    let body = await response.json();
    assert.deepEqual(
      body.suggestions
        .filter((entry) => entry.kind === "FEATURED_RACE")
        .map((entry) => entry.id),
      [weekly.id]
    );

    await addRaceParticipant(weekly.id, user.id, "INVITED");
    response = await fetchSuggestions(token);
    assert.equal(response.status, 200);
    body = await response.json();
    assert.deepEqual(
      body.suggestions.filter((entry) => entry.kind === "FEATURED_RACE"),
      []
    );
    assert.equal(
      body.suggestions.some((entry) => entry.id === "upcoming-daily"),
      false
    );
  });

  it("hides full and expired featured seeds before choosing one per seed", async () => {
    const { token } = await createTestUser({
      appleId: "home-suggestions-viewer-featured-bounds",
    });
    const participant = await createOwner();
    const daily = await createFeaturedRace("DAILY_10K", {
      id: "full-daily",
      maxParticipants: 1,
    });
    await addRaceParticipant(daily.id, participant.id);
    await createFeaturedRace("WEEKLY_50K", {
      id: "expired-weekly",
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      endsAt: new Date("2020-01-08T00:00:00.000Z"),
    });

    const response = await fetchSuggestions(token);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      body.suggestions.filter((entry) => entry.kind === "FEATURED_RACE"),
      []
    );
  });

  it("applies every public eligibility predicate before the four-row cap and supports team races only for capable clients", async () => {
    const { user, token } = await createTestUser({
      appleId: "home-suggestions-viewer-public-rules",
    });
    const owner = await createOwner();
    const reviewOwner = await createOwner({ isReviewAccount: true });
    const other = await createOwner();

    const eligible = await createRace({
      id: "public-eligible",
      creatorId: owner.id,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    const teamEligible = await createRace({
      id: "team-eligible",
      creatorId: owner.id,
      isTeamRace: true,
      teamSize: 2,
      teamAName: "Swift Capys",
      teamBName: "Turbo Beavers",
      maxParticipants: 4,
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
    });
    const owned = await createRace({
      id: "viewer-owned",
      creatorId: owner.id,
      createdAt: new Date("2026-08-10T00:00:00.000Z"),
    });
    await addRaceParticipant(owned.id, user.id, "INVITED");
    const full = await createRace({
      id: "full-public",
      creatorId: owner.id,
      maxParticipants: 1,
      createdAt: new Date("2026-08-09T00:00:00.000Z"),
    });
    await addRaceParticipant(full.id, other.id);
    await createRace({
      id: "review-public",
      creatorId: reviewOwner.id,
      createdAt: new Date("2026-08-08T00:00:00.000Z"),
    });
    const matchupTournament = await createTournament({
      id: "matchup-parent",
      creatorId: owner.id,
    });
    await createRace({
      id: "tournament-matchup",
      creatorId: owner.id,
      tournamentId: matchupTournament.id,
      tournamentRound: 1,
      tournamentMatchIndex: 0,
      createdAt: new Date("2026-08-07T00:00:00.000Z"),
    });
    const seed = await raceSeed("DAILY_10K");
    await createRace({
      id: "seeded-public",
      creatorId: null,
      seedId: seed.id,
      status: "ACTIVE",
      startedAt: new Date("2026-08-06T00:00:00.000Z"),
      endsAt: new Date("2099-08-06T00:00:00.000Z"),
      createdAt: new Date("2026-08-06T00:00:00.000Z"),
    });
    await createRace({
      id: "active-team",
      creatorId: owner.id,
      status: "ACTIVE",
      isTeamRace: true,
      teamSize: 2,
      maxParticipants: 4,
      startedAt: new Date("2026-08-05T00:00:00.000Z"),
      endsAt: new Date("2099-08-05T00:00:00.000Z"),
      createdAt: new Date("2026-08-05T00:00:00.000Z"),
    });

    let response = await fetchSuggestions(token);
    assert.equal(response.status, 200);
    let body = await response.json();
    assert.deepEqual(
      body.suggestions
        .filter((entry) => entry.kind === "PUBLIC_RACE")
        .map((entry) => entry.id),
      [teamEligible.id, eligible.id]
    );

    response = await fetchSuggestions(token, {
      headers: {
        "X-Client-Features": "home_suggested_races,tournaments",
      },
    });
    assert.equal(response.status, 200);
    body = await response.json();
    assert.deepEqual(
      body.suggestions
        .filter((entry) => entry.kind === "PUBLIC_RACE")
        .map((entry) => entry.id),
      [eligible.id]
    );
  });

  it("finds an older eligible public race behind more than 32 newer ineligible rows and returns at most four public cards", async () => {
    const { user, token } = await createTestUser({
      appleId: "home-suggestions-viewer-public-deep",
    });
    const owner = await createOwner();
    const eligible = await createRace({
      id: "public-deep-eligible",
      creatorId: owner.id,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const newer = [];
    for (let index = 0; index < 33; index += 1) {
      newer.push({
        id: `public-deep-owned-${String(index).padStart(2, "0")}`,
        creatorId: owner.id,
        name: `Owned ${index}`,
        targetSteps: 10000,
        status: "PENDING",
        maxDurationDays: 1,
        buyInAmount: 0,
        payoutPreset: "TOP_HALF",
        powerupsEnabled: false,
        isPublic: true,
        maxParticipants: 10,
        timeBased: true,
        createdAt: new Date(`2026-07-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`),
      });
    }
    await prisma.race.createMany({ data: newer });
    await prisma.raceParticipant.createMany({
      data: newer.map((race) => ({
        raceId: race.id,
        userId: user.id,
        status: "INVITED",
      })),
    });

    const response = await fetchSuggestions(token);
    assert.equal(response.status, 200);
    const body = await response.json();
    const publicCards = body.suggestions.filter(
      (entry) => entry.kind === "PUBLIC_RACE"
    );
    assert.ok(publicCards.length <= 4);
    assert.deepEqual(publicCards.map((entry) => entry.id), [eligible.id]);
  });

  it("orders featured tournaments before public tournaments, requires joinable === true, and applies the combined four-card cap", async () => {
    const { user, token } = await createTestUser({
      appleId: "home-suggestions-viewer-tournament-order",
    });
    const owner = await createOwner();

    const featured = [];
    for (const [index, kind] of ["DAILY_DASH", "WEEKLY_DASH", "MONTHLY_DASH"].entries()) {
      const seed = await createTournamentSeed(kind, {
        id: `home-suggestions-featured-seed-${index}`,
      });
      featured.push(
        await createTournament({
          id: `featured-tournament-${index}`,
          seedId: seed.id,
          creatorId: null,
          name: kind,
          createdAt: new Date("2026-08-01T00:00:00.000Z"),
        })
      );
    }
    const publicNewest = await createTournament({
      id: "public-tournament-newest",
      creatorId: owner.id,
      createdAt: new Date("2026-08-11T00:00:00.000Z"),
    });
    await createTournament({
      id: "public-tournament-older",
      creatorId: owner.id,
      createdAt: new Date("2026-08-10T00:00:00.000Z"),
    });

    const fullSeed = await createTournamentSeed("FULL_DASH");
    const full = await createTournament({
      id: "featured-full",
      seedId: fullSeed.id,
      creatorId: null,
      bracketSize: 4,
      totalRounds: 2,
      createdAt: new Date("2026-08-12T00:00:00.000Z"),
    });
    const fullUsers = [];
    for (let index = 0; index < 4; index += 1) {
      fullUsers.push(await createOwner());
    }
    await prisma.tournamentParticipant.createMany({
      data: fullUsers.map((participant) => ({
        tournamentId: full.id,
        userId: participant.id,
        status: "ACCEPTED",
      })),
    });

    const invitedSeed = await createTournamentSeed("INVITED_DASH");
    const invited = await createTournament({
      id: "featured-invited",
      seedId: invitedSeed.id,
      creatorId: null,
      createdAt: new Date("2026-08-13T00:00:00.000Z"),
    });
    await addTournamentParticipant(invited.id, user.id, "INVITED");

    const aliveSeed = await createTournamentSeed("ALIVE_DASH");
    const alive = await createTournament({
      id: "featured-alive-membership",
      seedId: aliveSeed.id,
      creatorId: null,
      createdAt: new Date("2026-08-13T00:00:00.000Z"),
    });
    await addTournamentParticipant(alive.id, user.id, "ACCEPTED", {
      eliminatedInRound: null,
    });
    await createTournament({
      id: "featured-alive-other-lobby",
      creatorId: owner.id,
      createdAt: new Date("2026-08-14T00:00:00.000Z"),
    });
    await addTournamentParticipant(
      "featured-alive-other-lobby",
      user.id,
      "ACCEPTED",
      { eliminatedInRound: null },
    );

    const response = await fetchSuggestions(token);
    assert.equal(response.status, 200);
    const body = await response.json();
    const tournaments = body.suggestions.filter(
      (entry) => entry.kind === "TOURNAMENT"
    );
    assert.ok(tournaments.length <= 4);
    assert.deepEqual(
      tournaments.map((entry) => entry.id),
      [
        featured[0].id,
        featured[1].id,
        featured[2].id,
        publicNewest.id,
      ]
    );
  });

  it("finds an older eligible tournament behind more than 16 newer ineligible rows", async () => {
    const { user, token } = await createTestUser({
      appleId: "home-suggestions-viewer-tournament-deep",
    });
    const owner = await createOwner();
    const eligible = await createTournament({
      id: "tournament-deep-eligible",
      creatorId: owner.id,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const newer = [];
    for (let index = 0; index < 17; index += 1) {
      newer.push({
        id: `tournament-deep-owned-${String(index).padStart(2, "0")}`,
        creatorId: owner.id,
        name: `Owned bracket ${index}`,
        status: "PENDING",
        bracketSize: 8,
        matchupDurationDays: 1,
        buyInAmount: 0,
        potCoins: 0,
        powerupsEnabled: false,
        isPublic: true,
        totalRounds: 3,
        createdAt: new Date(`2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
      });
    }
    await prisma.tournament.createMany({ data: newer });
    await prisma.tournamentParticipant.createMany({
      data: newer.map((tournament) => ({
        tournamentId: tournament.id,
        userId: user.id,
        status: "INVITED",
      })),
    });

    const response = await fetchSuggestions(token);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      body.suggestions
        .filter((entry) => entry.kind === "TOURNAMENT")
        .map((entry) => entry.id),
      [eligible.id]
    );
  });

  it("treats tokenless tournaments as resolved-empty", async () => {
    const { token } = await createTestUser({
      appleId: "home-suggestions-viewer-tokenless",
    });
    const owner = await createOwner();
    await createTournament({
      id: "tokenless-hidden-tournament",
      creatorId: owner.id,
    });

    const response = await fetchSuggestions(token, {
      headers: NO_TOURNAMENTS,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assertResolution(body, {
      featuredRaces: true,
      publicRaces: true,
      tournaments: true,
    });
    assert.equal(
      body.suggestions.some((entry) => entry.kind === "TOURNAMENT"),
      false
    );
  });

  it("isolates every partial branch failure with exact resolution ownership and HTTP 200", async () => {
    const { token } = await createTestUser({
      appleId: "home-suggestions-viewer-partials",
    });
    const cases = [
      ["featuredRaces", "getFeaturedRaces"],
      ["publicRaces", "getPublicRaces"],
      ["tournaments", "getPublicTournaments"],
    ];

    for (const [resolutionKey, dependencyKey] of cases) {
      const dependencies = {
        getFeaturedRaces: async () => [canonicalFeatured("partial-featured")],
        getPublicRaces: async () => [canonicalPublic("partial-public")],
        getPublicTournaments: async () => ({
          featured: [
            canonicalTournament("partial-tournament", {
              seedKind: "DAILY_DASH",
            }),
          ],
          tournaments: [],
        }),
        logger: { error() {} },
      };
      dependencies[dependencyKey] = async () => {
        throw new Error(`${resolutionKey} unavailable`);
      };
      const isolatedServer = await startServer(dependencies);
      try {
        const response = await fetchSuggestions(token, {
          baseUrl: isolatedServer.baseUrl,
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assertResolution(body, {
          featuredRaces: resolutionKey !== "featuredRaces",
          publicRaces: resolutionKey !== "publicRaces",
          tournaments: resolutionKey !== "tournaments",
        });
        const failedKind = {
          featuredRaces: "FEATURED_RACE",
          publicRaces: "PUBLIC_RACE",
          tournaments: "TOURNAMENT",
        }[resolutionKey];
        assert.equal(
          body.suggestions.some((entry) => entry.kind === failedKind),
          false
        );
      } finally {
        await isolatedServer.close();
      }
    }
  });

  it("keeps SQL-level seeded exclusion when the featured branch fails", async () => {
    const { token } = await createTestUser({
      appleId: "home-suggestions-viewer-seed-failure",
    });
    const owner = await createOwner();
    const seed = await raceSeed("DAILY_10K");
    await createRace({
      id: "seeded-must-not-leak",
      creatorId: null,
      seedId: seed.id,
      status: "ACTIVE",
      startedAt: new Date("2026-08-11T00:00:00.000Z"),
      endsAt: new Date("2099-08-12T00:00:00.000Z"),
      createdAt: new Date("2026-08-11T00:00:00.000Z"),
    });
    const eligible = await createRace({
      id: "unseeded-survives-featured-failure",
      creatorId: owner.id,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    const isolatedServer = await startServer({
      getFeaturedRaces: async () => {
        throw new Error("featured unavailable");
      },
      logger: { error() {} },
    });
    try {
      const response = await fetchSuggestions(token, {
        baseUrl: isolatedServer.baseUrl,
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.resolved.featuredRaces, false);
      assert.equal(body.resolved.publicRaces, true);
      assert.deepEqual(
        body.suggestions
          .filter((entry) => entry.kind === "PUBLIC_RACE")
          .map((entry) => entry.id),
        [eligible.id]
      );
    } finally {
      await isolatedServer.close();
    }
  });

  it("runs no more than three concurrent category reads, filters tournament joinable by literal true, and bounds output at ten", async () => {
    const { token } = await createTestUser({
      appleId: "home-suggestions-viewer-query-bounds",
    });
    const calls = {
      featured: 0,
      public: 0,
      tournaments: 0,
    };
    let active = 0;
    let maximumActive = 0;
    let publicArgs;

    async function measured(name, value) {
      calls[name] += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return value;
    }

    const isolatedServer = await startServer({
      getFeaturedRaces: async () =>
        measured("featured", [
          canonicalFeatured("bound-daily", "DAILY_10K"),
          canonicalFeatured("bound-weekly", "WEEKLY_50K"),
          canonicalFeatured("bound-extra", "DAILY_10K"),
        ]),
      getPublicRaces: async (args) => {
        publicArgs = args;
        return measured(
          "public",
          Array.from({ length: 8 }, (_, index) =>
            canonicalPublic(`bound-public-${index}`)
          )
        );
      },
      getPublicTournaments: async () =>
        measured("tournaments", {
          featured: Array.from({ length: 4 }, (_, index) =>
            canonicalTournament(`bound-featured-tournament-${index}`, {
              seedKind: `FEATURED_${index}`,
              joinable: true,
            })
          ),
          tournaments: [
            ...Array.from({ length: 4 }, (_, index) =>
              canonicalTournament(`bound-public-tournament-${index}`, {
                joinable: true,
              })
            ),
            canonicalTournament("joinable-false", { joinable: false }),
            canonicalTournament("joinable-null", { joinable: null }),
            { ...canonicalTournament("joinable-missing"), joinable: undefined },
          ],
        }),
      logger: { error() {} },
    });

    try {
      const response = await fetchSuggestions(token, {
        baseUrl: isolatedServer.baseUrl,
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(calls, { featured: 1, public: 1, tournaments: 1 });
      assert.equal(maximumActive, 3, "all three category reads overlap");
      assert.equal(publicArgs.excludeSeeded, true);
      assert.equal(body.suggestions.length, 10);
      assert.equal(
        body.suggestions.filter((entry) => entry.kind === "FEATURED_RACE").length,
        2
      );
      assert.equal(
        body.suggestions.filter((entry) => entry.kind === "PUBLIC_RACE").length,
        4
      );
      assert.equal(
        body.suggestions.filter((entry) => entry.kind === "TOURNAMENT").length,
        4
      );
      assert.equal(
        body.suggestions.some((entry) => entry.id.startsWith("joinable-")),
        false
      );
    } finally {
      await isolatedServer.close();
    }
  });

  it("leaves every legacy endpoint byte-compatible", async () => {
    const { token } = await createTestUser({
      appleId: "home-suggestions-viewer-legacy",
    });
    const owner = await createOwner({
      id: "11000000-0000-4000-8000-000000000001",
    });
    await createFeaturedRace("DAILY_10K", { id: "legacy-daily" });
    await createRace({ id: "legacy-public", creatorId: owner.id });
    await createTournament({
      id: "legacy-public-tournament",
      creatorId: owner.id,
    });

    const legacyPaths = [
      "/home/race-card?homeActiveRaces=1",
      "/races/featured",
      "/races/public",
    ];
    const before = new Map();
    for (const path of legacyPaths) {
      const response = await request(server.baseUrl, "GET", path, {
        token,
        headers: ALL_FEATURES,
      });
      assert.equal(response.status, 200, path);
      before.set(path, await response.text());
    }

    await fetchSuggestions(token);

    for (const path of legacyPaths) {
      const response = await request(server.baseUrl, "GET", path, {
        token,
        headers: ALL_FEATURES,
      });
      assert.equal(response.status, 200, path);
      assert.equal(await response.text(), before.get(path), path);
    }

    // Frozen pre-feature fixture. Comparing the legacy handler to itself before
    // and after the new call cannot detect an accidental global serializer
    // addition, so pin the actual wire bytes and key order here.
    const publicTournaments = await request(
      server.baseUrl,
      "GET",
      "/tournaments/public",
      { token, headers: ALL_FEATURES }
    );
    assert.equal(publicTournaments.status, 200);
    assert.equal(
      await publicTournaments.text(),
      JSON.stringify({
        featured: [],
        tournaments: [
          {
            id: "legacy-public-tournament",
            name: "Public tournament",
            status: "PENDING",
            bracketSize: 8,
            matchupDurationDays: 1,
            buyInAmount: 0,
            potCoins: 0,
            prizePool: null,
            powerupsEnabled: true,
            powerupStepInterval: 2000,
            isPublic: true,
            shareToken: null,
            currentRound: 0,
            totalRounds: 3,
            creatorId: owner.id,
            seedId: null,
            seedKind: null,
            championPrizeCoins: null,
            championUserId: null,
            startedAt: null,
            completedAt: null,
            myStatus: null,
            myEliminatedInRound: null,
            acceptedCount: 0,
            myCurrentMatchRaceId: null,
            joinable: true,
          },
        ],
      })
    );
  });
});
