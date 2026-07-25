const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { completeRace } = require("../../src/modules/races/commands/completeRace");
const {
  renewTournamentSeeds,
} = require("../../src/modules/tournaments/jobs/tournamentSeedRenewal");
const { appSettings } = require("../../src/shared/config/appSettings");

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

// Create a user and record the tournaments client feature stickily (via an
// authed request carrying the header).
async function createUser(displayName) {
  const appleId = `apple-t-${++nextAppleId}`;
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
  // Stamp the sticky tournaments feature.
  await authReq("GET", "/races", { token });
  return { userId, token };
}

async function setCoins(userId, coins) {
  await prisma.user.update({ where: { id: userId }, data: { coins } });
}

async function createTournament(token, overrides = {}) {
  const res = await authReq("POST", "/tournaments", {
    token,
    body: {
      name: overrides.name || "Test Cup",
      bracketSize: overrides.bracketSize || 4,
      matchupDurationDays: overrides.matchupDurationDays || 1,
      buyInAmount: overrides.buyInAmount || 0,
      isPublic: overrides.isPublic !== false,
      powerupsEnabled: overrides.powerupsEnabled || false,
      powerupStepInterval: overrides.powerupStepInterval,
      inviteeIds: overrides.inviteeIds || [],
    },
  });
  return res;
}

// Settle a matchup race deterministically by writing totalSteps then completing
// it through the tournament branch (which recomputes the winner + advances).
async function settleMatchup(raceId, stepsByUser) {
  const participants = await prisma.raceParticipant.findMany({
    where: { raceId, status: "ACCEPTED" },
  });
  for (const p of participants) {
    await prisma.raceParticipant.update({
      where: { id: p.id },
      data: { totalSteps: stepsByUser[p.userId] ?? 0 },
    });
  }
  await completeRace({
    raceId,
    winnerUserId: participants[0].userId,
    participantUserIds: participants.map((p) => p.userId),
  });
}

async function fillFourBracket({ paid = false } = {}) {
  const [a, b, c, d] = await Promise.all([
    createUser("Alice"),
    createUser("Bob"),
    createUser("Cara"),
    createUser("Dan"),
  ]);
  if (paid) {
    await Promise.all([a, b, c, d].map((u) => setCoins(u.userId, 1000)));
  }
  const createRes = await createTournament(a.token, {
    bracketSize: 4,
    buyInAmount: paid ? 50 : 0,
    isPublic: true,
  });
  const { tournament } = await createRes.json();
  // b, c fill to 3; d fills the 4th slot -> pop-when-full start.
  await authReq("POST", `/tournaments/${tournament.id}/join`, { token: b.token });
  await authReq("POST", `/tournaments/${tournament.id}/join`, { token: c.token });
  const joinD = await authReq("POST", `/tournaments/${tournament.id}/join`, {
    token: d.token,
  });
  return { users: { a, b, c, d }, tournamentId: tournament.id, joinD };
}

