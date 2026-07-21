const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { appSettings } = require("../../src/services/appSettings");

// GET /races — the additive `myCurrentMatch` block on tournament summaries (§5).
//
// Proves end to end that a live tournament matchup reports the SAME inventory,
// box counts and placement that the underlying race itself reports, so an active
// tournament row can render with an active race row's language.

let server;
let nextAppleId = 0;

const FEAT = "tournaments,characters,powerups2,powerups3";

function authReq(method, path, { body, token, features = FEAT } = {}) {
  return request(server.baseUrl, method, path, {
    body,
    token,
    headers: features ? { "X-Client-Features": features } : {},
  });
}

async function createUser(displayName) {
  const appleId = `apple-tcm-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  await authReq("GET", "/races", { token: body.sessionToken });
  return { userId: body.user.id, token: body.sessionToken };
}

// A 4-player bracket that pops when full, producing two live round-1 matchups.
async function fillFourBracket() {
  const a = await createUser("Alice");
  const b = await createUser("Bob");
  const c = await createUser("Carol");
  const d = await createUser("Dan");
  const createRes = await authReq("POST", "/tournaments", {
    token: a.token,
    body: {
      name: "Inventory Cup",
      bracketSize: 4,
      matchupDurationDays: 1,
      buyInAmount: 0,
      isPublic: true,
      powerupsEnabled: true,
      powerupStepInterval: 50000,
      inviteeIds: [],
    },
  });
  const { tournament } = await createRes.json();
  for (const user of [b, c, d]) {
    await authReq("POST", `/tournaments/${tournament.id}/join`, {
      token: user.token,
    });
  }
  return { users: { a, b, c, d }, tournamentId: tournament.id };
}

describe("tournament myCurrentMatch — integration", () => {
  before(async () => {
    server = await getSharedServer();
  });
  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    await appSettings.setFlag("tournamentsEnabled", true);
  });

  it("active matchup inventory matches the underlying race inventory", async () => {
    const { users, tournamentId } = await fillFourBracket();

    const matchup = await prisma.race.findFirst({
      where: { tournamentId, status: "ACTIVE" },
      include: { participants: true },
    });
    assert.ok(matchup, "round 1 produced a live matchup");
    const mine = matchup.participants.find((p) => p.status === "ACCEPTED");
    const viewer = Object.values(users).find((u) => u.userId === mine.userId);

    // Two held powerups, one unopened box in a slot, and one queued overflow box.
    await prisma.racePowerup.createMany({
      data: [
        { raceId: matchup.id, participantId: mine.id, userId: mine.userId, type: "LEG_CRAMP", rarity: "UNCOMMON", status: "HELD" },
        { raceId: matchup.id, participantId: mine.id, userId: mine.userId, type: "PROTEIN_SHAKE", rarity: "COMMON", status: "HELD" },
        { raceId: matchup.id, participantId: mine.id, userId: mine.userId, type: null, rarity: null, status: "MYSTERY_BOX" },
        { raceId: matchup.id, participantId: mine.id, userId: mine.userId, type: null, rarity: null, status: "QUEUED" },
      ],
    });

    const racesRes = await authReq("GET", "/races", { token: viewer.token });
    const races = await racesRes.json();
    const summary = races.tournaments.find((t) => t.id === tournamentId);
    assert.ok(summary, "the bracket appears in the tournaments bucket");

    // The legacy field is retained for clients already reading it.
    assert.equal(summary.myCurrentMatchRaceId, matchup.id);

    const match = summary.myCurrentMatch;
    assert.ok(match, "the additive block is present for a live matchup");
    assert.equal(match.raceId, matchup.id);
    assert.equal(
      new Date(match.endsAt).getTime(),
      matchup.endsAt.getTime()
    );
    assert.equal(match.queuedBoxCount, 1);
    assert.equal(match.mysteryBoxCount, 1);
    assert.equal(match.slotItems.length, 3, "2 held + 1 unopened box");
    assert.deepEqual(
      match.slotItems.map((i) => i.status).sort(),
      ["HELD", "HELD", "MYSTERY_BOX"]
    );
    assert.equal(match.myPlacementHidden, false);
    assert.ok(match.myPlacement >= 1 && match.myPlacement <= 2);

    // ...and it agrees with what the race itself reports.
    const progressRes = await authReq(
      "GET",
      `/races/${matchup.id}/progress`,
      { token: viewer.token }
    );
    const { progress } = await progressRes.json();
    assert.equal(progress.powerupData.queuedBoxCount, match.queuedBoxCount);
    assert.deepEqual(
      progress.powerupData.inventory.map((i) => i.id).sort(),
      match.slotItems.map((i) => i.id).sort(),
      "the summary's slot items are exactly the race's slot inventory"
    );
  });

  it("a rival's inventory never leaks into the viewer's matchup summary", async () => {
    const { users, tournamentId } = await fillFourBracket();
    const matchup = await prisma.race.findFirst({
      where: { tournamentId, status: "ACTIVE" },
      include: { participants: true },
    });
    const [mine, rival] = matchup.participants.filter(
      (p) => p.status === "ACCEPTED"
    );
    const viewer = Object.values(users).find((u) => u.userId === mine.userId);

    await prisma.racePowerup.create({
      data: { raceId: matchup.id, participantId: rival.id, userId: rival.userId, type: "SHORTCUT", rarity: "RARE", status: "HELD" },
    });

    const races = await (await authReq("GET", "/races", { token: viewer.token })).json();
    const match = races.tournaments.find((t) => t.id === tournamentId).myCurrentMatch;
    assert.deepEqual(match.slotItems, []);
    assert.equal(match.mysteryBoxCount, 0);
  });

  it("an old client still receives myCurrentMatchRaceId and simply ignores the new block", async () => {
    const { users, tournamentId } = await fillFourBracket();
    const matchup = await prisma.race.findFirst({
      where: { tournamentId, status: "ACTIVE" },
      include: { participants: true },
    });
    const mine = matchup.participants.find((p) => p.status === "ACCEPTED");
    const viewer = Object.values(users).find((u) => u.userId === mine.userId);

    // A client with the tournaments token but nothing newer.
    const races = await (
      await authReq("GET", "/races", {
        token: viewer.token,
        features: "tournaments",
      })
    ).json();
    const summary = races.tournaments.find((t) => t.id === tournamentId);
    assert.equal(
      summary.myCurrentMatchRaceId,
      matchup.id,
      "the legacy field is never removed"
    );
  });
});
