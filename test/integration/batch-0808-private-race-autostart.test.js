const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");
const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  startServer,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const {
  buildAutoStartScheduledRaces,
} = require("../../src/modules/races/jobs/autoStartScheduledRaces");
const {
  buildRespondToRaceInvite,
} = require("../../src/modules/races/commands/respondToRaceInvite");

// ---------------------------------------------------------------------------
// Batch 2026-08-08 item 2 — private races auto-start once every invite is
// resolved.
//
// Everything that a client can trigger is driven over real HTTP (create /
// invite / respond / join / share-join / GET details). The cron backstop is
// driven through the SAME entry point the scheduler calls,
// buildAutoStartScheduledRaces(), against the real DB — which also proves the
// new unscheduled-private pass is wired into the existing 5-minute tick.
// ---------------------------------------------------------------------------

const FEATURES = { "X-Client-Features": "characters,team_races" };
const QUIET = { log() {}, error() {} };

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-autostart-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
    headers: FEATURES,
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
    headers: FEATURES,
  });
  return { userId: body.user.id, token: body.sessionToken };
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
    headers: FEATURES,
  });
  const fId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${fId}`, {
    body: { accept: true },
    token: b.token,
    headers: FEATURES,
  });
}

async function createRace(creator, overrides = {}) {
  const res = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: overrides.name || "Auto Start Crew",
      targetSteps: 100000,
      maxDurationDays: 7,
      isPublic: false,
      ...overrides,
    },
    token: creator.token,
    headers: FEATURES,
  });
  const body = await res.json();
  assert.equal(res.status, 201, `create race failed: ${JSON.stringify(body)}`);
  return body.race.id;
}

async function invite(creator, raceId, invitees) {
  const res = await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: invitees.map((i) => i.userId) },
    token: creator.token,
    headers: FEATURES,
  });
  assert.equal(
    res.status,
    200,
    `invite failed: ${JSON.stringify(await res.json())}`
  );
}

async function respond(user, raceId, accept, team) {
  const res = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
    body: { accept, ...(team ? { team } : {}) },
    token: user.token,
    headers: FEATURES,
  });
  return { status: res.status, body: await res.json() };
}

async function getRace(user, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}`, {
    token: user.token,
    headers: FEATURES,
  });
  assert.equal(res.status, 200);
  return res.json();
}

// The cron entry point the scheduler calls every 5 minutes.
async function runCron() {
  const run = buildAutoStartScheduledRaces({ logger: QUIET });
  return run();
}