describe("tournaments — integration", () => {
  before(async () => {
    server = await getSharedServer();
  });
  after(async () => {});
  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    await appSettings.setFlag("tournamentsEnabled", true);
    // Buy-in brackets. App-funded prize pools now default ON, which zeroes
    // buy-ins at create, so this suite pins the flag OFF: it covers the
    // buy-in model, which is still live code reachable via the kill switch.
    await appSettings.setFlag("fundedPrizePoolsEnabled", false);
  });

  it("full happy path (free 4-bracket): pop-when-full start, advancement, champion, zero ledger", async () => {
    const { users, tournamentId, joinD } = await fillFourBracket();
    assert.equal(joinD.status, 201);

    let t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
    assert.equal(t.status, "ACTIVE");
    assert.equal(t.currentRound, 1);
    assert.equal(t.potCoins, 0);

    // Round 1: two matchup races, WTA, 2 players, endsAt ~ +2 days (the
    // legacy matchupDurationDays: 1 in this fixture is clamped to the 2-day
    // minimum), not public.
    const round1 = await prisma.race.findMany({
      where: { tournamentId, tournamentRound: 1 },
      include: { participants: true },
      orderBy: { tournamentMatchIndex: "asc" },
    });
    assert.equal(round1.length, 2);
    for (const r of round1) {
      assert.equal(r.status, "ACTIVE");
      assert.equal(r.maxParticipants, 2);
      assert.equal(r.payoutPreset, "WINNER_TAKES_ALL");
      assert.equal(r.potCoins, 0);
      assert.equal(r.isPublic, false);
      assert.equal(r.participants.filter((p) => p.status === "ACCEPTED").length, 2);
      const span = new Date(r.endsAt).getTime() - new Date(r.startedAt).getTime();
      assert.equal(span, 2 * 24 * 60 * 60 * 1000);
    }

    // Settle round 1: first participant of each match wins.
    const r1winners = [];
    for (const r of round1) {
      const [p0, p1] = r.participants.filter((p) => p.status === "ACCEPTED");
      await settleMatchup(r.id, { [p0.userId]: 5000, [p1.userId]: 1000 });
      r1winners.push(p0.userId);
    }

    // Round 2 (final) created; round-1 losers eliminated.
    const round2 = await prisma.race.findMany({
      where: { tournamentId, tournamentRound: 2 },
      include: { participants: true },
    });
    assert.equal(round2.length, 1);
    t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
    assert.equal(t.currentRound, 2);
    const elim = await prisma.tournamentParticipant.count({
      where: { tournamentId, eliminatedInRound: 1 },
    });
    assert.equal(elim, 2);

    // Settle final.
    const finalRace = round2[0];
    const [f0, f1] = finalRace.participants.filter((p) => p.status === "ACCEPTED");
    await settleMatchup(finalRace.id, { [f0.userId]: 9000, [f1.userId]: 3000 });

    t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
    assert.equal(t.status, "COMPLETED");
    assert.equal(t.championUserId, f0.userId);
    assert.ok(t.completedAt);

    // Free tournament writes NO tournament ledger rows.
    const ledger = await prisma.coinTransaction.count({
      where: { reason: { startsWith: "tournament_" } },
    });
    assert.equal(ledger, 0);
    void users;
  });

  it("paid 4-bracket: pot committed, champion paid exactly the pot, idempotent on re-settle", async () => {
    const { users, tournamentId } = await fillFourBracket({ paid: true });

    let t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
    assert.equal(t.status, "ACTIVE");
    assert.equal(t.potCoins, 200); // 4 * 50

    // Everyone charged 50 at hold; committed at start.
    const holds = await prisma.coinTransaction.count({
      where: { reason: "tournament_buy_in_hold" },
    });
    assert.equal(holds, 4);

    const round1 = await prisma.race.findMany({
      where: { tournamentId, tournamentRound: 1 },
      include: { participants: true },
      orderBy: { tournamentMatchIndex: "asc" },
    });
    for (const r of round1) {
      const [p0, p1] = r.participants.filter((p) => p.status === "ACCEPTED");
      await settleMatchup(r.id, { [p0.userId]: 6000, [p1.userId]: 100 });
    }
    const finalRace = await prisma.race.findFirst({
      where: { tournamentId, tournamentRound: 2 },
      include: { participants: true },
    });
    const [f0, f1] = finalRace.participants.filter((p) => p.status === "ACCEPTED");
    await settleMatchup(finalRace.id, { [f0.userId]: 8000, [f1.userId]: 200 });

    t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
    assert.equal(t.status, "COMPLETED");
    const champ = t.championUserId;

    const payout = await prisma.coinTransaction.findMany({
      where: { reason: "tournament_payout" },
    });
    assert.equal(payout.length, 1);
    assert.equal(payout[0].userId, champ);
    assert.equal(payout[0].amount, 200);

    // Re-settling the final is idempotent (no second payout).
    await completeRace({
      raceId: finalRace.id,
      winnerUserId: f0.userId,
      participantUserIds: [f0.userId, f1.userId],
    });
    const payout2 = await prisma.coinTransaction.count({
      where: { reason: "tournament_payout" },
    });
    assert.equal(payout2, 1);
    void users;
  });

  it("old-client invisibility: no token -> no tournaments key, matchup races hidden; create without token -> UPDATE_REQUIRED", async () => {
    const { users, tournamentId } = await fillFourBracket();

    // A participant fetching /races WITHOUT the token: byte-identical shape (no
    // tournaments key) and no matchup race in any bucket.
    const noTokenRes = await request(server.baseUrl, "GET", "/races", {
      token: users.a.token,
      headers: {},
    });
    const noToken = await noTokenRes.json();
    assert.equal("tournaments" in noToken, false);
    const allNoToken = [...noToken.active, ...noToken.pending, ...noToken.completed];
    assert.equal(allNoToken.some((r) => r.name && r.name.includes("—")), false);

    // With the token, the tournaments key is present.
    const withTokenRes = await authReq("GET", "/races", { token: users.a.token });
    const withToken = await withTokenRes.json();
    assert.ok(Array.isArray(withToken.tournaments));
    assert.ok(withToken.tournaments.some((t) => t.id === tournamentId));

    // Create without the token -> UPDATE_REQUIRED.
    const noTokCreate = await request(server.baseUrl, "POST", "/tournaments", {
      token: users.b.token,
      headers: {},
      body: { name: "X", bracketSize: 4, matchupDurationDays: 1 },
    });
    assert.equal(noTokCreate.status, 403);
    assert.equal((await noTokCreate.json()).code, "UPDATE_REQUIRED");
  });

  it("every race-level mutation on a matchup race returns TOURNAMENT_RACE_LOCKED", async () => {
    const { users, tournamentId } = await fillFourBracket();
    const matchup = await prisma.race.findFirst({
      where: { tournamentId, tournamentRound: 1 },
      include: { participants: true },
    });
    const player = matchup.participants[0].userId;
    const tokenByUser = {
      [users.a.userId]: users.a.token,
      [users.b.userId]: users.b.token,
      [users.c.userId]: users.c.token,
      [users.d.userId]: users.d.token,
    };
    const token = tokenByUser[player];
    const rid = matchup.id;

    const calls = [
      ["POST", `/races/${rid}/join`, {}],
      ["PUT", `/races/${rid}/respond`, { accept: true }],
      ["POST", `/races/${rid}/invite`, { inviteeIds: [users.b.userId] }],
      ["POST", `/races/${rid}/leave`, {}],
      ["POST", `/races/${rid}/forfeit`, {}],
      ["POST", `/races/${rid}/share-link`, {}],
      ["PATCH", `/races/${rid}`, { name: "hax" }],
      ["DELETE", `/races/${rid}`, {}],
    ];
    for (const [method, path, body] of calls) {
      const res = await authReq(method, path, { token, body });
      assert.equal((await res.json()).code, "TOURNAMENT_RACE_LOCKED", `${method} ${path}`);
    }
  });

  it("kill switch: create/join blocked when off; already-active bracket still advances", async () => {
    const { tournamentId } = await fillFourBracket(); // starts ACTIVE
    await appSettings.setFlag("tournamentsEnabled", false);

    const u = await createUser("Zed");
    const create = await createTournament(u.token, { bracketSize: 4 });
    assert.equal(create.status, 403);
    assert.equal((await create.json()).code, "FEATURE_DISABLED");

    // In-flight bracket still advances to completion.
    const round1 = await prisma.race.findMany({
      where: { tournamentId, tournamentRound: 1 },
      include: { participants: true },
    });
    for (const r of round1) {
      const [p0, p1] = r.participants.filter((p) => p.status === "ACCEPTED");
      await settleMatchup(r.id, { [p0.userId]: 5000, [p1.userId]: 100 });
    }
    const finalRace = await prisma.race.findFirst({
      where: { tournamentId, tournamentRound: 2 },
      include: { participants: true },
    });
    const [f0, f1] = finalRace.participants.filter((p) => p.status === "ACCEPTED");
    await settleMatchup(finalRace.id, { [f0.userId]: 8000, [f1.userId]: 100 });
    const t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
    assert.equal(t.status, "COMPLETED");
  });

  it("exact tie advances the earlier tournament joiner (NOT a userId sort)", async () => {
    const { tournamentId } = await fillFourBracket();
    const matchup = await prisma.race.findFirst({
      where: { tournamentId, tournamentRound: 1 },
      include: { participants: true },
    });
    const [p0, p1] = matchup.participants.filter((p) => p.status === "ACCEPTED");
    const tps = await prisma.tournamentParticipant.findMany({
      where: { tournamentId, userId: { in: [p0.userId, p1.userId] } },
    });
    const joinedByUser = Object.fromEntries(tps.map((t) => [t.userId, t.joinedAt]));
    const earlier =
      new Date(joinedByUser[p0.userId]).getTime() <=
      new Date(joinedByUser[p1.userId]).getTime()
        ? p0.userId
        : p1.userId;

    await settleMatchup(matchup.id, { [p0.userId]: 4242, [p1.userId]: 4242 });
    const settled = await prisma.race.findUnique({ where: { id: matchup.id } });
    assert.equal(settled.winnerUserId, earlier);
  });

  it("forfeit completes the matchup for the opponent; NO_LIVE_MATCHUP otherwise", async () => {
    const { users, tournamentId } = await fillFourBracket();
    const matchup = await prisma.race.findFirst({
      where: { tournamentId, tournamentRound: 1 },
      include: { participants: true },
    });
    const [p0, p1] = matchup.participants.filter((p) => p.status === "ACCEPTED");
    const tokenByUser = {
      [users.a.userId]: users.a.token,
      [users.b.userId]: users.b.token,
      [users.c.userId]: users.c.token,
      [users.d.userId]: users.d.token,
    };
    // p0 forfeits their live matchup via the tournament endpoint.
    const res = await authReq("POST", `/tournaments/${tournamentId}/forfeit`, {
      token: tokenByUser[p0.userId],
    });
    assert.equal(res.status, 200);
    const settled = await prisma.race.findUnique({ where: { id: matchup.id } });
    assert.equal(settled.status, "COMPLETED");
    assert.equal(settled.winnerUserId, p1.userId);

    // A player with no live matchup (already eliminated p0) -> NO_LIVE_MATCHUP.
    const again = await authReq("POST", `/tournaments/${tournamentId}/forfeit`, {
      token: tokenByUser[p0.userId],
    });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).code, "NO_LIVE_MATCHUP");
  });

  it("cancel refunds all held buy-ins; leave->rejoin re-charges under a bumped version", async () => {
    const creator = await createUser("Host");
    const joiner = await createUser("Joiner");
    await setCoins(creator.userId, 1000);
    await setCoins(joiner.userId, 1000);

    const createRes = await createTournament(creator.token, {
      bracketSize: 4,
      buyInAmount: 50,
      isPublic: true,
    });
    const { tournament } = await createRes.json();
    const tid = tournament.id;

    // Joiner joins (hold v0), leaves (refund v0, version->1), rejoins (hold v1).
    await authReq("POST", `/tournaments/${tid}/join`, { token: joiner.token });
    await authReq("POST", `/tournaments/${tid}/leave`, { token: joiner.token });
    await authReq("POST", `/tournaments/${tid}/join`, { token: joiner.token });

    const joinerHolds = await prisma.coinTransaction.findMany({
      where: { userId: joiner.userId, reason: "tournament_buy_in_hold" },
      orderBy: { refId: "asc" },
    });
    assert.equal(joinerHolds.length, 2); // v0 and v1 both charged
    const refunds = await prisma.coinTransaction.count({
      where: { userId: joiner.userId, reason: "tournament_buy_in_refund" },
    });
    assert.equal(refunds, 1);

    // Cancel: refunds every held buy-in, flips CANCELLED.
    const cancel = await authReq("DELETE", `/tournaments/${tid}`, {
      token: creator.token,
    });
    assert.equal(cancel.status, 200);
    const t = await prisma.tournament.findUnique({ where: { id: tid } });
    assert.equal(t.status, "CANCELLED");
    // Both creator and joiner net zero (held then refunded).
    const users = await prisma.user.findMany({
      where: { id: { in: [creator.userId, joiner.userId] } },
    });
    for (const u of users) assert.equal(u.coins, 1000);
  });

  it("featured reconciler mints one open lobby per active seed, pops on fill, respawns, and honors the D12 alive-guard", async () => {
    // A featured seed: free 4-bracket, minted 150 prize.
    await prisma.tournamentSeed.create({
      data: {
        id: "seed-test-dash",
        kind: "TEST_DASH",
        name: "Test Dash",
        bracketSize: 4,
        matchupDurationDays: 1,
        powerupsEnabled: false,
        championPrizeCoins: 150,
        active: true,
      },
    });

    await renewTournamentSeeds();
    let lobbies = await prisma.tournament.findMany({
      where: { seedId: "seed-test-dash", status: "PENDING" },
    });
    assert.equal(lobbies.length, 1);
    // Idempotent across ticks.
    await renewTournamentSeeds();
    lobbies = await prisma.tournament.findMany({
      where: { seedId: "seed-test-dash", status: "PENDING" },
    });
    assert.equal(lobbies.length, 1);
    const lobbyId = lobbies[0].id;

    const [a, b, c, d] = await Promise.all([
      createUser("Fa"),
      createUser("Fb"),
      createUser("Fc"),
      createUser("Fd"),
    ]);
    await authReq("POST", `/tournaments/${lobbyId}/join`, { token: a.token });
    await authReq("POST", `/tournaments/${lobbyId}/join`, { token: b.token });
    await authReq("POST", `/tournaments/${lobbyId}/join`, { token: c.token });
    // 4th join fills -> pop-when-full start.
    await authReq("POST", `/tournaments/${lobbyId}/join`, { token: d.token });

    const popped = await prisma.tournament.findUnique({ where: { id: lobbyId } });
    assert.equal(popped.status, "ACTIVE");

    // D12: a still-alive participant can't join ANOTHER bracket of the same seed.
    // The reconciler respawns a fresh lobby; a's join must be rejected.
    await renewTournamentSeeds();
    const fresh = await prisma.tournament.findFirst({
      where: { seedId: "seed-test-dash", status: "PENDING" },
    });
    assert.ok(fresh && fresh.id !== lobbyId);
    const blocked = await authReq("POST", `/tournaments/${fresh.id}/join`, {
      token: a.token,
    });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).code, "ALREADY_IN_FEATURED");

    // Champion of a featured bracket gets exactly one minted reward.
    const round1 = await prisma.race.findMany({
      where: { tournamentId: lobbyId, tournamentRound: 1 },
      include: { participants: true },
    });
    for (const r of round1) {
      const [p0, p1] = r.participants.filter((p) => p.status === "ACCEPTED");
      await settleMatchup(r.id, { [p0.userId]: 7000, [p1.userId]: 100 });
    }
    const finalRace = await prisma.race.findFirst({
      where: { tournamentId: lobbyId, tournamentRound: 2 },
      include: { participants: true },
    });
    const [f0, f1] = finalRace.participants.filter((p) => p.status === "ACCEPTED");
    await settleMatchup(finalRace.id, { [f0.userId]: 9000, [f1.userId]: 100 });

    const minted = await prisma.coinTransaction.findMany({
      where: { reason: "tournament_champion_reward" },
    });
    assert.equal(minted.length, 1);
    assert.equal(minted[0].amount, 150);
    const potPay = await prisma.coinTransaction.count({
      where: { reason: "tournament_payout" },
    });
    assert.equal(potPay, 0); // free -> minted only, never pot
  });

  it("inactive seed cancels its open lobby and stops respawns", async () => {
    await prisma.tournamentSeed.create({
      data: {
        id: "seed-test-off",
        kind: "TEST_OFF",
        name: "Test Off",
        bracketSize: 4,
        matchupDurationDays: 1,
        championPrizeCoins: 150,
        active: true,
      },
    });
    await renewTournamentSeeds();
    let lobby = await prisma.tournament.findFirst({
      where: { seedId: "seed-test-off", status: "PENDING" },
    });
    assert.ok(lobby);

    await prisma.tournamentSeed.update({
      where: { id: "seed-test-off" },
      data: { active: false },
    });
    await renewTournamentSeeds();

    const cancelled = await prisma.tournament.findUnique({
      where: { id: lobby.id },
    });
    assert.equal(cancelled.status, "CANCELLED");
    const pendings = await prisma.tournament.count({
      where: { seedId: "seed-test-off", status: "PENDING" },
    });
    assert.equal(pendings, 0);
  });

  it("spectate: a tournament participant can read a matchup they're not in; randoms + non-tournament races still 403", async () => {
    const { users, tournamentId } = await fillFourBracket();
    const tokenByUser = {
      [users.a.userId]: users.a.token,
      [users.b.userId]: users.b.token,
      [users.c.userId]: users.c.token,
      [users.d.userId]: users.d.token,
    };
    const round1 = await prisma.race.findMany({
      where: { tournamentId, tournamentRound: 1 },
      include: { participants: true },
      orderBy: { tournamentMatchIndex: "asc" },
    });
    const matchA = round1[0];
    const matchB = round1[1];
    const matchAplayers = matchA.participants
      .filter((p) => p.status === "ACCEPTED")
      .map((p) => p.userId);
    const matchBplayers = matchB.participants
      .filter((p) => p.status === "ACCEPTED")
      .map((p) => p.userId);
    // A player in match A spectates match B (a matchup they're not in).
    const spectatorId = matchAplayers[0];
    const spectatorToken = tokenByUser[spectatorId];

    const detailsRes = await authReq("GET", `/races/${matchB.id}`, {
      token: spectatorToken,
    });
    assert.equal(detailsRes.status, 200);
    const details = await detailsRes.json();
    // Spectate mode: the viewer isn't among the matchup participants.
    assert.equal(details.participants.some((p) => p.userId === spectatorId), false);
    assert.equal(details.tournamentId, tournamentId);

    const progRes = await authReq("GET", `/races/${matchB.id}/progress`, {
      token: spectatorToken,
    });
    assert.equal(progRes.status, 200);

    // A random user not in the tournament still gets 403.
    const outsider = await createUser("Outsider");
    const outDetails = await authReq("GET", `/races/${matchB.id}`, {
      token: outsider.token,
    });
    assert.equal(outDetails.status, 403);
    const outProg = await authReq("GET", `/races/${matchB.id}/progress`, {
      token: outsider.token,
    });
    assert.equal(outProg.status, 403);

    // Spectator writes stay rejected (chat post is participant-only).
    const chat = await authReq("POST", `/races/${matchB.id}/messages`, {
      token: spectatorToken,
      body: { body: "spectator chat" },
    });
    assert.ok(chat.status >= 400, "spectator chat post must be rejected");

    // An ELIMINATED participant can still spectate the final. Settle round 1.
    for (const r of round1) {
      const [p0, p1] = r.participants.filter((p) => p.status === "ACCEPTED");
      await settleMatchup(r.id, { [p0.userId]: 5000, [p1.userId]: 100 });
    }
    // matchB's second player is eliminated (lost with 100).
    const eliminatedId = matchBplayers[1];
    const finalRace = await prisma.race.findFirst({
      where: { tournamentId, tournamentRound: 2 },
    });
    const finalView = await authReq("GET", `/races/${finalRace.id}`, {
      token: tokenByUser[eliminatedId],
    });
    assert.equal(finalView.status, 200);
  });

  it("spectate: a non-tournament race still 403s for a non-participant", async () => {
    const host = await createUser("NHost");
    const rival = await createUser("NRival");
    const stranger = await createUser("NStranger");
    // Ordinary public race between host + rival.
    const createRes = await authReq("POST", "/races", {
      token: host.token,
      body: { name: "Plain Race", maxDurationDays: 3, isPublic: true },
    });
    const { race } = await createRes.json();
    await authReq("POST", `/races/${race.id}/join`, { token: rival.token });

    // A stranger (not a participant, not a tournament) is still blocked.
    const res = await authReq("GET", `/races/${race.id}`, { token: stranger.token });
    assert.equal(res.status, 403);
  });
});
