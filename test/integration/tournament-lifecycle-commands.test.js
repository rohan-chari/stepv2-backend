const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");

// Phase 6 groundwork (AUDIT.md): baseline coverage for the four tournament
// lifecycle commands that had none — kickTournamentParticipant,
// inviteToTournament, createTournamentShareLink, forfeitTournament — driven
// end-to-end through the real routes, ahead of any command-pair unification.

let server;
let nextAppleId = 0;

const FEAT = "tournaments,characters";

function authReq(method, path, { body, token, features = FEAT } = {}) {
  return request(server.baseUrl, method, path, {
    body,
    token,
    headers: features ? { "X-Client-Features": features } : {},
  });
}

// Create a user; `features` controls the sticky clientFeatures stamped onto the
// user row (null = no features recorded — an out-of-date build).
async function createUser(displayName, { features = FEAT } = {}) {
  const appleId = `apple-tlc-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  const token = body.sessionToken;
  const userId = body.user.id;
  if (displayName) {
    await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      body: { displayName },
      token,
    });
  }
  if (features) {
    await authReq("GET", "/races", { token, features });
  }
  return { userId, token };
}

async function befriend(userIdA, userIdB) {
  await prisma.friendship.create({
    data: { requesterId: userIdA, addresseeId: userIdB, status: "ACCEPTED" },
  });
}

async function setCoins(userId, coins) {
  await prisma.user.update({ where: { id: userId }, data: { coins } });
}

async function createTournament(token, overrides = {}) {
  const res = await authReq("POST", "/tournaments", {
    token,
    body: {
      name: overrides.name || "Lifecycle Cup",
      bracketSize: overrides.bracketSize || 4,
      matchupDurationDays: overrides.matchupDurationDays || 1,
      buyInAmount: overrides.buyInAmount || 0,
      isPublic: overrides.isPublic !== false,
      powerupsEnabled: false,
      inviteeIds: overrides.inviteeIds || [],
    },
  });
  assert.equal(res.status, 201);
  return (await res.json()).tournament;
}

async function participantRow(tournamentId, userId) {
  return prisma.tournamentParticipant.findUnique({
    where: { tournamentId_userId: { tournamentId, userId } },
  });
}

// Fill a 4-bracket so pop-when-full starts it (round-1 matchups spawn ACTIVE).
async function startedFourBracket() {
  const [a, b, c, d] = [
    await createUser("Alice"),
    await createUser("Bob"),
    await createUser("Cara"),
    await createUser("Dan"),
  ];
  const t = await createTournament(a.token, { bracketSize: 4 });
  for (const u of [b, c, d]) {
    const join = await authReq("POST", `/tournaments/${t.id}/join`, { token: u.token });
    assert.equal(join.status, 201);
  }
  const row = await prisma.tournament.findUnique({ where: { id: t.id } });
  assert.equal(row.status, "ACTIVE");
  return { a, b, c, d, tournamentId: t.id };
}

describe("tournament lifecycle commands — kick / invite / share-link / forfeit", () => {
  before(async () => {
    server = await getSharedServer();
  });
  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    await appSettings.setFlag("tournamentsEnabled", true);
  });

  // ---------------- kickTournamentParticipant ----------------

  it("kick happy path: creator kicks an ACCEPTED member from a PENDING lobby (soft-remove to DECLINED)", async () => {
    const a = await createUser("Alice");
    const b = await createUser("Bob");
    const t = await createTournament(a.token);
    assert.equal(
      (await authReq("POST", `/tournaments/${t.id}/join`, { token: b.token })).status,
      201
    );

    const res = await authReq("POST", `/tournaments/${t.id}/kick`, {
      token: a.token,
      body: { userId: b.userId },
    });
    assert.equal(res.status, 200);
    const { tournament } = await res.json();
    assert.equal(tournament.id, t.id);

    const row = await participantRow(t.id, b.userId);
    assert.equal(row.status, "DECLINED", "kick soft-removes, never deletes");
  });

  it("kick refunds a HELD buy-in and bumps buyInVersion", async () => {
    const a = await createUser("Alice");
    const b = await createUser("Bob");
    await setCoins(a.userId, 1000);
    await setCoins(b.userId, 1000);
    const t = await createTournament(a.token, { buyInAmount: 50 });
    assert.equal(
      (await authReq("POST", `/tournaments/${t.id}/join`, { token: b.token })).status,
      201
    );
    assert.equal((await prisma.user.findUnique({ where: { id: b.userId } })).coins, 950);

    const res = await authReq("POST", `/tournaments/${t.id}/kick`, {
      token: a.token,
      body: { userId: b.userId },
    });
    assert.equal(res.status, 200);

    assert.equal((await prisma.user.findUnique({ where: { id: b.userId } })).coins, 1000);
    const row = await participantRow(t.id, b.userId);
    assert.equal(row.buyInStatus, "REFUNDED");
    assert.equal(row.buyInVersion, 1, "refund bumps the version for a future re-hold");
    const refund = await prisma.coinTransaction.findFirst({
      where: { userId: b.userId, reason: "tournament_buy_in_refund" },
    });
    assert.equal(refund.amount, 50);
    assert.equal(refund.refId, `${t.id}:${b.userId}:v0`);
  });

  it("kick guards: non-creator 403, non-ACCEPTED target 404, started tournament 409, unknown tournament 404", async () => {
    const a = await createUser("Alice");
    const b = await createUser("Bob");
    const stranger = await createUser("Sam");
    const t = await createTournament(a.token);
    await authReq("POST", `/tournaments/${t.id}/join`, { token: b.token });

    const nonCreator = await authReq("POST", `/tournaments/${t.id}/kick`, {
      token: b.token,
      body: { userId: a.userId },
    });
    assert.equal(nonCreator.status, 403);
    assert.equal((await nonCreator.json()).code, "NOT_CREATOR");

    // Target exists as a user but has no ACCEPTED row in this lobby.
    const notInLobby = await authReq("POST", `/tournaments/${t.id}/kick`, {
      token: a.token,
      body: { userId: stranger.userId },
    });
    assert.equal(notInLobby.status, 404);
    assert.equal((await notInLobby.json()).code, "PARTICIPANT_NOT_FOUND");

    const unknown = await authReq("POST", `/tournaments/00000000-0000-0000-0000-000000000000/kick`, {
      token: a.token,
      body: { userId: b.userId },
    });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).code, "TOURNAMENT_NOT_FOUND");

    const started = await startedFourBracket();
    const late = await authReq("POST", `/tournaments/${started.tournamentId}/kick`, {
      token: started.a.token,
      body: { userId: started.b.userId },
    });
    assert.equal(late.status, 409);
    assert.equal((await late.json()).code, "TOURNAMENT_NOT_PENDING");
  });

  // ---------------- inviteToTournament ----------------

  it("invite happy path: accepted friend with the tournaments feature is invited", async () => {
    const a = await createUser("Alice");
    const e = await createUser("Eve");
    await befriend(a.userId, e.userId);
    const t = await createTournament(a.token);

    const res = await authReq("POST", `/tournaments/${t.id}/invite`, {
      token: a.token,
      body: { userIds: [e.userId] },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.invited, [e.userId]);
    assert.deepEqual(body.needsUpdate, []);
    assert.equal(body.tournament.id, t.id);

    const row = await participantRow(t.id, e.userId);
    assert.equal(row.status, "INVITED");
  });

  it("invite partial success: skips non-friends/already-in/self silently, reports featureless friends in needsUpdate", async () => {
    const a = await createUser("Alice");
    const b = await createUser("Bob"); // will be ACCEPTED in the lobby
    const goodFriend = await createUser("Gwen");
    const oldFriend = await createUser("Olga", { features: "characters" }); // no tournaments token
    const nonFriend = await createUser("Nadia");
    await befriend(a.userId, goodFriend.userId);
    await befriend(a.userId, oldFriend.userId);
    const t = await createTournament(a.token);
    await authReq("POST", `/tournaments/${t.id}/join`, { token: b.token });

    const res = await authReq("POST", `/tournaments/${t.id}/invite`, {
      token: a.token,
      body: {
        userIds: [goodFriend.userId, nonFriend.userId, oldFriend.userId, b.userId, a.userId],
      },
    });
    assert.equal(res.status, 200, "a mixed batch never fails wholesale");
    const body = await res.json();
    assert.deepEqual(body.invited, [goodFriend.userId]);
    assert.deepEqual(body.needsUpdate, [oldFriend.userId]);

    assert.equal((await participantRow(t.id, goodFriend.userId)).status, "INVITED");
    assert.equal(await participantRow(t.id, nonFriend.userId), null, "non-friend gets no row");
    assert.equal(await participantRow(t.id, oldFriend.userId), null, "needsUpdate gets no row");
    assert.equal((await participantRow(t.id, b.userId)).status, "ACCEPTED", "already-in untouched");
  });

  it("invite re-flips a DECLINED row back to INVITED", async () => {
    const a = await createUser("Alice");
    const e = await createUser("Eve");
    await befriend(a.userId, e.userId);
    const t = await createTournament(a.token);

    await authReq("POST", `/tournaments/${t.id}/invite`, {
      token: a.token,
      body: { userIds: [e.userId] },
    });
    const decline = await authReq("PUT", `/tournaments/${t.id}/respond`, {
      token: e.token,
      body: { accept: false },
    });
    assert.equal(decline.status, 200);
    assert.equal((await participantRow(t.id, e.userId)).status, "DECLINED");

    const again = await authReq("POST", `/tournaments/${t.id}/invite`, {
      token: a.token,
      body: { userIds: [e.userId] },
    });
    assert.equal(again.status, 200);
    const body = await again.json();
    assert.deepEqual(body.invited, [e.userId]);
    assert.equal((await participantRow(t.id, e.userId)).status, "INVITED");
  });

  it("invite guards: non-creator 403, started tournament 409", async () => {
    const a = await createUser("Alice");
    const b = await createUser("Bob");
    const t = await createTournament(a.token);
    await authReq("POST", `/tournaments/${t.id}/join`, { token: b.token });

    const nonCreator = await authReq("POST", `/tournaments/${t.id}/invite`, {
      token: b.token,
      body: { userIds: [a.userId] },
    });
    assert.equal(nonCreator.status, 403);
    assert.equal((await nonCreator.json()).code, "NOT_CREATOR");

    const started = await startedFourBracket();
    const extra = await createUser("Zed");
    await befriend(started.a.userId, extra.userId);
    const late = await authReq("POST", `/tournaments/${started.tournamentId}/invite`, {
      token: started.a.token,
      body: { userIds: [extra.userId] },
    });
    assert.equal(late.status, 409);
    assert.equal((await late.json()).code, "TOURNAMENT_NOT_PENDING");
  });

  // ---------------- createTournamentShareLink ----------------

  it("share-link: creator gets the creation-minted token back with a url; idempotent across calls and callers", async () => {
    const a = await createUser("Alice");
    const b = await createUser("Bob");
    const t = await createTournament(a.token);
    await authReq("POST", `/tournaments/${t.id}/join`, { token: b.token });

    const res = await authReq("POST", `/tournaments/${t.id}/share-link`, { token: a.token });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.match(body.shareToken, /^[0-9a-f]{32}$/);
    assert.ok(body.url.includes(body.shareToken));
    const row = await prisma.tournament.findUnique({ where: { id: t.id } });
    assert.equal(body.shareToken, row.shareToken, "reuses the creation-minted token");

    // Idempotent for the creator AND for any other ACCEPTED participant.
    const again = await authReq("POST", `/tournaments/${t.id}/share-link`, { token: a.token });
    assert.equal((await again.json()).shareToken, body.shareToken);
    const byMember = await authReq("POST", `/tournaments/${t.id}/share-link`, { token: b.token });
    assert.equal(byMember.status, 201);
    assert.equal((await byMember.json()).shareToken, body.shareToken);
  });

  it("share-link: defensively re-mints when the stored token is absent", async () => {
    const a = await createUser("Alice");
    const t = await createTournament(a.token);
    await prisma.tournament.update({ where: { id: t.id }, data: { shareToken: null } });

    const res = await authReq("POST", `/tournaments/${t.id}/share-link`, { token: a.token });
    assert.equal(res.status, 201);
    const { shareToken } = await res.json();
    assert.match(shareToken, /^[0-9a-f]{32}$/);
    const row = await prisma.tournament.findUnique({ where: { id: t.id } });
    assert.equal(row.shareToken, shareToken, "new token persisted");
  });

  it("share-link guards: INVITED-only 403, stranger 403, unknown tournament 404", async () => {
    const a = await createUser("Alice");
    const invitee = await createUser("Ivy");
    const stranger = await createUser("Sam");
    await befriend(a.userId, invitee.userId);
    const t = await createTournament(a.token);
    await authReq("POST", `/tournaments/${t.id}/invite`, {
      token: a.token,
      body: { userIds: [invitee.userId] },
    });

    const notAccepted = await authReq("POST", `/tournaments/${t.id}/share-link`, {
      token: invitee.token,
    });
    assert.equal(notAccepted.status, 403);
    assert.equal((await notAccepted.json()).code, "NOT_INVITED");

    const outsider = await authReq("POST", `/tournaments/${t.id}/share-link`, {
      token: stranger.token,
    });
    assert.equal(outsider.status, 403);

    const unknown = await authReq(
      "POST",
      `/tournaments/00000000-0000-0000-0000-000000000000/share-link`,
      { token: a.token }
    );
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).code, "TOURNAMENT_NOT_FOUND");
  });

  // ---------------- forfeitTournament ----------------

  it("forfeit: freezes the forfeiter, unconditionally completes the matchup for the opponent, and advances", async () => {
    const { a, tournamentId } = await startedFourBracket();

    const matchup = await prisma.race.findFirst({
      where: {
        tournamentId,
        tournamentRound: 1,
        participants: { some: { userId: a.userId } },
      },
      include: { participants: { where: { status: "ACCEPTED" } } },
    });
    const opponent = matchup.participants.find((p) => p.userId !== a.userId);

    const res = await authReq("POST", `/tournaments/${tournamentId}/forfeit`, {
      token: a.token,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).tournament.id, tournamentId);

    const settled = await prisma.race.findUnique({ where: { id: matchup.id } });
    assert.equal(settled.status, "COMPLETED", "matchup completes despite time remaining");

    const mine = await prisma.raceParticipant.findFirst({
      where: { raceId: matchup.id, userId: a.userId },
    });
    assert.ok(mine.forfeitedAt, "forfeiter is stamped");

    assert.equal(
      (await participantRow(tournamentId, a.userId)).eliminatedInRound,
      1,
      "forfeiter eliminated in round 1"
    );
    assert.equal(
      (await participantRow(tournamentId, opponent.userId)).eliminatedInRound,
      null,
      "opponent advances"
    );
  });

  it("forfeit 409 NO_LIVE_MATCHUP: eliminated player, between-rounds winner, and non-participant", async () => {
    const { a, b, c, d, tournamentId } = await startedFourBracket();
    const outsider = await createUser("Out");

    const matchup = await prisma.race.findFirst({
      where: {
        tournamentId,
        tournamentRound: 1,
        participants: { some: { userId: a.userId } },
      },
      include: { participants: { where: { status: "ACCEPTED" } } },
    });
    const opponent = matchup.participants.find((p) => p.userId !== a.userId);

    assert.equal(
      (await authReq("POST", `/tournaments/${tournamentId}/forfeit`, { token: a.token })).status,
      200
    );

    // Eliminated player has no live matchup.
    const again = await authReq("POST", `/tournaments/${tournamentId}/forfeit`, {
      token: a.token,
    });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).code, "NO_LIVE_MATCHUP");

    // The winner is between rounds (other semifinal still running) — no live
    // matchup for them either.
    const winner = [b, c, d].find((u) => u.userId === opponent.userId);
    const between = await authReq("POST", `/tournaments/${tournamentId}/forfeit`, {
      token: winner.token,
    });
    assert.equal(between.status, 409);
    assert.equal((await between.json()).code, "NO_LIVE_MATCHUP");

    // A user with no relation to the tournament gets the same 409.
    const unrelated = await authReq("POST", `/tournaments/${tournamentId}/forfeit`, {
      token: outsider.token,
    });
    assert.equal(unrelated.status, 409);
    assert.equal((await unrelated.json()).code, "NO_LIVE_MATCHUP");

    // Unknown tournament id is a 404, not a 409.
    const unknown = await authReq(
      "POST",
      `/tournaments/00000000-0000-0000-0000-000000000000/forfeit`,
      { token: a.token }
    );
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).code, "TOURNAMENT_NOT_FOUND");
  });
});
