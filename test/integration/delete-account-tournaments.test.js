const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  disconnectDatabase,
  prisma,
  request,
  getSharedServer,
  getBaseUrl,
} = require("./setup");

const { SENTINEL_APPLE_ID } = require("../../src/commands/deleteUserAccount");

async function createTournament(overrides = {}) {
  return prisma.tournament.create({
    data: {
      name: overrides.name || "Daily Dash",
      status: overrides.status || "PENDING",
      bracketSize: 4,
      totalRounds: 2,
      matchupDurationDays: 1,
      ...overrides,
    },
  });
}

async function joinTournament(tournamentId, userId, overrides = {}) {
  return prisma.tournamentParticipant.create({
    data: {
      tournamentId,
      userId,
      status: "ACCEPTED",
      ...overrides,
    },
  });
}

describe("DELETE /auth/account with tournament participation", () => {
  let baseUrl;

  before(async () => {
    await getSharedServer();
    baseUrl = getBaseUrl();
  });

  after(async () => {
    await disconnectDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("deletes an account that is in a live tournament", async () => {
    const { user, token } = await createTestUser({ displayName: "Bracket Bob" });
    const tournament = await createTournament({ status: "ACTIVE" });
    await joinTournament(tournament.id, user.id);

    const response = await request(baseUrl, "DELETE", "/auth/account", {
      token,
    });

    assert.equal(response.status, 204);

    const stillThere = await prisma.user.findUnique({ where: { id: user.id } });
    assert.equal(stillThere, null);

    // Live tournament: the participant row is removed outright, matching how
    // live race participation is handled.
    const remaining = await prisma.tournamentParticipant.findMany({
      where: { tournamentId: tournament.id },
    });
    assert.equal(remaining.length, 0);
  });

  it("forfeits a held tournament buy-in into the pot", async () => {
    const { user, token } = await createTestUser();
    const tournament = await createTournament({
      status: "ACTIVE",
      buyInAmount: 50,
      potCoins: 50,
    });
    await joinTournament(tournament.id, user.id, {
      buyInAmount: 50,
      buyInStatus: "HELD",
    });

    const response = await request(baseUrl, "DELETE", "/auth/account", {
      token,
    });
    assert.equal(response.status, 204);

    const after = await prisma.tournament.findUnique({
      where: { id: tournament.id },
    });
    assert.equal(after.potCoins, 100);
  });

  it("reassigns finished-tournament participation to the sentinel user", async () => {
    const { user, token } = await createTestUser({ displayName: "Past Champ" });
    const tournament = await createTournament({
      status: "COMPLETED",
      championUserId: user.id,
      creatorId: user.id,
    });
    await joinTournament(tournament.id, user.id, { seed: 0 });

    const response = await request(baseUrl, "DELETE", "/auth/account", {
      token,
    });
    assert.equal(response.status, 204);

    const sentinel = await prisma.user.findUnique({
      where: { appleId: SENTINEL_APPLE_ID },
    });
    assert.ok(sentinel, "sentinel user should exist");

    // History is preserved: the bracket slot survives, owned by the sentinel.
    const participants = await prisma.tournamentParticipant.findMany({
      where: { tournamentId: tournament.id },
    });
    assert.equal(participants.length, 1);
    assert.equal(participants[0].userId, sentinel.id);
    assert.equal(participants[0].seed, 0);

    const after = await prisma.tournament.findUnique({
      where: { id: tournament.id },
    });
    assert.equal(after.championUserId, sentinel.id);
    assert.equal(after.creatorId, sentinel.id);
  });

  it("drops the row instead of colliding when the sentinel is already a participant", async () => {
    const { user, token } = await createTestUser();
    const tournament = await createTournament({ status: "COMPLETED" });

    // A previously deleted user already occupies the sentinel's slot in this
    // bracket, so reassigning would violate the (tournamentId, userId) unique.
    const { user: other, token: otherToken } = await createTestUser();
    await joinTournament(tournament.id, other.id);
    const first = await request(baseUrl, "DELETE", "/auth/account", {
      token: otherToken,
    });
    assert.equal(first.status, 204);

    await joinTournament(tournament.id, user.id);

    const response = await request(baseUrl, "DELETE", "/auth/account", {
      token,
    });
    assert.equal(response.status, 204);

    const sentinel = await prisma.user.findUnique({
      where: { appleId: SENTINEL_APPLE_ID },
    });
    const participants = await prisma.tournamentParticipant.findMany({
      where: { tournamentId: tournament.id },
    });
    assert.equal(participants.length, 1);
    assert.equal(participants[0].userId, sentinel.id);
  });

  it("deletes an account spanning live and finished tournaments at once", async () => {
    const { user, token } = await createTestUser();
    const live = await createTournament({ status: "PENDING", name: "Live" });
    const done = await createTournament({ status: "COMPLETED", name: "Done" });
    await joinTournament(live.id, user.id);
    await joinTournament(done.id, user.id);

    const response = await request(baseUrl, "DELETE", "/auth/account", {
      token,
    });
    assert.equal(response.status, 204);

    assert.equal(
      await prisma.tournamentParticipant.count({ where: { tournamentId: live.id } }),
      0
    );
    assert.equal(
      await prisma.tournamentParticipant.count({ where: { tournamentId: done.id } }),
      1
    );
  });
});
