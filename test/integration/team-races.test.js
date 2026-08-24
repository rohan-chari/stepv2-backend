const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { resolveExpiredRaces } = require("../../src/modules/races/jobs/raceExpiry");
const { appSettings } = require("../../src/shared/config/appSettings");

// End-to-end Team Race Mode lifecycle against the local test DB:
// create (TR-101..107) → gating (TR-702/703/706/707) → join/sides (TR-200s) →
// start (TR-300s) → settle (TR-400s/500s) → forfeit + collapse (TR-600s).

let server;
let nextAppleId = 0;

const TEAM_HEADERS = { "X-Client-Features": "characters,team_races" };

async function createUser(displayName, { teamClient = true } = {}) {
  const appleId = `apple-team-races-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  const token = body.sessionToken;
  if (displayName) {
    await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      body: { displayName },
      token,
    });
  }
  if (teamClient) {
    // Any authed request with the header records the last-seen tokens (TR-706).
    await request(server.baseUrl, "GET", "/auth/me", {
      token,
      headers: TEAM_HEADERS,
    });
  }
  return { userId: body.user.id, token };
}

// NOTE: TR-706 is STICKY/UNION — a header-less request never drops a token, so
// a "new-client" user stays eligible once seen. The old-client user below is
// kept honest by simply NEVER sending the header (they have nothing recorded).
async function makeFriends(a, b, bHeaders = TEAM_HEADERS) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
    headers: TEAM_HEADERS,
  });
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
    body: { accept: true },
    token: b.token,
    headers: bHeaders,
  });
}

async function createTeamRace(creator, overrides = {}) {
  const res = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Team Battle",
      maxDurationDays: 7,
      isTeamRace: true,
      teamSize: 2,
      ...overrides,
    },
    token: creator.token,
    headers: TEAM_HEADERS,
  });
  return res;
}

// Build a started 2v2 (alice+bob vs carol+dave) via the real API.
async function startedTwoVTwo(alice, bob, carol, dave, overrides = {}) {
  // isPublic keeps the race out of private-race auto-start so this helper
  // keeps driving the manual `POST /races/:id/start` path it is testing.
  // Applied here (not in createTeamRace) because the discovery tests above
  // depend on createTeamRace defaulting to private.
  const createRes = await createTeamRace(alice, { isPublic: true, ...overrides });
  const race = (await createRes.json()).race;
  await makeFriends(alice, bob);
  await makeFriends(alice, carol);
  await makeFriends(alice, dave);
  await request(server.baseUrl, "POST", `/races/${race.id}/invite`, {
    body: { inviteeIds: [bob.userId, carol.userId, dave.userId] },
    token: alice.token,
    headers: TEAM_HEADERS,
  });
  for (const [user, team] of [
    [bob, "TEAM_A"],
    [carol, "TEAM_B"],
    [dave, "TEAM_B"],
  ]) {
    const res = await request(server.baseUrl, "PUT", `/races/${race.id}/respond`, {
      body: { accept: true, team },
      token: user.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(res.status, 200, `accept for ${team} should succeed`);
  }
  // Full invited team rosters now start during the final acceptance. Preserve
  // the manual-start path assertion only when this fixture is still pending.
  const detail = await request(server.baseUrl, "GET", `/races/${race.id}`, {
    token: alice.token,
    headers: TEAM_HEADERS,
  });
  assert.equal(detail.status, 200);
  const current = await detail.json();
  if (current.status === "PENDING") {
    const startRes = await request(server.baseUrl, "POST", `/races/${race.id}/start`, {
      token: alice.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(startRes.status, 200);
  } else {
    assert.equal(current.status, "ACTIVE");
  }
  return race.id;
}

// Backdate the race to a UTC-midnight start and give members both the daily
// aggregate and a time-bounded sample. Deadline settlement deliberately cannot
// trust a partial historical day's aggregate (it may include post-race steps),
// so the sample is the authoritative clamped fixture for these team mechanics.
async function backdateAndWalk(raceId, stepsByUserId, { expire = true } = {}) {
  const now = new Date();
  const startedAt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const endsAt = expire
    ? new Date(now.getTime() - 60 * 1000)
    : new Date(now.getTime() + 24 * 60 * 60 * 1000);
  await prisma.race.update({
    where: { id: raceId },
    data: { startedAt, endsAt, timezone: "UTC" },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: startedAt, baselineSteps: 0 },
  });
  const date = startedAt; // @db.Date column — midnight UTC
  for (const [userId, steps] of Object.entries(stepsByUserId)) {
    await prisma.step.upsert({
      where: { userId_date: { userId, date } },
      update: { steps },
      create: { userId, steps, date },
    });
    await prisma.stepSample.create({
      data: {
        userId,
        periodStart: startedAt,
        periodEnd: endsAt,
        steps,
        sourceName: "healthkit",
      },
    });
  }
}

describe("team races (integration)", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.notification.deleteMany({});
    nextAppleId = 0;
    // Team buy-ins, tie refunds and forfeit collapse are asserted in coins, and
    // app-funded prize pools now default ON (which zeroes buy-ins at create).
    // Pin the flag OFF: this suite covers the buy-in model, which remains live
    // code reachable via the kill switch.
    await appSettings.setFlag("fundedPrizePoolsEnabled", false);
  });

  it("TR-101/103/104 creates a 2v2 with fields, distinct names, creator on TEAM_A", async () => {
    const alice = await createUser("AliceTeamsAAA");
    const res = await createTeamRace(alice);
    assert.equal(res.status, 201);
    const { race } = await res.json();
    assert.equal(race.isTeamRace, true);
    assert.equal(race.teamSize, 2);
    assert.equal(race.maxParticipants, 4);
    assert.ok(race.teamAName && race.teamBName);
    assert.notEqual(race.teamAName.toLowerCase(), race.teamBName.toLowerCase());
    const me = race.participants.find((p) => p.userId === alice.userId);
    assert.equal(me.team, "TEAM_A");
    // TR-902: every new race is time-based.
    const row = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(row.timeBased, true);
    assert.equal(row.payoutPreset, "WINNER_TAKES_ALL");
  });

  it("TR-106/107 old client cannot create; kill switch blocks creation", async () => {
    const alice = await createUser("AliceTeamsBBB");
    const oldClient = await request(server.baseUrl, "POST", "/races", {
      body: { name: "Team Battle", isTeamRace: true, teamSize: 2 },
      token: alice.token, // no X-Client-Features header
    });
    assert.equal(oldClient.status, 400);
    assert.equal((await oldClient.json()).code, "UPDATE_REQUIRED");

    // setFlag (not a raw DB write) so the in-process appSettings cache is
    // busted immediately, exactly like an admin PATCH would.
    await appSettings.setFlag("teamRacesEnabled", false);
    try {
      const blocked = await createTeamRace(alice);
      assert.equal(blocked.status, 403);
      assert.equal((await blocked.json()).code, "FEATURE_DISABLED");
    } finally {
      await appSettings.setFlag("teamRacesEnabled", true);
    }
  });

  it("TR-702 race lists hide team races from clients without the token", async () => {
    const alice = await createUser("AliceTeamsCCC");
    await createTeamRace(alice, { isPublic: true });

    const oldList = await (
      await request(server.baseUrl, "GET", "/races", { token: alice.token })
    ).json();
    assert.equal(oldList.pending.length, 0, "old client sees no team race");

    const newList = await (
      await request(server.baseUrl, "GET", "/races", {
        token: alice.token,
        headers: TEAM_HEADERS,
      })
    ).json();
    assert.equal(newList.pending.length, 1);
    assert.equal(newList.pending[0].isTeamRace, true);

    const viewer = await createUser("ViewerTeamsAA");
    const oldPublic = await (
      await request(server.baseUrl, "GET", "/races/public", { token: viewer.token })
    ).json();
    assert.equal(oldPublic.races.length, 0);
    const newPublic = await (
      await request(server.baseUrl, "GET", "/races/public", {
        token: viewer.token,
        headers: TEAM_HEADERS,
      })
    ).json();
    assert.equal(newPublic.races.length, 1);
    assert.equal(newPublic.races[0].teamAOpenSlots, 1);
    assert.equal(newPublic.races[0].teamBOpenSlots, 2);
  });

  it("TR-706/707/708 invite-time gating by the invitee's last-seen client", async () => {
    const alice = await createUser("AliceTeamsDDD");
    const oldFriend = await createUser("OldFriendAAAA", { teamClient: false });
    await makeFriends(alice, oldFriend, {}); // old client: never sends the header
    const race = (await (await createTeamRace(alice)).json()).race;

    const inviteRes = await request(server.baseUrl, "POST", `/races/${race.id}/invite`, {
      body: { inviteeIds: [oldFriend.userId] },
      token: alice.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(inviteRes.status, 400);
    const inviteBody = await inviteRes.json();
    assert.equal(inviteBody.code, "INVITEE_NEEDS_UPDATE");
    assert.match(inviteBody.error, /OldFriendAAAA/);

    // TR-708: friends list marks them ineligible.
    const friends = await (
      await request(server.baseUrl, "GET", "/friends", {
        token: alice.token,
        headers: TEAM_HEADERS,
      })
    ).json();
    const row = friends.friends.find((f) => f.id === oldFriend.userId);
    assert.equal(row.teamRaceEligible, false);

    // The friend updates their app (connects once with the token) -> eligible.
    await request(server.baseUrl, "GET", "/auth/me", {
      token: oldFriend.token,
      headers: TEAM_HEADERS,
    });
    const retry = await request(server.baseUrl, "POST", `/races/${race.id}/invite`, {
      body: { inviteeIds: [oldFriend.userId] },
      token: alice.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(retry.status, 200);
  });

  it("TR-202/203/205 side caps, switching, and leaving while PENDING", async () => {
    const alice = await createUser("AliceTeamsEEE");
    const bob = await createUser("BobTeamsAAAAA");
    const carol = await createUser("CarolTeamsAAA");
    const race = (
      await (await createTeamRace(alice, { isPublic: true, teamSize: 1, maxParticipants: 2 })).json()
    ).race; // 1v1: TEAM_A already full (creator)

    // TEAM_FULL on Alice's side; other side open (TR-202).
    const fullRes = await request(server.baseUrl, "POST", `/races/${race.id}/join`, {
      body: { team: "TEAM_A" },
      token: bob.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(fullRes.status, 409);
    assert.equal((await fullRes.json()).code, "TEAM_FULL");

    const okRes = await request(server.baseUrl, "POST", `/races/${race.id}/join`, {
      body: { team: "TEAM_B" },
      token: bob.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(okRes.status, 201);
    assert.equal((await okRes.json()).participant.team, "TEAM_B");

    // Switching to the full side -> TEAM_FULL (TR-203).
    const switchRes = await request(server.baseUrl, "PUT", `/races/${race.id}/team`, {
      body: { team: "TEAM_A" },
      token: bob.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(switchRes.status, 409);

    // Leaving frees the slot (TR-205); rejoining works; creator cannot leave (TR-208).
    const leaveRes = await request(server.baseUrl, "POST", `/races/${race.id}/leave`, {
      token: bob.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(leaveRes.status, 200);
    const rejoin = await request(server.baseUrl, "POST", `/races/${race.id}/join`, {
      body: { team: "TEAM_B" },
      token: carol.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(rejoin.status, 201);
    const creatorLeave = await request(server.baseUrl, "POST", `/races/${race.id}/leave`, {
      token: alice.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(creatorLeave.status, 400);
  });

  it("TR-301/302/303/204 start gate + lock at start", async () => {
    const alice = await createUser("AliceTeamsFFF");
    const bob = await createUser("BobTeamsBBBBB");
    const carol = await createUser("CarolTeamsBBB");
    const dave = await createUser("DaveTeamsAAAA");
    const race = (await (await createTeamRace(alice, { isPublic: true })).json()).race;
    await makeFriends(alice, bob);
    await request(server.baseUrl, "POST", `/races/${race.id}/invite`, {
      body: { inviteeIds: [bob.userId] },
      token: alice.token,
      headers: TEAM_HEADERS,
    });
    await request(server.baseUrl, "PUT", `/races/${race.id}/respond`, {
      body: { accept: true, team: "TEAM_A" },
      token: bob.token,
      headers: TEAM_HEADERS,
    });

    // 2v0 -> TEAMS_UNEVEN.
    const uneven = await request(server.baseUrl, "POST", `/races/${race.id}/start`, {
      token: alice.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(uneven.status, 409);
    assert.equal((await uneven.json()).code, "TEAMS_UNEVEN");

    // 2v2 configured, started 2v2 with public joiners on B (TR-302 via cap).
    for (const user of [carol, dave]) {
      const joinRes = await request(server.baseUrl, "POST", `/races/${race.id}/join`, {
        body: { team: "TEAM_B" },
        token: user.token,
        headers: TEAM_HEADERS,
      });
      assert.equal(joinRes.status, 201);
    }
    const started = await request(server.baseUrl, "POST", `/races/${race.id}/start`, {
      token: alice.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(started.status, 200);

    // TR-204: locked once ACTIVE, on every channel.
    const late = await createUser("LateTeamsAAAA");
    const lateJoin = await request(server.baseUrl, "POST", `/races/${race.id}/join`, {
      body: { team: "TEAM_B" },
      token: late.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(lateJoin.status, 409);
    assert.equal((await lateJoin.json()).code, "RACE_ALREADY_STARTED");
  });

  it("TR-401/402/403/502/504 deadline settlement: team totals, placements, even split + remainder", async () => {
    const alice = await createUser("AliceTeamsGGG");
    const bob = await createUser("BobTeamsCCCCC");
    const carol = await createUser("CarolTeamsCCC");
    const dave = await createUser("DaveTeamsBBBB");
    // 30-coin buy-in: give everyone coins first.
    for (const u of [alice, bob, carol, dave]) {
      await prisma.user.update({ where: { id: u.userId }, data: { coins: 500 } });
    }
    const raceId = await startedTwoVTwo(alice, bob, carol, dave, {
      buyInAmount: 25,
    });
    // Team A walks 9000+2000 = 11000; Team B walks 5000+3000 = 8000.
    await backdateAndWalk(raceId, {
      [alice.userId]: 9000,
      [bob.userId]: 2000,
      [carol.userId]: 5000,
      [dave.userId]: 3000,
    });
    await resolveExpiredRaces();

    const race = await prisma.race.findUnique({
      where: { id: raceId },
      include: { participants: true },
    });
    assert.equal(race.status, "COMPLETED");
    assert.equal(race.winnerTeam, "TEAM_A");
    assert.equal(race.winnerUserId, null, "TR-402 winnerUserId stays null");

    const byUser = Object.fromEntries(race.participants.map((p) => [p.userId, p]));
    assert.equal(byUser[alice.userId].placement, 1);
    assert.equal(byUser[bob.userId].placement, 1);
    assert.equal(byUser[carol.userId].placement, 2);
    assert.equal(byUser[dave.userId].placement, 2);

    // Pot = 4 × 25 = 100; two winners -> 50 each (even split, no remainder).
    assert.equal(byUser[alice.userId].payoutCoins, 50);
    assert.equal(byUser[bob.userId].payoutCoins, 50);
    assert.equal(byUser[carol.userId].payoutCoins, 0);

    // Progress payload exposes the honest team block.
    const progress = await (
      await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
        token: alice.token,
        headers: TEAM_HEADERS,
      })
    ).json();
    assert.equal(progress.progress.teams.teamA.totalSteps >= 11000, true);
    assert.equal(progress.progress.winnerTeam, "TEAM_A");
  });

  it("TR-404 tie refunds every buy-in and gives everyone placement 1", async () => {
    const alice = await createUser("AliceTeamsHHH");
    const bob = await createUser("BobTeamsDDDDD");
    const carol = await createUser("CarolTeamsDDD");
    const dave = await createUser("DaveTeamsCCCC");
    for (const u of [alice, bob, carol, dave]) {
      await prisma.user.update({ where: { id: u.userId }, data: { coins: 500 } });
    }
    const raceId = await startedTwoVTwo(alice, bob, carol, dave, {
      buyInAmount: 30,
    });
    const coinsBefore = Object.fromEntries(
      await Promise.all(
        [alice, bob, carol, dave].map(async (u) => [
          u.userId,
          (await prisma.user.findUnique({ where: { id: u.userId } })).coins,
        ])
      )
    );
    await backdateAndWalk(raceId, {
      [alice.userId]: 4000,
      [bob.userId]: 4000,
      [carol.userId]: 5000,
      [dave.userId]: 3000,
    });
    await resolveExpiredRaces();

    const race = await prisma.race.findUnique({
      where: { id: raceId },
      include: { participants: true },
    });
    assert.equal(race.status, "COMPLETED");
    assert.equal(race.winnerTeam, null);
    for (const p of race.participants) {
      assert.equal(p.placement, 1, "everyone placement 1 on tie");
      assert.equal(p.buyInStatus, "REFUNDED");
      assert.equal(p.payoutCoins, 0);
    }
    for (const u of [alice, bob, carol, dave]) {
      const after = (await prisma.user.findUnique({ where: { id: u.userId } })).coins;
      assert.equal(after, coinsBefore[u.userId] + 30, "buy-in returned in full");
    }
  });

  it("TR-601/602/603 forfeit freezes, blocks re-forfeit, and full-team forfeit collapses instantly", async () => {
    const alice = await createUser("AliceTeamsIII");
    const bob = await createUser("BobTeamsEEEEE");
    const carol = await createUser("CarolTeamsEEE");
    const dave = await createUser("DaveTeamsDDDD");
    for (const u of [alice, bob, carol, dave]) {
      await prisma.user.update({ where: { id: u.userId }, data: { coins: 500 } });
    }
    const raceId = await startedTwoVTwo(alice, bob, carol, dave, {
      buyInAmount: 10,
    });
    // Race still running (endsAt in the future).
    await backdateAndWalk(
      raceId,
      {
        [alice.userId]: 8000,
        [bob.userId]: 1000,
        [carol.userId]: 6000,
        [dave.userId]: 2500,
      },
      { expire: false }
    );

    // Carol (TEAM_B) forfeits: frozen, permanent.
    const f1 = await request(server.baseUrl, "POST", `/races/${raceId}/forfeit`, {
      token: carol.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(f1.status, 200);
    const f1body = await f1.json();
    assert.ok(f1body.participant.forfeitedAt);
    assert.equal(f1body.collapsed, false);
    assert.equal(f1body.participant.totalSteps >= 6000, true, "frozen at effective total");

    const again = await request(server.baseUrl, "POST", `/races/${raceId}/forfeit`, {
      token: carol.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(again.status, 400, "forfeit is permanent");

    // Dave (last TEAM_B member) forfeits -> collapse, TEAM_A wins instantly.
    const f2 = await request(server.baseUrl, "POST", `/races/${raceId}/forfeit`, {
      token: dave.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(f2.status, 200);
    const f2body = await f2.json();
    assert.equal(f2body.collapsed, true);

    const race = await prisma.race.findUnique({
      where: { id: raceId },
      include: { participants: true },
    });
    assert.equal(race.status, "COMPLETED");
    assert.equal(race.winnerTeam, "TEAM_A");
    const byUser = Object.fromEntries(race.participants.map((p) => [p.userId, p]));
    assert.equal(byUser[alice.userId].placement, 1);
    assert.equal(byUser[carol.userId].placement, 2);
    // Pot 40 split between the two active winners.
    assert.equal(byUser[alice.userId].payoutCoins, 20);
    assert.equal(byUser[bob.userId].payoutCoins, 20);
    assert.equal(byUser[carol.userId].payoutCoins, 0, "TR-503 forfeiter no cut");
  });

  it("TR-105 PATCH edits names/size while PENDING; isTeamRace immutable", async () => {
    const alice = await createUser("AliceTeamsJJJ");
    const race = (await (await createTeamRace(alice)).json()).race;

    const rename = await request(server.baseUrl, "PATCH", `/races/${race.id}`, {
      body: { teamAName: "Red Rockets", teamSize: 3 },
      token: alice.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(rename.status, 200);
    const updated = (await rename.json()).race;
    assert.equal(updated.teamAName, "Red Rockets");
    assert.equal(updated.teamSize, 3);
    assert.equal(updated.maxParticipants, 6);

    const flip = await request(server.baseUrl, "PATCH", `/races/${race.id}`, {
      body: { isTeamRace: false },
      token: alice.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(flip.status, 400);
    assert.equal((await flip.json()).code, "IMMUTABLE_FIELD");
  });

  it("TR-903/904 old-client create payload with targetSteps still succeeds and round-trips", async () => {
    const alice = await createUser("AliceTeamsKKK");
    const res = await request(server.baseUrl, "POST", "/races", {
      body: { name: "Legacy Race", targetSteps: 15000, maxDurationDays: 5 },
      token: alice.token, // no feature header — old client
    });
    assert.equal(res.status, 201);
    const { race } = await res.json();
    const row = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(row.targetSteps, 15000, "TR-903 stored for legacy display");
    assert.equal(race.targetSteps, 15000, "TR-903 still returned");
    // NOTE: TR-904's "yields a TIME-BASED race" assertion is intentionally
    // absent — forcing timeBased=true on creation breaks existing target-finish
    // tests, so that half of TR-902 is paused pending a PM ruling (see report).
  });
});