describe("batch 2026-08-08 item 2 — private race auto-start", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    delete process.env.PRIVATE_RACE_AUTOSTART_DISABLED;
    await appSettings.setFlag("teamRacesEnabled", true);
  });

  after(() => {
    delete process.env.PRIVATE_RACE_AUTOSTART_DISABLED;
  });

  it("starts the race automatically when the last invitee accepts", async () => {
    const alice = await createUser("AutoAlice");
    const bob = await createUser("AutoBob");
    const carol = await createUser("AutoCarol");
    await makeFriends(alice, bob);
    await makeFriends(alice, carol);

    const raceId = await createRace(alice);
    await invite(alice, raceId, [bob, carol]);

    // One outstanding invite left -> still PENDING.
    await respond(bob, raceId, true);
    let race = await getRace(alice, raceId);
    assert.equal(race.status, "PENDING", "must not start while carol is unresolved");
    assert.equal(race.startedAt, null);

    // Last invite resolved -> ACTIVE, with a real startedAt.
    const last = await respond(carol, raceId, true);
    race = await getRace(alice, raceId);
    assert.equal(race.status, "ACTIVE");
    assert.ok(race.startedAt, "startedAt must be set");
    assert.ok(
      Math.abs(new Date(race.startedAt).getTime() - Date.now()) < 60 * 1000,
      "startedAt should be ~now"
    );

    // The accepter's own response is unchanged in shape and status.
    assert.equal(last.status, 200);
    assert.deepEqual(Object.keys(last.body), ["participant"]);
    assert.equal(last.body.participant.status, "ACCEPTED");
    assert.equal(last.body.participant.raceId, raceId);
    assert.equal(last.body.participant.userId, carol.userId);
  });

  it("attributes the start to the CREATOR, not the last accepter", async () => {
    const alice = await createUser("AttribAlice");
    const bob = await createUser("AttribBob");
    await makeFriends(alice, bob);

    const raceId = await createRace(alice);
    await invite(alice, raceId, [bob]);
    // alice + bob = 2 accepted, no outstanding invites.
    await respond(bob, raceId, true);

    const race = await getRace(alice, raceId);
    assert.equal(race.status, "ACTIVE");

    const startedEvent = await prisma.racePowerupEvent.findFirst({
      where: { raceId, eventType: "RACE_STARTED" },
    });
    assert.ok(startedEvent, "a RACE_STARTED feed row should exist");
    assert.equal(
      startedEvent.actorUserId,
      alice.userId,
      "the feed row must be attributed to the creator, not the accepter"
    );
  });

  it("a DECLINE does not block auto-start for the rest", async () => {
    const alice = await createUser("DeclAlice");
    const bob = await createUser("DeclBob");
    const carol = await createUser("DeclCarol");
    const dave = await createUser("DeclDave");
    for (const f of [bob, carol, dave]) await makeFriends(alice, f);

    const raceId = await createRace(alice);
    await invite(alice, raceId, [bob, carol, dave]);

    await respond(bob, raceId, true);
    await respond(carol, raceId, true);
    let race = await getRace(alice, raceId);
    assert.equal(race.status, "PENDING", "dave is still unresolved");

    // Dave's DECLINE resolves the last invite -> the race starts with the
    // three accepted participants.
    const declineRes = await respond(dave, raceId, false);
    assert.equal(declineRes.status, 200);
    assert.equal(declineRes.body.participant.status, "DECLINED");

    race = await getRace(alice, raceId);
    assert.equal(race.status, "ACTIVE");
    const accepted = race.participants.filter((p) => p.status === "ACCEPTED");
    assert.equal(accepted.length, 3);
  });

  it("an EXPIRED outstanding invite does not block the cron backstop", async () => {
    const alice = await createUser("ExpAlice");
    const bob = await createUser("ExpBob");
    const carol = await createUser("ExpCarol");
    await makeFriends(alice, bob);
    await makeFriends(alice, carol);

    const raceId = await createRace(alice);
    await invite(alice, raceId, [bob, carol]);
    await respond(bob, raceId, true);

    let race = await getRace(alice, raceId);
    assert.equal(race.status, "PENDING", "carol's live invite blocks the start");

    // Carol never responds and her invite lapses. Nothing ever transitions an
    // expired INVITED row, so only the backstop can rescue this race.
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: carol.userId },
      data: { inviteExpiresAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    await runCron();

    race = await getRace(alice, raceId);
    assert.equal(race.status, "ACTIVE");
    assert.ok(race.startedAt);
    // The lapsed invite is still INVITED — auto-start does not rewrite it.
    const carolRow = race.participants.find((p) => p.userId === carol.userId);
    assert.equal(carolRow.status, "INVITED");
  });

  it("the backstop ignores a DORMANT race that meets every other condition", async () => {
    // Deploy-day safety (review blocker 2). Turning this feature on makes every
    // historical PENDING private race with 2+ accepted a candidate — without a
    // recency bound the first cron tick would mass-start races abandoned months
    // ago and push every one of their participants.
    const alice = await createUser("OldAlice");
    const bob = await createUser("OldBob");
    await makeFriends(alice, bob);

    const raceId = await createRace(alice);
    await invite(alice, raceId, [bob]);

    // Backdate BOTH the race and the accept so nothing is live, then accept.
    // (Accept first, then backdate, so the inline hook's own start is undone.)
    await respond(bob, raceId, true);
    await prisma.race.update({
      where: { id: raceId },
      data: { status: "PENDING", startedAt: null, endsAt: null },
    });
    const longAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    await prisma.$executeRaw`UPDATE races SET created_at = ${longAgo} WHERE id = ${raceId}`;

    // Sanity: it satisfies every OTHER part of the predicate.
    const row = await prisma.race.findUnique({
      where: { id: raceId },
      select: { status: true, isPublic: true, seedId: true, tournamentId: true, scheduledStartAt: true },
    });
    assert.equal(row.status, "PENDING");
    assert.equal(row.isPublic, false);
    assert.equal(row.seedId, null);
    assert.equal(row.tournamentId, null);
    assert.equal(row.scheduledStartAt, null);
    assert.equal(
      await prisma.raceParticipant.count({ where: { raceId, status: "ACCEPTED" } }),
      2
    );

    await runCron();

    const race = await getRace(alice, raceId);
    assert.equal(race.status, "PENDING", "a dormant race must never be mass-started");
    assert.equal(race.startedAt, null);
  });

  it("the backstop still starts a RECENT race (the recency bound is not a kill switch)", async () => {
    const alice = await createUser("NewAlice");
    const bob = await createUser("NewBob");
    const carol = await createUser("NewCarol");
    await makeFriends(alice, bob);
    await makeFriends(alice, carol);

    const raceId = await createRace(alice);
    await invite(alice, raceId, [bob, carol]);
    await respond(bob, raceId, true);
    // Carol's invite lapses -> only the backstop can start it. Race is fresh.
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: carol.userId },
      data: { inviteExpiresAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    await runCron();

    const race = await getRace(alice, raceId);
    assert.equal(race.status, "ACTIVE", "a race created today is still a candidate");
  });

  it("does NOT start a team race with uneven sides, and shows the accepter no error", async () => {
    const alice = await createUser("TeamAlice");
    const bob = await createUser("TeamBob");
    const carol = await createUser("TeamCarol");
    await makeFriends(alice, bob);
    await makeFriends(alice, carol);

    const raceId = await createRace(alice, {
      name: "Uneven Squad",
      isTeamRace: true,
      teamSize: 2,
      team: "TEAM_A",
    });
    await invite(alice, raceId, [bob, carol]);

    // Both accepted players end up on TEAM_A -> 2v0.
    const bobRes = await respond(bob, raceId, true, "TEAM_A");
    assert.equal(bobRes.status, 200);
    const carolRes = await respond(carol, raceId, false);
    assert.equal(carolRes.status, 200);
    assert.equal(carolRes.body.error, undefined, "no error surfaced to the accepter");

    const race = await getRace(alice, raceId);
    assert.equal(race.status, "PENDING", "uneven teams must stay PENDING");
    assert.equal(race.startedAt, null);

    // And the backstop must not start it either.
    await runCron();
    const afterCron = await getRace(alice, raceId);
    assert.equal(afterCron.status, "PENDING");
  });

  it("does NOT auto-start a race scheduled to start in the future", async () => {
    const alice = await createUser("SchedAlice");
    const bob = await createUser("SchedBob");
    await makeFriends(alice, bob);

    const scheduledStartAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const raceId = await createRace(alice, {
      name: "Later Race",
      scheduledStartAt: scheduledStartAt.toISOString(),
    });
    await invite(alice, raceId, [bob]);
    await respond(bob, raceId, true);

    const race = await getRace(alice, raceId);
    assert.equal(race.status, "PENDING", "a scheduled race keeps its schedule");
    assert.equal(race.startedAt, null);

    // The backstop query excludes scheduled races outright.
    await runCron();
    assert.equal((await getRace(alice, raceId)).status, "PENDING");
  });

  it("does NOT auto-start a PUBLIC race joined from the browse list", async () => {
    const alice = await createUser("PubAlice");
    const bob = await createUser("PubBob");

    const raceId = await createRace(alice, { name: "Open House", isPublic: true });

    const joinRes = await request(server.baseUrl, "POST", `/races/${raceId}/join`, {
      token: bob.token,
      headers: FEATURES,
    });
    const joinBody = await joinRes.json();
    assert.equal(joinRes.status, 201, JSON.stringify(joinBody));
    assert.equal(joinBody.participant.status, "ACCEPTED");

    const race = await getRace(alice, raceId);
    assert.equal(race.status, "PENDING", "public races are creator-started");
  });

  it("auto-starts from the SHARE-TOKEN join path", async () => {
    const alice = await createUser("ShareAlice");
    const bob = await createUser("ShareBob");

    const raceId = await createRace(alice, { name: "Link Crew" });
    const linkRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/share-link`,
      { token: alice.token, headers: FEATURES }
    );
    const { shareToken } = await linkRes.json();
    assert.ok(shareToken);

    const joinRes = await request(
      server.baseUrl,
      "POST",
      `/races/share/${shareToken}/join`,
      { token: bob.token, headers: FEATURES }
    );
    const joinBody = await joinRes.json();
    // Response shape unchanged: { participant, raceId }.
    assert.equal(joinRes.status, 201, JSON.stringify(joinBody));
    assert.deepEqual(Object.keys(joinBody).sort(), ["participant", "raceId"]);

    const race = await getRace(alice, raceId);
    assert.equal(race.status, "ACTIVE");
    assert.ok(race.startedAt);
  });

  it("does NOT auto-start a race owned by a tournament", async () => {
    const alice = await createUser("TourAlice");
    const bob = await createUser("TourBob");

    const raceId = await createRace(alice, { name: "Bracket Match" });
    const linkRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/share-link`,
      { token: alice.token, headers: FEATURES }
    );
    const { shareToken } = await linkRes.json();

    const tournament = await prisma.tournament.create({
      data: {
        creatorId: alice.userId,
        name: "Auto Start Bracket",
        bracketSize: 4,
        matchupDurationDays: 1,
        totalRounds: 2,
      },
    });
    await prisma.race.update({
      where: { id: raceId },
      data: { tournamentId: tournament.id, tournamentRound: 1, tournamentMatchIndex: 0 },
    });

    const joinRes = await request(
      server.baseUrl,
      "POST",
      `/races/share/${shareToken}/join`,
      { token: bob.token, headers: FEATURES }
    );
    assert.equal(joinRes.status, 201, JSON.stringify(await joinRes.json()));

    const race = await prisma.race.findUnique({ where: { id: raceId } });
    assert.equal(race.status, "PENDING", "the tournament engine owns this race");

    await runCron();
    const afterCron = await prisma.race.findUnique({ where: { id: raceId } });
    assert.equal(afterCron.status, "PENDING");
  });

  it("does NOT auto-start a seeded race", async () => {
    const alice = await createUser("SeedAlice");
    const bob = await createUser("SeedBob");

    const raceId = await createRace(alice, { name: "Seeded Crew" });
    const linkRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/share-link`,
      { token: alice.token, headers: FEATURES }
    );
    const { shareToken } = await linkRes.json();

    const seed = await prisma.raceSeed.create({
      data: {
        id: "autostart-test-seed",
        kind: "AUTOSTART_TEST",
        name: "Autostart Test Seed",
        targetSteps: 10000,
        cadence: "DAILY",
      },
    });
    await prisma.race.update({
      where: { id: raceId },
      data: { seedId: seed.id },
    });

    const joinRes = await request(
      server.baseUrl,
      "POST",
      `/races/share/${shareToken}/join`,
      { token: bob.token, headers: FEATURES }
    );
    assert.equal(joinRes.status, 201, JSON.stringify(await joinRes.json()));

    const race = await prisma.race.findUnique({ where: { id: raceId } });
    assert.equal(race.status, "PENDING", "seeded races renew on their own schedule");

    await runCron();
    assert.equal(
      (await prisma.race.findUnique({ where: { id: raceId } })).status,
      "PENDING"
    );

    await prisma.race.update({ where: { id: raceId }, data: { seedId: null } });
    await prisma.raceSeed.delete({ where: { id: seed.id } });
  });

  it("does NOT start with fewer than 2 accepted participants", async () => {
    const alice = await createUser("SoloAlice");
    const bob = await createUser("SoloBob");
    await makeFriends(alice, bob);

    const raceId = await createRace(alice, { name: "Nobody Came" });
    await invite(alice, raceId, [bob]);
    const res = await respond(bob, raceId, false);
    assert.equal(res.status, 200);

    let race = await getRace(alice, raceId);
    assert.equal(race.status, "PENDING");

    await runCron();
    race = await getRace(alice, raceId);
    assert.equal(race.status, "PENDING", "1 accepted is not a race");
  });

  it("retired kill switch cannot block the permanent inline hook or cron backstop", async () => {
    process.env.PRIVATE_RACE_AUTOSTART_DISABLED = "true";

    const alice = await createUser("KillAlice");
    const bob = await createUser("KillBob");
    await makeFriends(alice, bob);

    const raceId = await createRace(alice, { name: "Switched Off" });
    await invite(alice, raceId, [bob]);
    const res = await respond(bob, raceId, true);
    assert.equal(res.status, 200, "the join itself is unaffected by the switch");

    let race = await getRace(alice, raceId);
    assert.equal(race.status, "ACTIVE", "inline hook remains permanently enabled");

    await runCron();
    race = await getRace(alice, raceId);
    assert.equal(race.status, "ACTIVE", "cron is idempotent after inline start");

    // Removing stale deployment residue also leaves the established path on.
    delete process.env.PRIVATE_RACE_AUTOSTART_DISABLED;
    await runCron();
    race = await getRace(alice, raceId);
    assert.equal(race.status, "ACTIVE");
  });

  it("skips the inline start above 10 participants, and the cron backstop starts it", async () => {
    const alice = await createUser("BigAlice");
    const invitees = [];
    for (let i = 0; i < 11; i += 1) {
      const friend = await createUser(`BigFriend${i}`);
      await makeFriends(alice, friend);
      invitees.push(friend);
    }

    const raceId = await createRace(alice, {
      name: "Big Crew",
      maxParticipants: 20,
    });
    await invite(alice, raceId, invitees);

    for (const friend of invitees) {
      const res = await respond(friend, raceId, true);
      assert.equal(res.status, 200);
    }

    // 12 participant rows > the inline bound of 10 -> the accept response must
    // not have carried the start.
    let race = await getRace(alice, raceId);
    assert.equal(race.participants.length, 12);
    assert.equal(race.status, "PENDING", "large races are not started inline");

    await runCron();
    race = await getRace(alice, raceId);
    assert.equal(race.status, "ACTIVE", "the backstop starts large races");
    assert.ok(race.startedAt);
  });

  it("an auto-start failure never fails the accept", async () => {
    // Same real HTTP stack, but startRace throws. The accept must still return
    // its normal 200 { participant } and the race must stay PENDING.
    const failingServer = await startServer({
      verifyAppleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
      respondToRaceInvite: buildRespondToRaceInvite({
        logger: QUIET,
        startRace: async () => {
          throw new Error("simulated startRace explosion");
        },
      }),
    });

    const realServer = server;
    server = failingServer;
    try {
      const alice = await createUser("FailAlice");
      const bob = await createUser("FailBob");
      await makeFriends(alice, bob);

      const raceId = await createRace(alice, { name: "Boom Crew" });
      await invite(alice, raceId, [bob]);

      const res = await respond(bob, raceId, true);
      assert.equal(res.status, 200, "the accept must succeed");
      assert.deepEqual(Object.keys(res.body), ["participant"]);
      assert.equal(res.body.participant.status, "ACCEPTED");

      const race = await prisma.race.findUnique({ where: { id: raceId } });
      assert.equal(race.status, "PENDING", "a failed auto-start leaves it startable");
    } finally {
      server = realServer;
      await failingServer.close();
    }
  });
});
