const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// Batch 2026-08-08 item 4 (backend half) — the completed bucket of GET /races
// carries the top-3 finishers so the post-race results popup can render the
// podium without a second round-trip to GET /races/:id.
//
// Purely ADDITIVE: the field is absent for team races, and every pre-existing
// completed-summary field keeps its exact meaning. Old clients ignore it.

let server;
let seq = 0;

const CHARACTERS = { "X-Client-Features": "characters,team_races" };
const TEAMS = { "X-Client-Features": "team_races" };

async function createUser(displayName) {
  const appleId = `apple-cp-${++seq}-${Date.now()}`;
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

// Invites are friends-only, so every fixture must befriend first or the invite
// silently no-ops and the race ends up with only its creator.
async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
  });
  const fId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${fId}`, {
    body: { accept: true },
    token: b.token,
  });
}

// A COMPLETED solo race with settled placements/payouts, built through the real
// create/invite/accept/start endpoints and then settled directly so the test
// owns the exact placement + payout numbers it asserts on.
async function completedSoloRace(host, others, { payouts = {} } = {}) {
  for (const o of others) await makeFriends(host, o);
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Podium Race",
      targetSteps: 500000,
      maxDurationDays: 7,
      // Public so the private-race auto-start does not fire; this helper drives
      // the manual start below.
      isPublic: true,
    },
    token: host.token,
    headers: CHARACTERS,
  });
  const raceId = (await createRes.json()).race.id;

  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((o) => o.userId) },
    token: host.token,
    headers: CHARACTERS,
  });
  for (const o of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
      headers: CHARACTERS,
    });
  }
  const startRes = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: host.token,
    headers: CHARACTERS,
  });
  assert.equal(startRes.status, 200, "fixture race must actually start");

  // Settle: everyone in [host, ...others] finishes in array order.
  const all = [host, ...others];
  // Guard the fixture itself: invites are friends-only and fail silently, so a
  // missing participant would otherwise show up as a confusing assertion miss
  // on the payload under test rather than as a broken fixture.
  const built = await prisma.raceParticipant.count({ where: { raceId } });
  assert.equal(built, all.length, "every invitee must have joined the fixture race");
  for (let i = 0; i < all.length; i++) {
    const placement = i + 1;
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: all[i].userId },
      data: {
        totalSteps: 100000 - i * 1000,
        placement,
        payoutCoins: payouts[placement] ?? 0,
        finishedAt: new Date(),
      },
    });
  }
  await prisma.race.update({
    where: { id: raceId },
    data: {
      status: "COMPLETED",
      completedAt: new Date(),
      winnerUserId: host.userId,
    },
  });
  return raceId;
}

async function completedBucket(token, headers = CHARACTERS) {
  const res = await request(server.baseUrl, "GET", "/races", { token, headers });
  assert.equal(res.status, 200);
  return (await res.json()).completed;
}

describe("batch 2026-08-08 item 4 — completed-race participants for the podium", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    seq = 0;
  });

  it("returns the top 3 finishers, ordered by placement, with the getRaceDetails field shape", async () => {
    const alice = await createUser("AliceRun");
    const bob = await createUser("BobRun");
    const carol = await createUser("CarolRun");
    const raceId = await completedSoloRace(alice, [bob, carol], {
      payouts: { 1: 300, 2: 200, 3: 100 },
    });

    const completed = await completedBucket(alice.token);
    const race = completed.find((r) => r.id === raceId);
    assert.ok(race, "the completed race must be in the completed bucket");

    assert.ok(Array.isArray(race.podium), "podium must be an array");
    assert.equal(race.podium.length, 3);

    // Ordered by placement, 1 -> 3.
    assert.deepEqual(
      race.podium.map((p) => p.placement),
      [1, 2, 3]
    );
    assert.deepEqual(
      race.podium.map((p) => p.displayName),
      ["AliceRun", "BobRun", "CarolRun"]
    );

    // Exactly the documented key set — same names as getRaceDetails so the
    // client's existing participant parser works unchanged.
    const first = race.podium[0];
    assert.deepEqual(
      Object.keys(first).sort(),
      [
        "accessories",
        "animal",
        "displayName",
        "payoutCoins",
        "placement",
        "profilePhotoUrl",
        "totalSteps",
        "userId",
      ].sort()
    );

    assert.equal(first.userId, alice.userId);
    assert.equal(first.totalSteps, 100000);
    assert.equal(first.payoutCoins, 300);
    assert.equal(first.placement, 1);
    assert.ok(Array.isArray(first.accessories), "accessories must be a list");
    assert.equal(race.podium[2].payoutCoins, 100);
  });

  it("caps at 3 even when the race had 5 finishers", async () => {
    const alice = await createUser("Cap1");
    const rest = [];
    for (const n of ["Cap2", "Cap3", "Cap4", "Cap5"]) rest.push(await createUser(n));
    const raceId = await completedSoloRace(alice, rest);

    const race = (await completedBucket(alice.token)).find((r) => r.id === raceId);
    assert.equal(race.podium.length, 3, "list payload stays small");
    assert.deepEqual(
      race.podium.map((p) => p.placement),
      [1, 2, 3]
    );
  });

  it("renders a naked capybara for a client that does not declare `characters`", async () => {
    const alice = await createUser("NakedA");
    const bob = await createUser("NakedB");
    const raceId = await completedSoloRace(alice, [bob]);

    const race = (await completedBucket(alice.token, TEAMS)).find((r) => r.id === raceId);
    assert.equal(race.podium[0].animal, null);
    assert.deepEqual(race.podium[0].accessories, []);
  });

  it("a 2-finisher race returns exactly 2 rows (podium degrades)", async () => {
    const alice = await createUser("TwoA");
    const bob = await createUser("TwoB");
    const raceId = await completedSoloRace(alice, [bob]);

    const race = (await completedBucket(alice.token)).find((r) => r.id === raceId);
    assert.equal(race.podium.length, 2);
  });

  it("batches across MULTIPLE completed races without cross-contaminating rows", async () => {
    // The N+1 guard's correctness half: one batched query must still attribute
    // each participant row to the right race.
    const alice = await createUser("MultiA");
    const bob = await createUser("MultiB");
    const carol = await createUser("MultiC");
    const r1 = await completedSoloRace(alice, [bob]);
    const r2 = await completedSoloRace(alice, [carol]);

    const completed = await completedBucket(alice.token);
    const one = completed.find((r) => r.id === r1);
    const two = completed.find((r) => r.id === r2);

    assert.deepEqual(
      one.podium.map((p) => p.displayName).sort(),
      ["MultiA", "MultiB"]
    );
    assert.deepEqual(
      two.podium.map((p) => p.displayName).sort(),
      ["MultiA", "MultiC"]
    );
  });

  // ── team races are excluded ──────────────────────────────────────────────

  it("a completed TEAM race carries no participants array (team board, not podium)", async () => {
    const alice = await createUser("TeamA1");
    const bob = await createUser("TeamB1");

    const createRes = await request(server.baseUrl, "POST", "/races", {
      body: {
        name: "Team Done",
        maxDurationDays: 7,
        isTeamRace: true,
        teamSize: 1,
        isPublic: true,
      },
      token: alice.token,
      headers: CHARACTERS,
    });
    const raceId = (await createRes.json()).race.id;
    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      body: { inviteeIds: [bob.userId], team: "TEAM_B" },
      token: alice.token,
      headers: CHARACTERS,
    });
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true, team: "TEAM_B" },
      token: bob.token,
      headers: CHARACTERS,
    });
    await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
      token: alice.token,
      headers: CHARACTERS,
    });
    await prisma.race.update({
      where: { id: raceId },
      data: { status: "COMPLETED", completedAt: new Date(), winnerTeam: "TEAM_A" },
    });

    const race = (await completedBucket(alice.token)).find((r) => r.id === raceId);
    assert.ok(race, "the team race must still appear in the completed bucket");
    assert.ok(
      race.podium === undefined || race.podium.length === 0,
      `team races must not carry a podium list, got ${JSON.stringify(race.podium)}`
    );
    // The pre-existing team board fields are untouched.
    assert.equal(race.winnerTeam, "TEAM_A");
  });

  // ── frozen-client contract ───────────────────────────────────────────────

  it("FROZEN CLIENT: every pre-existing completed-summary field is unchanged", async () => {
    const alice = await createUser("FrozenA");
    const bob = await createUser("FrozenB");
    const raceId = await completedSoloRace(alice, [bob], { payouts: { 1: 250 } });

    // The oldest shape: no X-Client-Features at all.
    const res = await request(server.baseUrl, "GET", "/races", { token: alice.token });
    assert.equal(res.status, 200);
    const race = (await res.json()).completed.find((r) => r.id === raceId);

    assert.equal(race.status, "COMPLETED");
    assert.equal(race.participantCount, 2);
    assert.equal(race.myPlacement, 1);
    assert.equal(race.myPlacementHidden, false);
    assert.ok(race.winner, "winner object still present");
    assert.ok("payoutTiers" in race, "payoutTiers still present");
    assert.ok("completedAt" in race);
    // And the additive field does not disturb any of the above.
    assert.ok(Array.isArray(race.podium));
  });
});
