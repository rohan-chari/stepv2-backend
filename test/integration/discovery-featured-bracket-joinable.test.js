const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const {
  renewTournamentSeeds,
} = require("../../src/modules/tournaments/jobs/tournamentSeedRenewal");

// 2026-07-24 bug: the Races screen kept advertising "1 race available to join"
// pointing at the featured Daily Dash bracket for a viewer who was already
// playing that bracket's seed — a bracket they CANNOT join (joinTournamentCore
// rejects with ALREADY_IN_FEATURED when the user is still alive in another
// bracket of the same seed), and likewise for a lobby that is already full
// (TOURNAMENT_FULL).
//
// discovery-summary's publicRaceCount must only add featured brackets the
// viewer could actually join.

let server;
let nextAppleId = 0;

const FEATURES = { "X-Client-Features": "tournaments,team_races" };

async function createUser() {
  const appleId = `apple-discjoin-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  return { userId: body.user.id, token: body.sessionToken };
}

async function seedDash(kind, bracketSize = 4) {
  await prisma.tournamentSeed.create({
    data: {
      id: `seed-${kind}`,
      kind,
      name: `${kind} Dash`,
      bracketSize,
      matchupDurationDays: 1,
      powerupsEnabled: false,
      championPrizeCoins: 150,
      active: true,
    },
  });
  await renewTournamentSeeds();
  const lobby = await prisma.tournament.findFirst({
    where: { seedId: `seed-${kind}`, status: "PENDING" },
  });
  assert.ok(lobby, "featured bracket lobby minted");
  return lobby;
}

async function discovery(token) {
  const res = await request(server.baseUrl, "GET", "/races/discovery-summary", {
    token,
    headers: FEATURES,
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function publicTournaments(token) {
  const res = await request(server.baseUrl, "GET", "/tournaments/public", {
    token,
    headers: FEATURES,
  });
  assert.equal(res.status, 200);
  return res.json();
}

describe("discovery-summary — only joinable featured brackets are counted", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("does not count the next featured bracket while the viewer is still alive in another bracket of the same seed", async () => {
    const viewer = await createUser();
    const rival = await createUser();

    // Bracket #1 for the seed — the viewer joins it and it starts.
    const first = await seedDash("DISCJOIN_ALIVE", 2);
    for (const u of [viewer, rival]) {
      const res = await request(
        server.baseUrl,
        "POST",
        `/tournaments/${first.id}/join`,
        { token: u.token, headers: FEATURES }
      );
      assert.ok(res.status === 200 || res.status === 201, `join ${res.status}`);
    }

    // Filling a bracket starts it, which mints the seed's NEXT open lobby.
    await renewTournamentSeeds();
    const next = await prisma.tournament.findFirst({
      where: { seedId: "seed-DISCJOIN_ALIVE", status: "PENDING" },
    });
    assert.ok(next, "a fresh PENDING lobby exists for the seed");
    assert.notEqual(next.id, first.id);

    // The viewer is alive in bracket #1, so joining #2 is rejected...
    const joinNext = await request(
      server.baseUrl,
      "POST",
      `/tournaments/${next.id}/join`,
      { token: viewer.token, headers: FEATURES }
    );
    assert.equal(joinNext.status, 409);
    assert.equal((await joinNext.json()).code, "ALREADY_IN_FEATURED");

    // ...so it must not be advertised as an available race to join.
    const summary = await discovery(viewer.token);
    assert.equal(summary.resolved.publicRaceCount, true);
    assert.equal(
      summary.publicRaceCount,
      0,
      "no joinable public races or brackets for this viewer"
    );
    // The featured card itself still surfaces (it flips to VIEW client-side).
    const card = summary.featuredTournaments.find((t) => t.id === next.id);
    assert.ok(card, "featured bracket still listed");
    assert.equal(card.joinable, false);
  });

  it("does not count a featured bracket with no open slots", async () => {
    const viewer = await createUser();
    const a = await createUser();
    const b = await createUser();

    const lobby = await seedDash("DISCJOIN_FULL", 2);
    for (const u of [a, b]) {
      const res = await request(
        server.baseUrl,
        "POST",
        `/tournaments/${lobby.id}/join`,
        { token: u.token, headers: FEATURES }
      );
      assert.ok(res.status === 200 || res.status === 201, `join ${res.status}`);
    }

    const summary = await discovery(viewer.token);
    assert.equal(summary.resolved.publicRaceCount, true);
    const full = summary.featuredTournaments.find((t) => t.id === lobby.id);
    if (full) {
      assert.equal(full.joinable, false);
    }
    assert.equal(
      summary.publicRaceCount,
      0,
      "a full bracket is not an available race to join"
    );
  });

  it("still counts (and marks joinable) a featured bracket the viewer can actually join", async () => {
    const viewer = await createUser();
    const lobby = await seedDash("DISCJOIN_OPEN", 4);

    const summary = await discovery(viewer.token);
    assert.equal(summary.publicRaceCount, 1);
    const card = summary.featuredTournaments.find((t) => t.id === lobby.id);
    assert.ok(card);
    assert.equal(card.joinable, true);

    // And the public listing agrees with the count.
    const listing = await publicTournaments(viewer.token);
    assert.equal(
      listing.featured.find((t) => t.id === lobby.id).joinable,
      true
    );
  });
});
