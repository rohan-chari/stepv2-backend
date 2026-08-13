const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const { resolveExpiredRaces } = require("../../src/modules/races/jobs/raceExpiry");

// The broader ordinary-race exit flow is an opt-in protocol.  The token keeps
// a new app harmless against an older backend, and the per-race stamp keeps a
// runtime flag change from retroactively changing a race already in progress.
const EXIT_HEADERS = { "X-Client-Features": "race_leave" };
const TEAM_HEADERS = { "X-Client-Features": "team_races" };
const DISCOVERY_HEADERS = {
  "X-Client-Features": "race_leave,team_races,tournaments",
};

let server;
let nextAppleId = 0;

async function createUser(name) {
  const response = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: `apple-race-leave-${++nextAppleId}` },
  });
  const body = await response.json();
  if (name) {
    await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      token: body.sessionToken,
      body: { displayName: name },
    });
  }
  return { userId: body.user.id, token: body.sessionToken };
}

async function makeFriends(a, b) {
  const sent = await request(server.baseUrl, "POST", "/friends/request", {
    token: a.token,
    body: { addresseeId: b.userId },
  });
  if (!sent.ok) return;
  const { friendship } = await sent.json();
  await request(server.baseUrl, "PUT", `/friends/request/${friendship.id}`, {
    token: b.token,
    body: { accept: true },
  });
}

async function createOrdinaryRace(creator, overrides = {}) {
  const response = await request(server.baseUrl, "POST", "/races", {
    token: creator.token,
    headers: EXIT_HEADERS,
    body: {
      name: "Exit policy race",
      targetSteps: 50000,
      maxDurationDays: 1,
      // Public lobbies do not auto-start when the invite is accepted, keeping
      // the test on the explicit pending/active lifecycle it asserts.
      isPublic: true,
      ...overrides,
    },
  });
  assert.equal(response.status, 201);
  return (await response.json()).race;
}

async function inviteAndAccept(raceId, creator, participant) {
  await makeFriends(creator, participant);
  const invited = await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    token: creator.token,
    body: { inviteeIds: [participant.userId] },
  });
  assert.equal(invited.status, 200);
  const accepted = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
    token: participant.token,
    body: { accept: true },
  });
  assert.equal(accepted.status, 200);
}

async function startRace(raceId, creator) {
  const response = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: creator.token,
  });
  assert.equal(response.status, 200);
}

