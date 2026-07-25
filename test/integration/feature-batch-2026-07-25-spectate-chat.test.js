// Feature batch 2026-07-25 — §5: a bracket player may READ any sibling
// matchup's chat and activity feed.
//
// getRaceDetails / getRaceProgress already accept a tournament spectator
// (tournamentAccess.isTournamentParticipant). The two feed queries never got
// the same relaxation, so a spectator's chat/activity panel 403'd. These tests
// pin the relaxation AND its three hard edges:
//   * a user with NO tournament relation still gets 403 (a wide-open endpoint
//     would pass a positive-path-only test);
//   * a spectator POSTing a message still gets 403 — writes stay
//     participant-only;
//   * stealth redaction still applies to a spectator, who is a NEW caller of
//     redaction code written for participants.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { completeRace } = require("../../src/modules/races/commands/completeRace");
const { appSettings } = require("../../src/shared/config/appSettings");

let server;
let nextAppleId = 0;
const FEAT = "tournaments,characters,powerups2,powerups3,powerups4,powerups5";

function authReq(method, path, { body, token } = {}) {
  return request(server.baseUrl, method, path, {
    body,
    token,
    headers: { "X-Client-Features": FEAT },
  });
}

async function createUser(displayName) {
  const appleId = `apple-spec-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  const token = body.sessionToken;
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token,
  });
  await authReq("GET", "/races", { token });
  return { userId: body.user.id, token, displayName };
}

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

// A started free 4-bracket. Returns the two round-1 races and the players.
async function fourBracket() {
  const a = await createUser("SpecA");
  const b = await createUser("SpecB");
  const c = await createUser("SpecC");
  const d = await createUser("SpecD");
  const createRes = await authReq("POST", "/tournaments", {
    token: a.token,
    body: {
      name: "Spectate Cup",
      bracketSize: 4,
      matchupDurationDays: 1,
      buyInAmount: 0,
      isPublic: true,
      powerupsEnabled: true,
      inviteeIds: [],
    },
  });
  const { tournament } = await createRes.json();
  for (const u of [b, c, d]) {
    await authReq("POST", `/tournaments/${tournament.id}/join`, { token: u.token });
  }
  const round1 = await prisma.race.findMany({
    where: { tournamentId: tournament.id, tournamentRound: 1 },
    include: { participants: true },
    orderBy: { tournamentMatchIndex: "asc" },
  });
  const byUser = Object.fromEntries([a, b, c, d].map((u) => [u.userId, u]));
  return { tournamentId: tournament.id, round1, byUser, users: [a, b, c, d] };
}

describe("feature batch 2026-07-25 — §5 spectate chat + feed", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    await appSettings.setFlag("tournamentsEnabled", true);
  });

  it("a bracket player (and an ELIMINATED one) can GET a sibling matchup's messages and feed", async () => {
    const { round1, byUser } = await fourBracket();
    const [matchA, matchB] = round1;
    const matchAplayers = matchA.participants
      .filter((p) => p.status === "ACCEPTED")
      .map((p) => p.userId);
    const matchBplayers = matchB.participants
      .filter((p) => p.status === "ACCEPTED")
      .map((p) => p.userId);

    // A matchA player posts a message in their own race.
    const post = await authReq("POST", `/races/${matchA.id}/messages`, {
      token: byUser[matchAplayers[0]].token,
      body: { body: "hello from match A" },
    });
    assert.equal(post.status, 201);

    // A matchB player — a bracket sibling, not a participant — can read it.
    const spectator = byUser[matchBplayers[0]];
    const msgRes = await authReq("GET", `/races/${matchA.id}/messages`, {
      token: spectator.token,
    });
    assert.equal(msgRes.status, 200);
    const msgBody = await msgRes.json();
    assert.ok(
      msgBody.messages.some((m) => m.body === "hello from match A"),
      "spectator sees the chat"
    );

    const feedRes = await authReq("GET", `/races/${matchA.id}/feed`, {
      token: spectator.token,
    });
    assert.equal(feedRes.status, 200);
    assert.ok(Array.isArray((await feedRes.json()).events));

    // Now eliminate matchB's loser and confirm they keep read access to the final.
    for (const r of round1) {
      const [p0, p1] = r.participants.filter((p) => p.status === "ACCEPTED");
      await settleMatchup(r.id, { [p0.userId]: 5000, [p1.userId]: 100 });
    }
    const eliminated = byUser[matchBplayers[1]];
    const finalRace = await prisma.race.findFirst({
      where: { tournamentRound: 2 },
    });
    const elimMsgs = await authReq("GET", `/races/${finalRace.id}/messages`, {
      token: eliminated.token,
    });
    assert.equal(elimMsgs.status, 200, "eliminated players still read the bracket");
    const elimFeed = await authReq("GET", `/races/${finalRace.id}/feed`, {
      token: eliminated.token,
    });
    assert.equal(elimFeed.status, 200);
  });

  it("a user with NO tournament relation still gets 403 on both reads", async () => {
    const { round1 } = await fourBracket();
    const outsider = await createUser("SpecOutsider");

    const msgRes = await authReq("GET", `/races/${round1[0].id}/messages`, {
      token: outsider.token,
    });
    assert.equal(msgRes.status, 403);

    const feedRes = await authReq("GET", `/races/${round1[0].id}/feed`, {
      token: outsider.token,
    });
    assert.equal(feedRes.status, 403);
  });

  it("a non-tournament race is unchanged: a stranger still 403s on messages and feed", async () => {
    const host = await createUser("SpecHost");
    const stranger = await createUser("SpecStranger");
    const createRes = await authReq("POST", "/races", {
      token: host.token,
      body: { name: "Plain Race", maxDurationDays: 3, isPublic: true },
    });
    const { race } = await createRes.json();

    assert.equal(
      (await authReq("GET", `/races/${race.id}/messages`, { token: stranger.token })).status,
      403
    );
    assert.equal(
      (await authReq("GET", `/races/${race.id}/feed`, { token: stranger.token })).status,
      403
    );
  });

  it("a spectator POSTing a message is still rejected (writes stay participant-only)", async () => {
    const { round1, byUser } = await fourBracket();
    const [matchA, matchB] = round1;
    const spectator =
      byUser[matchB.participants.filter((p) => p.status === "ACCEPTED")[0].userId];

    const res = await authReq("POST", `/races/${matchA.id}/messages`, {
      token: spectator.token,
      body: { body: "let me in" },
    });
    assert.equal(res.status, 403);
    const stored = await prisma.raceMessage.count({ where: { raceId: matchA.id } });
    assert.equal(stored, 0, "nothing was written");
  });

  it("a spectator deleting a message is still rejected", async () => {
    const { round1, byUser } = await fourBracket();
    const [matchA, matchB] = round1;
    const author = byUser[
      matchA.participants.filter((p) => p.status === "ACCEPTED")[0].userId
    ];
    const post = await authReq("POST", `/races/${matchA.id}/messages`, {
      token: author.token,
      body: { body: "mine" },
    });
    const messageId = (await post.json()).message.id;
    // Pick a spectator who is NOT matchA's race creator — the creator is
    // allowed to moderate their own race, which is unrelated to spectating.
    const spectator = matchB.participants
      .filter((p) => p.status === "ACCEPTED")
      .map((p) => byUser[p.userId])
      .find((u) => u.userId !== matchA.creatorId);
    assert.ok(spectator, "need a non-creator spectator");

    const res = await authReq(
      "DELETE",
      `/races/${matchA.id}/messages/${messageId}`,
      { token: spectator.token }
    );
    assert.ok(res.status >= 400, "spectator cannot delete");
    assert.equal(await prisma.raceMessage.count({ where: { raceId: matchA.id } }), 1);
  });

  it("a stealthed participant's name is redacted for a spectator", async () => {
    const { round1, byUser } = await fourBracket();
    const [matchA, matchB] = round1;
    const players = matchA.participants.filter((p) => p.status === "ACCEPTED");
    const stealthed = byUser[players[0].userId];
    const other = byUser[players[1].userId];

    // A SYSTEM feed row naming the stealthed runner, plus a live STEALTH_MODE
    // effect on them (exactly the shape the redaction branch reads).
    await prisma.racePowerupEvent.create({
      data: {
        raceId: matchA.id,
        actorUserId: stealthed.userId,
        eventType: "POWERUP_USED",
        powerupType: "RUNNERS_HIGH",
        description: `${stealthed.displayName} used Runner's High!`,
      },
    });
    const powerup = await prisma.racePowerup.create({
      data: {
        raceId: matchA.id,
        participantId: players[0].id,
        userId: stealthed.userId,
        type: "STEALTH_MODE",
        rarity: "RARE",
        status: "USED",
        earnedAtSteps: 0,
      },
    });
    await prisma.raceActiveEffect.create({
      data: {
        raceId: matchA.id,
        targetParticipantId: players[0].id,
        targetUserId: stealthed.userId,
        sourceUserId: stealthed.userId,
        powerupId: powerup.id,
        type: "STEALTH_MODE",
        status: "ACTIVE",
        startsAt: new Date(Date.now() - 60 * 1000),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const spectator =
      byUser[matchB.participants.filter((p) => p.status === "ACCEPTED")[0].userId];
    const feed = await authReq("GET", `/races/${matchA.id}/feed`, {
      token: spectator.token,
    });
    assert.equal(feed.status, 200);
    const events = (await feed.json()).events;
    const row = events.find((e) => e.eventType === "POWERUP_USED");
    assert.ok(row, "the system row is visible to the spectator");
    assert.ok(
      !row.description.includes(stealthed.displayName),
      `spectator must not see the stealthed name, got: ${row.description}`
    );

    // Same through the merged messages endpoint (SYSTEM items included).
    const msgs = await authReq("GET", `/races/${matchA.id}/messages`, {
      token: spectator.token,
    });
    assert.equal(msgs.status, 200);
    const merged = (await msgs.json()).messages;
    for (const m of merged) {
      if (typeof m.body === "string") {
        assert.ok(
          !m.body.includes(stealthed.displayName),
          `stealthed name leaked to spectator: ${m.body}`
        );
      }
    }

    // The stealthed user still sees their own name.
    const own = await authReq("GET", `/races/${matchA.id}/feed`, {
      token: stealthed.token,
    });
    const ownRow = (await own.json()).events.find((e) => e.eventType === "POWERUP_USED");
    assert.ok(ownRow.description.includes(stealthed.displayName));
    void other;
  });
});
