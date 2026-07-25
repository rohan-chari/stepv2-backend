// Feature batch 2026-07-25 — §3 (D3): Uprising's TEAM gate must agree with the
// board.
//
// The board's team totals (GET /races/:id/progress -> teams.teamA/teamB) are
// EFFECTIVE steps: raw walked steps plus every scoring term (bonusSteps,
// multipliers, transfers). The gate used to sum the participants' PERSISTED
// `totalSteps` column, which is only rewritten when some scoring path last ran
// — so the number the gate saw could contradict the number on the player's
// screen. This suite pins the two together end-to-end: the losing team BY THE
// BOARD can fire Uprising and the winning team cannot, in a race where the
// persisted column and the board disagree.
//
// Explicitly out of scope (D3): sortedActiveParticipants and every other
// raw-`totalSteps` targeting site. Only the team branch is fixed here.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");

let server;
let nextAppleId = 0;
const HEADERS = {
  "X-Client-Features": "characters,team_races,powerups2,powerups3,powerups4,powerups5",
};

async function createUser(displayName) {
  const appleId = `apple-upr-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  const token = body.sessionToken;
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token,
  });
  await request(server.baseUrl, "GET", "/auth/me", { token, headers: HEADERS });
  return { userId: body.user.id, token, displayName };
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
    headers: HEADERS,
  });
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
    body: { accept: true },
    token: b.token,
    headers: HEADERS,
  });
}

// A started NvN team race with powerups on. teamA[0] is the creator (TEAM_A).
async function startedTeamRace(teamA, teamB) {
  const teamSize = teamA.length;
  const creator = teamA[0];
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: `Uprising ${teamSize}v${teamSize}`,
      maxDurationDays: 7,
      isTeamRace: true,
      teamSize,
      powerupsEnabled: true,
    },
    token: creator.token,
    headers: HEADERS,
  });
  const race = (await createRes.json()).race;
  const invitees = [...teamA.slice(1), ...teamB];
  for (const u of invitees) await makeFriends(creator, u);
  await request(server.baseUrl, "POST", `/races/${race.id}/invite`, {
    body: { inviteeIds: invitees.map((u) => u.userId) },
    token: creator.token,
    headers: HEADERS,
  });
  for (const u of teamA.slice(1)) {
    const res = await request(server.baseUrl, "PUT", `/races/${race.id}/respond`, {
      body: { accept: true, team: "TEAM_A" },
      token: u.token,
      headers: HEADERS,
    });
    assert.equal(res.status, 200);
  }
  for (const u of teamB) {
    const res = await request(server.baseUrl, "PUT", `/races/${race.id}/respond`, {
      body: { accept: true, team: "TEAM_B" },
      token: u.token,
      headers: HEADERS,
    });
    assert.equal(res.status, 200);
  }
  const startRes = await request(server.baseUrl, "POST", `/races/${race.id}/start`, {
    token: creator.token,
    headers: HEADERS,
  });
  assert.equal(startRes.status, 200);
  return race.id;
}

// Backdate to UTC midnight (so the race-relative window covers the whole day)
// and give each user a real daily step row. The race stays ACTIVE.
async function backdateAndWalk(raceId, stepsByUserId) {
  const now = new Date();
  const startedAt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  await prisma.race.update({
    where: { id: raceId },
    data: {
      startedAt,
      endsAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      timezone: "UTC",
    },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: startedAt, baselineSteps: 0 },
  });
  for (const [userId, steps] of Object.entries(stepsByUserId)) {
    await prisma.step.upsert({
      where: { userId_date: { userId, date: startedAt } },
      update: { steps },
      create: { userId, steps, date: startedAt },
    });
  }
}

async function giveHeldUprising(raceId, userId) {
  const participant = await prisma.raceParticipant.findFirst({
    where: { raceId, userId },
  });
  const row = await prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type: "UPRISING",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 0,
    },
  });
  return row.id;
}

function useUprising(token, raceId, powerupId) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body: {},
    token,
    headers: HEADERS,
  });
}

async function boardTeams(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
    token,
    headers: HEADERS,
  });
  assert.equal(res.status, 200);
  return (await res.json()).progress.teams;
}

async function activeUprisingTargets(raceId) {
  const rows = await prisma.raceActiveEffect.findMany({
    where: { raceId, type: "UPRISING" },
    select: { targetUserId: true },
  });
  return rows.map((r) => r.targetUserId).sort();
}

describe("feature batch 2026-07-25 — §3 Uprising team gate", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    await appSettings.setFlag("teamRacesEnabled", true);
    await appSettings.setFlag("fundedPrizePoolsEnabled", false);
  });

  // Raw walked steps: TEAM_A 5,000 vs TEAM_B 4,000  -> A leads on RAW.
  // bonusSteps (a scoring-only term that never appears in the steps table):
  // +3,000 to TEAM_B -> TEAM_B 7,000 vs TEAM_A 5,000 on the BOARD.
  // So the team LOSING on the board is TEAM_A, and the team leading on the raw
  // column is TEAM_A too — the two disagree, which is the whole point.
  //
  // NOTE: the powerup-use tests below deliberately do NOT read the progress
  // endpoint first. Reading it rewrites the persisted `totalSteps` column as a
  // side effect, which would mask the bug this suite exists to catch.
  async function divergentRace() {
    const alice = await createUser("UprAliceA");
    const amy = await createUser("UprAmyA");
    const bob = await createUser("UprBobB");
    const ben = await createUser("UprBenB");
    const raceId = await startedTeamRace([alice, amy], [bob, ben]);
    await backdateAndWalk(raceId, {
      [alice.userId]: 5000,
      [amy.userId]: 0,
      [bob.userId]: 4000,
      [ben.userId]: 0,
    });
    const bobP = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: bob.userId },
    });
    await prisma.raceParticipant.update({
      where: { id: bobP.id },
      data: { bonusSteps: 3000 },
    });
    return { alice, amy, bob, ben, raceId };
  }

  it("the board shows TEAM_B ahead even though TEAM_A walked more raw steps", async () => {
    const { alice, raceId } = await divergentRace();
    const teams = await boardTeams(alice.token, raceId);
    assert.equal(teams.teamA.totalSteps, 5000);
    assert.equal(teams.teamB.totalSteps, 7000);
    assert.ok(
      teams.teamA.totalSteps < teams.teamB.totalSteps,
      "TEAM_A is behind on the board"
    );
  });

  it("the team WINNING on the board cannot fire Uprising", async () => {
    const { bob, raceId } = await divergentRace();
    const bobPowerup = await giveHeldUprising(raceId, bob.userId);
    const res = await useUprising(bob.token, raceId, bobPowerup);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /losing team/);
    assert.equal(
      (await activeUprisingTargets(raceId)).length,
      0,
      "no buff applied on a rejected use"
    );
  });

  it("the team LOSING on the board can fire Uprising, and buffs only its own side", async () => {
    const { alice, amy, raceId } = await divergentRace();
    const alicePowerup = await giveHeldUprising(raceId, alice.userId);
    const res = await useUprising(alice.token, raceId, alicePowerup);
    assert.equal(res.status, 200);
    assert.deepEqual(
      await activeUprisingTargets(raceId),
      [alice.userId, amy.userId].sort(),
      "the whole caster team is buffed, nobody on the other team"
    );
  });

  for (const size of [1, 2, 3, 4, 5]) {
    it(`${size}v${size}: beneficiaries are every alive member of the caster's team and nobody on the other team`, async () => {
      const teamA = [];
      const teamB = [];
      for (let i = 0; i < size; i++) {
        teamA.push(await createUser(`UprA${size}x${i}`));
        teamB.push(await createUser(`UprB${size}x${i}`));
      }
      const raceId = await startedTeamRace(teamA, teamB);
      // TEAM_B walks more, so TEAM_A is the losing team on the board.
      const steps = {};
      for (const u of teamA) steps[u.userId] = 100;
      for (const u of teamB) steps[u.userId] = 5000;
      await backdateAndWalk(raceId, steps);

      const teams = await boardTeams(teamA[0].token, raceId);
      assert.ok(teams.teamA.totalSteps < teams.teamB.totalSteps);

      const powerupId = await giveHeldUprising(raceId, teamA[0].userId);
      const res = await useUprising(teamA[0].token, raceId, powerupId);
      assert.equal(res.status, 200);

      const buffed = await activeUprisingTargets(raceId);
      assert.deepEqual(
        buffed,
        teamA.map((u) => u.userId).sort(),
        "exactly the caster's team"
      );
      for (const u of teamB) {
        assert.ok(!buffed.includes(u.userId), "no opponent is ever buffed");
      }
    });
  }

  it("a forfeited team-mate is not a beneficiary", async () => {
    const alice = await createUser("UprFfA");
    const amy = await createUser("UprFfB");
    const bob = await createUser("UprFfC");
    const ben = await createUser("UprFfD");
    const raceId = await startedTeamRace([alice, amy], [bob, ben]);
    await backdateAndWalk(raceId, {
      [alice.userId]: 100,
      [amy.userId]: 100,
      [bob.userId]: 5000,
      [ben.userId]: 5000,
    });
    const amyP = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: amy.userId },
    });
    await prisma.raceParticipant.update({
      where: { id: amyP.id },
      data: { forfeitedAt: new Date() },
    });

    const powerupId = await giveHeldUprising(raceId, alice.userId);
    const res = await useUprising(alice.token, raceId, powerupId);
    assert.equal(res.status, 200);
    assert.deepEqual(await activeUprisingTargets(raceId), [alice.userId]);
  });
});
