const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");
const { cleanDatabase, getSharedServer, prisma, request } = require("./setup");

const HEADERS = {
  "X-Client-Features": "home_suggested_races,tournaments,characters",
};

let server;
let nextUser = 0;

async function user(displayName) {
  const response = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: `featured-http-${++nextUser}` },
  });
  const body = await response.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    token: body.sessionToken,
    body: { displayName },
  });
  await request(server.baseUrl, "GET", "/races", {
    token: body.sessionToken,
    headers: HEADERS,
  });
  return { id: body.user.id, token: body.sessionToken };
}

// These rows are test fixtures only. Every asserted product behavior below is
// exercised through its public HTTP endpoint; worker and settlement mechanics
// are covered in test/jobs and test/commands.
async function featuredFixture() {
  const [four, eight] = await Promise.all([
    prisma.tournamentSeed.create({
      data: {
        id: "seed-tournament-daily-dash",
        kind: "DAILY_DASH",
        name: "4 Racer Tourney",
        bracketSize: 4,
        matchupDurationDays: 2,
        powerupsEnabled: true,
        championPrizeCoins: 150,
        active: true,
      },
    }),
    prisma.tournamentSeed.create({
      data: {
        id: "seed-tournament-weekly-showdown",
        kind: "WEEKLY_SHOWDOWN",
        name: "8 Racer Tourney",
        bracketSize: 8,
        matchupDurationDays: 2,
        powerupsEnabled: true,
        championPrizeCoins: 300,
        active: true,
      },
    }),
  ]);
  const common = {
    status: "PENDING",
    buyInAmount: 0,
    potCoins: 0,
    powerupsEnabled: true,
    isPublic: true,
  };
  const [fourLobby, eightLobby] = await Promise.all([
    prisma.tournament.create({
      data: {
        ...common,
        seedId: four.id,
        name: four.name,
        bracketSize: 4,
        matchupDurationDays: 2,
        totalRounds: 2,
        championPrizeCoinsSnapshot: 150,
      },
    }),
    prisma.tournament.create({
      data: {
        ...common,
        seedId: eight.id,
        name: eight.name,
        bracketSize: 8,
        matchupDurationDays: 2,
        totalRounds: 3,
        championPrizeCoinsSnapshot: 300,
      },
    }),
  ]);
  return { four, eight, fourLobby, eightLobby };
}

describe("featured tournament public HTTP behavior — integration", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextUser = 0;
  });

  it("suggests a joinable other seed, enforces same-seed rejection, allows eliminated re-entry, and gates identity", async () => {
    const { four, eight, fourLobby, eightLobby } = await featuredFixture();
    const [viewer, fillerA, fillerB, fillerC] = await Promise.all([
      user("Viewer"),
      user("Filler A"),
      user("Filler B"),
      user("Filler C"),
    ]);

    for (const entrant of [viewer, fillerA, fillerB, fillerC]) {
      const joined = await request(server.baseUrl, "POST", `/tournaments/${fourLobby.id}/join`, {
        token: entrant.token,
        headers: HEADERS,
      });
      assert.equal(joined.status, 201);
    }

    const suggested = await request(server.baseUrl, "GET", "/home/suggested-races", {
      token: viewer.token,
      headers: HEADERS,
    });
    assert.equal(suggested.status, 200);
    const tournaments = (await suggested.json()).suggestions.filter(
      (entry) => entry.kind === "TOURNAMENT"
    );
    assert.ok(tournaments.some((entry) => entry.id === eightLobby.id));
    assert.equal(tournaments.some((entry) => entry.seedKind === four.kind), false);

    const crossSeed = await request(server.baseUrl, "POST", `/tournaments/${eightLobby.id}/join`, {
      token: viewer.token,
      headers: HEADERS,
    });
    assert.equal(crossSeed.status, 201);

    const secondFourLobby = await prisma.tournament.create({
      data: {
        seedId: four.id,
        name: four.name,
        status: "PENDING",
        bracketSize: 4,
        matchupDurationDays: 2,
        buyInAmount: 0,
        potCoins: 0,
        powerupsEnabled: true,
        isPublic: true,
        totalRounds: 2,
        championPrizeCoinsSnapshot: 150,
      },
    });
    const sameSeed = await request(server.baseUrl, "POST", `/tournaments/${secondFourLobby.id}/join`, {
      token: viewer.token,
      headers: HEADERS,
    });
    assert.equal(sameSeed.status, 409);
    assert.equal((await sameSeed.json()).code, "ALREADY_IN_FEATURED");

    await prisma.tournamentParticipant.update({
      where: { tournamentId_userId: { tournamentId: fourLobby.id, userId: viewer.id } },
      data: { eliminatedInRound: 1 },
    });
    const rejoined = await request(server.baseUrl, "POST", `/tournaments/${secondFourLobby.id}/join`, {
      token: viewer.token,
      headers: HEADERS,
    });
    assert.equal(rejoined.status, 201);

    const hat = await prisma.shopItem.create({
      data: {
        sku: "featured-http-identity-hat",
        name: "Identity Hat",
        slot: "HEAD",
        priceCoins: 0,
        assetKey: "identity_hat",
      },
    });
    await prisma.userEquippedAccessory.create({
      data: { userId: viewer.id, slot: "HEAD", shopItemId: hat.id },
    });
    const characters = await request(server.baseUrl, "GET", "/races", {
      token: viewer.token,
      headers: HEADERS,
    });
    const characterSummary = (await characters.json()).tournaments.find(
      (entry) => entry.id === fourLobby.id
    );
    assert.deepEqual(characterSummary.myIdentity, {
      displayName: "Viewer",
      animal: null,
      equippedAccessories: [{ slot: "HEAD", assetId: "identity_hat" }],
    });

    const oldCharacters = await request(server.baseUrl, "GET", "/races", {
      token: viewer.token,
      headers: { "X-Client-Features": "tournaments" },
    });
    const legacySummary = (await oldCharacters.json()).tournaments.find(
      (entry) => entry.id === fourLobby.id
    );
    assert.equal("myIdentity" in legacySummary, false);
    void eight;
  });
});