async function seedLiveSteps(raceId, stepsByUserId) {
  const startedAt = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())
  );
  const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.race.update({
    where: { id: raceId },
    data: { startedAt, endsAt, timezone: "UTC" },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: startedAt, baselineSteps: 0 },
  });
  for (const [userId, steps] of Object.entries(stepsByUserId)) {
    await prisma.step.upsert({
      where: { userId_date: { userId, date: startedAt } },
      update: { steps },
      create: { userId, date: startedAt, steps },
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

describe("race leave capability (integration)", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    await appSettings.setFlag("raceExitActionsEnabled", false);
    await appSettings.setFlag("fundedPrizePoolsEnabled", true);
    await appSettings.setFlag("tournamentsEnabled", true);
    await appSettings.setFlag("teamRacesEnabled", true);
  });

  it("stamps the default-off policy at creation and exposes leaveAction only to capable clients", async () => {
    const creator = await createUser("Creator Exit");
    const leaver = await createUser("Leaver Exit");

    const legacyStamped = await createOrdinaryRace(creator);
    await inviteAndAccept(legacyStamped.id, creator, leaver);
    assert.equal(
      (await prisma.race.findUnique({ where: { id: legacyStamped.id } })).exitActionsEnabled,
      false,
    );

    await appSettings.setFlag("raceExitActionsEnabled", true);
    const enabled = await createOrdinaryRace(creator, { name: "Enabled Exit Policy" });
    await inviteAndAccept(enabled.id, creator, leaver);
    assert.equal(
      (await prisma.race.findUnique({ where: { id: enabled.id } })).exitActionsEnabled,
      true,
    );

    const capable = await request(server.baseUrl, "GET", `/races/${enabled.id}`, {
      token: leaver.token,
      headers: EXIT_HEADERS,
    });
    assert.equal(capable.status, 200);
    assert.equal((await capable.json()).leaveAction, "LEAVE");

    const oldClient = await request(server.baseUrl, "GET", `/races/${enabled.id}`, {
      token: leaver.token,
    });
    assert.equal(oldClient.status, 200);
    assert.equal(Object.hasOwn(await oldClient.json(), "leaveAction"), false);

    const capableList = await request(server.baseUrl, "GET", "/races", {
      token: leaver.token,
      headers: EXIT_HEADERS,
    });
    assert.equal(capableList.status, 200);
    const capableRow = (await capableList.json()).pending.find(
      (row) => row.id === enabled.id
    );
    assert.equal(capableRow.leaveAction, "LEAVE");

    const oldList = await request(server.baseUrl, "GET", "/races", {
      token: leaver.token,
    });
    assert.equal(oldList.status, 200);
    const oldRow = (await oldList.json()).pending.find(
      (row) => row.id === enabled.id
    );
    assert.equal(Object.hasOwn(oldRow, "leaveAction"), false);

    const unstamped = await request(server.baseUrl, "GET", `/races/${legacyStamped.id}`, {
      token: leaver.token,
      headers: EXIT_HEADERS,
    });
    assert.equal(unstamped.status, 200);
    assert.equal((await unstamped.json()).leaveAction, null);
  });

  it("keeps pre-migration-stamped team leave and legacy forfeit controls visible to team clients", async () => {
    await appSettings.setFlag("raceExitActionsEnabled", false);
    const creator = await createUser("Legacy Team Creator");
    const teammate = await createUser("Legacy Team Mate");
    // Team invitations preserve their existing last-seen capability gate.
    await request(server.baseUrl, "GET", "/auth/me", {
      token: teammate.token,
      headers: TEAM_HEADERS,
    });
    const created = await request(server.baseUrl, "POST", "/races", {
      token: creator.token,
      headers: TEAM_HEADERS,
      body: {
        name: "Legacy team controls",
        maxDurationDays: 1,
        isPublic: true,
        isTeamRace: true,
        teamSize: 1,
      },
    });
    assert.equal(created.status, 201);
    const race = (await created.json()).race;
    assert.equal(
      (await prisma.race.findUnique({ where: { id: race.id } })).exitActionsEnabled,
      false
    );
    await makeFriends(creator, teammate);
    const invited = await request(server.baseUrl, "POST", `/races/${race.id}/invite`, {
      token: creator.token,
      headers: TEAM_HEADERS,
      body: { inviteeIds: [teammate.userId] },
    });
    assert.equal(invited.status, 200);
    const accepted = await request(server.baseUrl, "PUT", `/races/${race.id}/respond`, {
      token: teammate.token,
      headers: TEAM_HEADERS,
      body: { accept: true, team: "TEAM_B" },
    });
    assert.equal(accepted.status, 200);

    const pendingDetail = await request(server.baseUrl, "GET", `/races/${race.id}`, {
      token: teammate.token,
      headers: TEAM_HEADERS,
    });
    assert.equal((await pendingDetail.json()).leaveAction, "LEAVE");
    const pendingList = await request(server.baseUrl, "GET", "/races", {
      token: teammate.token,
      headers: TEAM_HEADERS,
    });
    const pendingRow = (await pendingList.json()).pending.find((row) => row.id === race.id);
    assert.equal(pendingRow.leaveAction, "LEAVE");

    await startRace(race.id, creator);
    const activeDetail = await request(server.baseUrl, "GET", `/races/${race.id}`, {
      token: teammate.token,
      headers: TEAM_HEADERS,
    });
    assert.equal((await activeDetail.json()).leaveAction, "FORFEIT");
    const forfeited = await request(server.baseUrl, "POST", `/races/${race.id}/forfeit`, {
      token: teammate.token,
      headers: TEAM_HEADERS,
      body: {},
    });
    assert.equal(forfeited.status, 200);
  });

  it("capable pending individual leave removes the row and reduces the funded pool, while old endpoint behavior remains intact", async () => {
    await appSettings.setFlag("raceExitActionsEnabled", true);
    const creator = await createUser("Pending Creator");
    const leaver = await createUser("Pending Leaver");
    const race = await createOrdinaryRace(creator);
    await inviteAndAccept(race.id, creator, leaver);

    const before = await request(server.baseUrl, "GET", `/races/${race.id}`, {
      token: leaver.token,
      headers: EXIT_HEADERS,
    });
    assert.equal((await before.json()).prizePool.coins, 40);

    const left = await request(server.baseUrl, "POST", `/races/${race.id}/leave`, {
      token: leaver.token,
      headers: EXIT_HEADERS,
      body: {},
    });
    assert.equal(left.status, 200);
    const leftBody = await left.json();
    assert.deepEqual(leftBody, {
      success: true,
      action: "LEFT",
      prizePool: { ...leftBody.prizePool },
    });
    assert.equal(leftBody.prizePool.coins, 0);
    assert.equal(await prisma.raceParticipant.count({ where: { raceId: race.id, userId: leaver.userId } }), 0);

    const duplicate = await request(server.baseUrl, "POST", `/races/${race.id}/leave`, {
      token: leaver.token,
      headers: EXIT_HEADERS,
      body: {},
    });
    assert.equal(duplicate.status, 403);
    assert.equal((await duplicate.json()).code, "NOT_A_PARTICIPANT");

    const legacyRace = await createOrdinaryRace(creator, { name: "Legacy individual leave" });
    await inviteAndAccept(legacyRace.id, creator, leaver);
    const legacyCall = await request(server.baseUrl, "POST", `/races/${legacyRace.id}/leave`, {
      token: leaver.token,
      body: {},
    });
    assert.equal(legacyCall.status, 400);
  });

  it("serializes duplicate pending exits so exactly one mutation succeeds", async () => {
    await appSettings.setFlag("raceExitActionsEnabled", true);
    const creator = await createUser("Concurrent Creator");
    const leaver = await createUser("Concurrent Leaver");
    const race = await createOrdinaryRace(creator);
    await inviteAndAccept(race.id, creator, leaver);

    const calls = await Promise.all([
      request(server.baseUrl, "POST", `/races/${race.id}/leave`, {
        token: leaver.token, headers: EXIT_HEADERS, body: {},
      }),
      request(server.baseUrl, "POST", `/races/${race.id}/leave`, {
        token: leaver.token, headers: EXIT_HEADERS, body: {},
      }),
    ]);
    const statuses = calls.map((response) => response.status).sort();
    assert.deepEqual(statuses, [200, 403]);
  });

  it("capable active individual leave freezes positive steps, keeps the funded entrant, and redistributes the settlement pool", async () => {
    await appSettings.setFlag("raceExitActionsEnabled", true);
    const creator = await createUser("Active Creator");
    const forfeiter = await createUser("Active Forfeiter");
    const race = await createOrdinaryRace(creator);
    await inviteAndAccept(race.id, creator, forfeiter);
    await startRace(race.id, creator);
    await seedLiveSteps(race.id, {
      [creator.userId]: 2000,
      [forfeiter.userId]: 1200,
    });

    const detail = await request(server.baseUrl, "GET", `/races/${race.id}`, {
      token: forfeiter.token,
      headers: EXIT_HEADERS,
    });
    assert.equal((await detail.json()).leaveAction, "FORFEIT");

    const forfeited = await request(server.baseUrl, "POST", `/races/${race.id}/leave`, {
      token: forfeiter.token,
      headers: EXIT_HEADERS,
      body: {},
    });
    assert.equal(forfeited.status, 200);
    const body = await forfeited.json();
    assert.equal(body.success, true);
    assert.equal(body.action, "FORFEITED");
    assert.equal(body.prizePool.coins, 40, "positive forfeiter remains in the active funded pool");

    const frozen = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: forfeiter.userId } },
    });
    assert.ok(frozen.forfeitedAt);
    assert.ok(frozen.totalSteps >= 1200, "the current live total is frozen");

    await prisma.race.update({
      where: { id: race.id },
      data: { endsAt: new Date(Date.now() - 60 * 1000) },
    });
    await resolveExpiredRaces();
    const settled = await prisma.race.findUnique({
      where: { id: race.id },
      include: { participants: true },
    });
    assert.equal(settled.prizePoolCoins, 40);
    const byUser = Object.fromEntries(settled.participants.map((p) => [p.userId, p]));
    assert.equal(byUser[forfeiter.userId].payoutCoins, 0);
    assert.equal(byUser[creator.userId].payoutCoins, 40);
  });

  it("an active zero-step forfeiter is frozen but immediately removed from the funded pool projection", async () => {
    await appSettings.setFlag("raceExitActionsEnabled", true);
    const creator = await createUser("Zero Creator");
    const forfeiter = await createUser("Zero Forfeiter");
    const race = await createOrdinaryRace(creator);
    await inviteAndAccept(race.id, creator, forfeiter);
    await startRace(race.id, creator);
    await seedLiveSteps(race.id, { [creator.userId]: 2000 });

    const response = await request(server.baseUrl, "POST", `/races/${race.id}/leave`, {
      token: forfeiter.token,
      headers: EXIT_HEADERS,
      body: {},
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).prizePool.coins, 0);
  });

  it("keeps the Home public-suggestion prize pool aligned after a zero-step forfeit", async () => {
    await appSettings.setFlag("raceExitActionsEnabled", true);
    const creator = await createUser("Suggestion Creator");
    const forfeiter = await createUser("Suggestion Forfeiter");
    const viewer = await createUser("Suggestion Viewer");
    const race = await createOrdinaryRace(creator, { name: "Suggestion exit race" });
    await inviteAndAccept(race.id, creator, forfeiter);
    await startRace(race.id, creator);
    await seedLiveSteps(race.id, { [creator.userId]: 2000 });

    const forfeited = await request(server.baseUrl, "POST", `/races/${race.id}/leave`, {
      token: forfeiter.token,
      headers: EXIT_HEADERS,
      body: {},
    });
    assert.equal(forfeited.status, 200);

    const suggestions = await request(server.baseUrl, "GET", "/home/suggested-races", {
      token: viewer.token,
    });
    assert.equal(suggestions.status, 200);
    const card = (await suggestions.json()).suggestions.find(
      (suggestion) => suggestion.kind === "PUBLIC_RACE" && suggestion.id === race.id
    );
    assert.ok(card);
    assert.equal(card.prizePool.coins, 0);
  });

  it("compacts TOP3 payouts across multiple active forfeits without stranding the funded pool", async () => {
    await appSettings.setFlag("raceExitActionsEnabled", true);
    const creator = await createUser("Top3 Creator");
    const runner = await createUser("Top3 Runner");
    const forfeiterA = await createUser("Top3 Forfeiter A");
    const forfeiterB = await createUser("Top3 Forfeiter B");
    const race = await createOrdinaryRace(creator, {
      name: "Top3 compact exits",
      payoutPreset: "TOP3_70_20_10",
    });
    for (const participant of [runner, forfeiterA, forfeiterB]) {
      await inviteAndAccept(race.id, creator, participant);
    }
    await startRace(race.id, creator);
    await seedLiveSteps(race.id, {
      [creator.userId]: 4000,
      [runner.userId]: 3000,
      [forfeiterA.userId]: 2000,
      [forfeiterB.userId]: 1000,
    });

    for (const forfeiter of [forfeiterA, forfeiterB]) {
      const response = await request(server.baseUrl, "POST", `/races/${race.id}/leave`, {
        token: forfeiter.token,
        headers: EXIT_HEADERS,
        body: {},
      });
      assert.equal(response.status, 200);
    }

    await prisma.race.update({
      where: { id: race.id },
      data: { endsAt: new Date(Date.now() - 60 * 1000) },
    });
    await resolveExpiredRaces();
    const settled = await prisma.race.findUnique({
      where: { id: race.id },
      include: { participants: true },
    });
    const byUser = Object.fromEntries(settled.participants.map((p) => [p.userId, p]));
    assert.equal(settled.prizePoolCoins, 80);
    assert.equal(byUser[creator.userId].payoutCoins, 64);
    assert.equal(byUser[runner.userId].payoutCoins, 16);
    assert.equal(byUser[forfeiterA.userId].payoutCoins, 0);
    assert.equal(byUser[forfeiterB.userId].payoutCoins, 0);
    assert.equal(
      settled.participants.reduce((total, participant) => total + participant.payoutCoins, 0),
      settled.prizePoolCoins
    );
  });

  it("does not pay zero-step no-shows when a leave-enabled graded race settles", async () => {
    await appSettings.setFlag("raceExitActionsEnabled", true);
    const creator = await createUser("Graded Creator");
    const runner = await createUser("Graded Runner");
    const noShowA = await createUser("Graded No Show A");
    const noShowB = await createUser("Graded No Show B");
    const race = await createOrdinaryRace(creator, {
      name: "Graded no-show exits",
      payoutPreset: "TOP_HALF",
    });
    for (const participant of [runner, noShowA, noShowB]) {
      await inviteAndAccept(race.id, creator, participant);
    }
    await startRace(race.id, creator);
    await seedLiveSteps(race.id, {
      [creator.userId]: 4000,
      [runner.userId]: 3000,
    });
    await prisma.race.update({
      where: { id: race.id },
      data: { endsAt: new Date(Date.now() - 60 * 1000) },
    });
    await resolveExpiredRaces();

    const settled = await prisma.race.findUnique({
      where: { id: race.id },
      include: { participants: true },
    });
    const byUser = Object.fromEntries(settled.participants.map((p) => [p.userId, p]));
    assert.equal(settled.prizePoolCoins, 40);
    assert.equal(byUser[creator.userId].payoutCoins, 40);
    assert.equal(byUser[runner.userId].payoutCoins, 0);
    assert.equal(byUser[noShowA.userId].payoutCoins, 0);
    assert.equal(byUser[noShowB.userId].payoutCoins, 0);
  });

  it("rejects an exit once the race deadline has passed", async () => {
    await appSettings.setFlag("raceExitActionsEnabled", true);
    const creator = await createUser("Expired Creator");
    const runner = await createUser("Expired Runner");
    const race = await createOrdinaryRace(creator);
    await inviteAndAccept(race.id, creator, runner);
    await startRace(race.id, creator);
    await prisma.race.update({
      where: { id: race.id },
      data: { endsAt: new Date(Date.now() - 1000) },
    });

    const response = await request(server.baseUrl, "POST", `/races/${race.id}/leave`, {
      token: runner.token,
      headers: EXIT_HEADERS,
      body: {},
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "RACE_NOT_LEAVABLE");
  });

  it("rejects creators, nonparticipants, terminals, and tournament matchups with stable errors", async () => {
    await appSettings.setFlag("raceExitActionsEnabled", true);
    const creator = await createUser("Error Creator");
    const participant = await createUser("Error Participant");
    const outsider = await createUser("Error Outsider");
    const race = await createOrdinaryRace(creator);
    await inviteAndAccept(race.id, creator, participant);

    const creatorLeave = await request(server.baseUrl, "POST", `/races/${race.id}/leave`, {
      token: creator.token,
      headers: EXIT_HEADERS,
      body: {},
    });
    assert.equal(creatorLeave.status, 400);
    assert.equal((await creatorLeave.json()).code, "RACE_CREATOR_CANNOT_LEAVE");

    const outsiderLeave = await request(server.baseUrl, "POST", `/races/${race.id}/leave`, {
      token: outsider.token,
      headers: EXIT_HEADERS,
      body: {},
    });
    assert.equal(outsiderLeave.status, 403);
    assert.equal((await outsiderLeave.json()).code, "NOT_A_PARTICIPANT");

    await prisma.race.update({ where: { id: race.id }, data: { status: "CANCELLED" } });
    const terminalLeave = await request(server.baseUrl, "POST", `/races/${race.id}/leave`, {
      token: participant.token,
      headers: EXIT_HEADERS,
      body: {},
    });
    assert.equal(terminalLeave.status, 400);
    assert.equal((await terminalLeave.json()).code, "RACE_NOT_LEAVABLE");
  });

  it("discovery summary counts every joinable public individual, team, and user-created tournament", async () => {
    const viewer = await createUser("Discovery Viewer");
    const individualCreator = await createUser("Individual Creator");
    const teamCreator = await createUser("Team Creator");
    const tournamentCreator = await createUser("Tournament Creator");

    await request(server.baseUrl, "POST", "/races", {
      token: individualCreator.token,
      headers: DISCOVERY_HEADERS,
      body: { name: "Public individual", maxDurationDays: 1, isPublic: true },
    });
    await request(server.baseUrl, "POST", "/races", {
      token: teamCreator.token,
      headers: DISCOVERY_HEADERS,
      body: { name: "Public team", maxDurationDays: 1, isPublic: true, isTeamRace: true, teamSize: 2 },
    });
    const tournament = await request(server.baseUrl, "POST", "/tournaments", {
      token: tournamentCreator.token,
      headers: DISCOVERY_HEADERS,
      body: {
        name: "Public tournament",
        bracketSize: 4,
        matchupDurationDays: 1,
        buyInAmount: 0,
        isPublic: true,
        inviteeIds: [],
      },
    });
    assert.equal(tournament.status, 201);

    const summary = await request(server.baseUrl, "GET", "/races/discovery-summary", {
      token: viewer.token,
      headers: DISCOVERY_HEADERS,
    });
    assert.equal(summary.status, 200);
    const body = await summary.json();
    assert.equal(body.resolved.publicRaceCount, true);
    assert.equal(body.publicRaceCount, 3);
  });
});
