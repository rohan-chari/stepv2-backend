const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");

const HOME = { "X-Client-Features": "home_invite_modal,tournaments" };

async function raceInvite({ creator, invitee, name, status = "PENDING", expiresAt, team = false, tournamentId = null }) {
  const race = await prisma.race.create({
    data: {
      creatorId: creator.id,
      tournamentId,
      name,
      targetSteps: 0,
      status,
      timeBased: true,
      maxDurationDays: 3,
      buyInAmount: 10,
      isTeamRace: team,
      teamSize: team ? 2 : null,
      startedAt: status === "ACTIVE" ? new Date(Date.now() - 60_000) : null,
      endsAt: new Date(Date.now() + 86_400_000),
    },
  });
  await prisma.raceParticipant.create({
    data: { raceId: race.id, userId: invitee.id, status: "INVITED", inviteExpiresAt: expiresAt },
  });
  return race;
}

async function tournamentInvite({ creator, invitee, name }) {
  const tournament = await prisma.tournament.create({
    data: {
      creatorId: creator.id,
      name,
      bracketSize: 4,
      totalRounds: 2,
      matchupDurationDays: 1,
      buyInAmount: 50,
      status: "PENDING",
    },
  });
  await prisma.tournamentParticipant.create({
    data: { tournamentId: tournament.id, userId: invitee.id, status: "INVITED" },
  });
  return tournament;
}

describe("Home invite preflight (integration)", () => {
  let baseUrl;
  before(async () => {
    baseUrl = (await getSharedServer()).baseUrl;
  });
  beforeEach(async () => {
    await cleanDatabase();
    await appSettings.setFlag("homeInviteModalEnabled", true);
  });

  it("returns the exact capability-scoped Home contract, canonical order, and no private surplus", async () => {
    const creator = (await createTestUser({ displayName: "Host" })).user;
    const { user: invitee, token } = await createTestUser({ displayName: "Runner" });
    const future = new Date(Date.now() + 86_400_000);
    const active = await raceInvite({ creator, invitee, name: "Underway", status: "ACTIVE", expiresAt: future, team: true });
    const pending = await raceInvite({ creator, invitee, name: "Later", expiresAt: new Date(Date.now() + 172_800_000) });
    const tournament = await tournamentInvite({ creator, invitee, name: "Weekend Cup" });

    const res = await request(baseUrl, "GET", "/races/invite-preflight", { token, headers: HOME });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ["resolved", "invites"]);
    assert.equal(body.resolved, true);
    assert.deepEqual(body.invites.map((i) => [i.kind, i.id]), [
      ["TOURNAMENT", tournament.id],
      ["RACE", active.id],
      ["RACE", pending.id],
    ]);
    assert.deepEqual(body.invites[0], {
      kind: "TOURNAMENT", id: tournament.id, name: "Weekend Cup", status: "PENDING",
      createdAt: body.invites[0].createdAt, matchupDurationDays: 1, buyInAmount: 50,
      creator: { id: creator.id, displayName: "Host" },
    });
    assert.equal(body.invites[1].isTeamRace, true);
    assert.equal(body.invites[1].requiresTeamRaceSupport, true);
    assert.equal("participants" in body.invites[1], false);
    assert.equal("profilePhotoUrl" in body.invites[1].creator, false);
  });

  it("excludes expired and tournament-managed race invites; expired response is atomic INVITE_EXPIRED", async () => {
    const creator = (await createTestUser({ displayName: "Host" })).user;
    const { user: invitee, token } = await createTestUser({ displayName: "Runner" });
    const expired = await raceInvite({ creator, invitee, name: "Expired", expiresAt: new Date(Date.now() - 1_000) });
    const tournament = await tournamentInvite({ creator, invitee, name: "Managed" });
    await raceInvite({ creator, invitee, name: "Managed race", tournamentId: tournament.id });
    const preflight = await request(baseUrl, "GET", "/races/invite-preflight", { token, headers: HOME });
    const preflightBody = await preflight.json();
    assert.deepEqual(preflightBody.invites.map((invite) => [invite.kind, invite.id]), [
      ["TOURNAMENT", tournament.id],
    ]);

    const respond = await request(baseUrl, "PUT", `/races/${expired.id}/respond`, {
      token,
      body: { accept: true },
    });
    assert.equal(respond.status, 409);
    assert.deepEqual(await respond.json(), {
      error: "This invite has expired",
      code: "INVITE_EXPIRED",
    });
    const participant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: expired.id, userId: invitee.id } },
    });
    assert.equal(participant.status, "INVITED");
  });

  it("keeps frozen gate clients byte-compatible and omits tournaments without their capability", async () => {
    const creator = (await createTestUser({ displayName: "Host" })).user;
    const { user: invitee, token } = await createTestUser({ displayName: "Runner" });
    const race = await raceInvite({ creator, invitee, name: "Legacy" });
    await tournamentInvite({ creator, invitee, name: "No renderer" });
    const legacy = await request(baseUrl, "GET", "/races/invite-preflight", { token });
    assert.deepEqual(await legacy.json(), {
      active: [],
      pending: [{
        id: race.id, name: "Legacy", status: "PENDING", maxDurationDays: 3,
        buyInAmount: 10, scheduledStartAt: null, createdAt: (await prisma.race.findUnique({ where: { id: race.id } })).createdAt.toISOString(),
        creator: { id: creator.id, displayName: "Host", profilePhotoUrl: null },
        myStatus: "INVITED", myInviteExpiresAt: null,
      }],
    });
    await appSettings.setFlag("homeInviteModalEnabled", false);
    const flagOff = await request(baseUrl, "GET", "/races/invite-preflight", {
      token, headers: HOME,
    });
    const flagOffBody = await flagOff.json();
    assert.equal("resolved" in flagOffBody, false, "default-off flag preserves legacy serializer");
    await appSettings.setFlag("homeInviteModalEnabled", true);
    const noTournament = await request(baseUrl, "GET", "/races/invite-preflight", {
      token, headers: { "X-Client-Features": "home_invite_modal" },
    });
    const home = await noTournament.json();
    assert.equal(home.resolved, true);
    assert.deepEqual(home.invites.map((invite) => invite.kind), ["RACE"]);
  });
});
