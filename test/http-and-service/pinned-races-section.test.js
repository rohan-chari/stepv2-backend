const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");

const TOURNAMENT_FEATURES = { "X-Client-Features": "tournaments" };

async function createAcceptedTournament(users, { status = "ACTIVE" } = {}) {
  const tournament = await prisma.tournament.create({
    data: {
      creatorId: users[0].user.id,
      name: "Pinned tournament",
      status,
      bracketSize: 4,
      matchupDurationDays: 1,
      totalRounds: 2,
      currentRound: status === "ACTIVE" ? 1 : 0,
      startedAt: status === "ACTIVE" ? new Date() : null,
    },
  });
  await prisma.tournamentParticipant.createMany({
    data: users.map(({ user }, index) => ({
      tournamentId: tournament.id,
      userId: user.id,
      status: "ACCEPTED",
      seed: index,
      joinedAt: new Date(Date.now() - 60000 + index),
    })),
  });
  return tournament;
}

describe("pinned races section backend contracts", () => {
  let server;

  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("PUT favorite is validated, idempotent, and projected by GET /races", async () => {
    const owner = await createTestUser({ displayName: "Pinned owner" });
    const tournament = await createAcceptedTournament([owner]);

    const malformed = await request(
      server.baseUrl,
      "PUT",
      `/tournaments/${tournament.id}/favorite`,
      { token: owner.token, body: { favorite: "yes" } },
    );
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, "INVALID_FAVORITE");

    const first = await request(
      server.baseUrl,
      "PUT",
      `/tournaments/${tournament.id}/favorite`,
      { token: owner.token, body: { favorite: true } },
    );
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.deepEqual(Object.keys(firstBody).sort(), [
      "favoritedAt",
      "isFavorite",
      "tournamentId",
    ]);
    assert.equal(firstBody.tournamentId, tournament.id);
    assert.equal(firstBody.isFavorite, true);
    assert.ok(Date.parse(firstBody.favoritedAt));

    const repeat = await request(
      server.baseUrl,
      "PUT",
      `/tournaments/${tournament.id}/favorite`,
      { token: owner.token, body: { favorite: true } },
    );
    assert.equal(repeat.status, 200);
    assert.equal((await repeat.json()).favoritedAt, firstBody.favoritedAt);

    const listed = await request(server.baseUrl, "GET", "/races", {
      token: owner.token,
      headers: TOURNAMENT_FEATURES,
    });
    assert.equal(listed.status, 200);
    const listedTournament = (await listed.json()).tournaments.find(
      (row) => row.id === tournament.id,
    );
    assert.equal(listedTournament.isFavorite, true);
    assert.equal(listedTournament.favoritedAt, firstBody.favoritedAt);

    const cleared = await request(
      server.baseUrl,
      "PUT",
      `/tournaments/${tournament.id}/favorite`,
      { token: owner.token, body: { favorite: false } },
    );
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), {
      tournamentId: tournament.id,
      isFavorite: false,
      favoritedAt: null,
    });
  });

  it("is membership-protected, rejects invitations, and keeps unauthenticated errors safe", async () => {
    const owner = await createTestUser({ displayName: "Tournament owner" });
    const stranger = await createTestUser({ displayName: "Tournament stranger" });
    const invitee = await createTestUser({ displayName: "Tournament invitee" });
    const tournament = await createAcceptedTournament([owner]);
    await prisma.tournamentParticipant.create({
      data: {
        tournamentId: tournament.id,
        userId: invitee.user.id,
        status: "INVITED",
      },
    });

    const unauthenticated = await request(
      server.baseUrl,
      "PUT",
      `/tournaments/${tournament.id}/favorite`,
      { body: { favorite: true } },
    );
    assert.equal(unauthenticated.status, 401);

    for (const token of [stranger.token, invitee.token]) {
      const forbidden = await request(
        server.baseUrl,
        "PUT",
        `/tournaments/${tournament.id}/favorite`,
        { token, body: { favorite: true } },
      );
      assert.equal(forbidden.status, 404);
      assert.equal((await forbidden.json()).code, "TOURNAMENT_NOT_FOUND");
    }

    const unavailable = await request(
      server.baseUrl,
      "PUT",
      "/tournaments/not-a-member/favorite",
      { token: owner.token, body: { favorite: true } },
    );
    assert.equal(unavailable.status, 404);
    assert.equal((await unavailable.json()).code, "TOURNAMENT_NOT_FOUND");
  });

  it("projects caller-specific favorite state and preserves old GET /races responses", async () => {
    const owner = await createTestUser({ displayName: "Favorite owner" });
    const teammate = await createTestUser({ displayName: "Favorite teammate" });
    const tournament = await createAcceptedTournament([owner, teammate]);

    const setFavorite = await request(
      server.baseUrl,
      "PUT",
      `/tournaments/${tournament.id}/favorite`,
      { token: owner.token, body: { favorite: true } },
    );
    assert.equal(setFavorite.status, 200);

    const [ownerList, teammateList, oldClientList] = await Promise.all([
      request(server.baseUrl, "GET", "/races", {
        token: owner.token,
        headers: TOURNAMENT_FEATURES,
      }),
      request(server.baseUrl, "GET", "/races", {
        token: teammate.token,
        headers: TOURNAMENT_FEATURES,
      }),
      request(server.baseUrl, "GET", "/races", { token: owner.token }),
    ]);
    assert.equal(ownerList.status, 200);
    assert.equal(teammateList.status, 200);
    assert.equal(oldClientList.status, 200);

    const ownerTournament = (await ownerList.json()).tournaments.find(
      (row) => row.id === tournament.id,
    );
    const teammateTournament = (await teammateList.json()).tournaments.find(
      (row) => row.id === tournament.id,
    );
    assert.equal(ownerTournament.isFavorite, true);
    assert.ok(Date.parse(ownerTournament.favoritedAt));
    assert.equal(teammateTournament.isFavorite, false);
    assert.equal(teammateTournament.favoritedAt, null);
    assert.equal(Object.hasOwn(await oldClientList.json(), "tournaments"), false);
  });
});
