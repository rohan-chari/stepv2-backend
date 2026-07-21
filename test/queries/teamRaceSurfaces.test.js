const assert = require("node:assert/strict");
const test = require("node:test");

const { buildGetPublicRaces } = require("../../src/modules/races/queries/getPublicRaces");
const { buildGetHomeRaceCard } = require("../../src/modules/home/getHomeRaceCard");

// Frontend-requested payload additions (contract FRONTEND QUESTIONS Q5/Q6/Q7):
//   Q7 — myTeam + myForfeited on GET /races so the results modal (TR-807) can
//        frame win/loss from the viewer's side and gate the review prompt.
//   Q5 — the same `teams` block the progress endpoint returns, on GET /races
//        rows and the Home race-card, for the TR-806/TR-809 mini scoreline.
//   Q6 — per-side memberCount on GET /races/public for the TR-206 slots line.
// All additive and behind the same team_races gating (TR-702).

// ── GET /races ──────────────────────────────────────────────────────────────
function withMockedRaces(races, fn) {
  const raceModule = require("../../src/modules/races/models/race");
  const powerupModule = require("../../src/modules/powerups/models/racePowerup");
  const originalRace = raceModule.Race;
  const originalPowerup = powerupModule.RacePowerup;

  Object.assign(raceModule, {
    Race: { async findForUser() { return races; } },
  });
  Object.assign(powerupModule, {
    RacePowerup: {
      async countQueuedByParticipant() { return 0; },
      async findSlotPowerups() { return []; },
    },
  });

  try {
    delete require.cache[require.resolve("../../src/modules/races/queries/getRaces")];
    const mod = require("../../src/modules/races/queries/getRaces");
    return fn(mod);
  } finally {
    Object.assign(raceModule, { Race: originalRace });
    Object.assign(powerupModule, { RacePowerup: originalPowerup });
    delete require.cache[require.resolve("../../src/modules/races/queries/getRaces")];
  }
}

function member(userId, team, overrides = {}) {
  return {
    userId,
    status: "ACCEPTED",
    totalSteps: 0,
    buyInAmount: 0,
    buyInStatus: "NONE",
    team,
    forfeitedAt: null,
    ...overrides,
  };
}

function teamRace(overrides = {}) {
  return {
    id: "team-race-1",
    name: "Team Battle",
    status: "ACTIVE",
    creatorId: "user-1",
    maxDurationDays: 7,
    targetSteps: 0,
    buyInAmount: 0,
    payoutPreset: "WINNER_TAKES_ALL",
    potCoins: 0,
    powerupsEnabled: false,
    isPublic: false,
    maxParticipants: 4,
    seedId: null,
    createdAt: new Date(),
    isTeamRace: true,
    teamSize: 2,
    teamAName: "Swift Capys",
    teamBName: "Turbo Beavers",
    winnerTeam: null,
    participants: [
      member("user-1", "TEAM_A", { totalSteps: 7000 }),
      member("user-2", "TEAM_A", { totalSteps: 5340 }),
      member("user-3", "TEAM_B", { totalSteps: 6900 }),
      member("user-4", "TEAM_B", { totalSteps: 5000 }),
    ],
    ...overrides,
  };
}

test("Q5 GET /races active team race carries the same `teams` block shape as progress", async () => {
  await withMockedRaces([teamRace()], async ({ getRaces }) => {
    const result = await getRaces("user-1", true);
    const row = result.active[0];
    assert.ok(row.teams, "teams block present");
    assert.deepEqual(row.teams.teamA, {
      name: "Swift Capys",
      totalSteps: 12340,
      memberCount: 2,
    });
    assert.deepEqual(row.teams.teamB, {
      name: "Turbo Beavers",
      totalSteps: 11900,
      memberCount: 2,
    });
  });
});

test("Q7 GET /races completed team race exposes myTeam + myForfeited for the results modal", async () => {
  const race = teamRace({
    status: "COMPLETED",
    winnerTeam: "TEAM_A",
    completedAt: new Date(),
    participants: [
      member("user-1", "TEAM_A", { totalSteps: 7000, placement: 1 }),
      member("user-2", "TEAM_A", {
        totalSteps: 5340,
        placement: 1,
        forfeitedAt: new Date("2026-07-12T00:00:00Z"),
      }),
      member("user-3", "TEAM_B", { totalSteps: 6900, placement: 2 }),
    ],
  });
  await withMockedRaces([race], async ({ getRaces }) => {
    // Winner, not forfeited -> review prompt should qualify.
    const winner = (await getRaces("user-1", true)).completed[0];
    assert.equal(winner.myTeam, "TEAM_A");
    assert.equal(winner.myForfeited, false);
    assert.equal(winner.winnerTeam, "TEAM_A");

    // Winning team but forfeited -> must NOT qualify (TR-807).
    const forfeiter = (await getRaces("user-2", true)).completed[0];
    assert.equal(forfeiter.myTeam, "TEAM_A");
    assert.equal(forfeiter.myForfeited, true);

    // Losing side.
    const loser = (await getRaces("user-3", true)).completed[0];
    assert.equal(loser.myTeam, "TEAM_B");
    assert.equal(loser.myForfeited, false);
  });
});

test("Q7 individual races carry myTeam null and myForfeited false (shape-stable)", async () => {
  const solo = teamRace({
    id: "solo-1",
    isTeamRace: false,
    teamSize: null,
    teamAName: null,
    teamBName: null,
    participants: [member("user-1", null, { totalSteps: 100 })],
  });
  await withMockedRaces([solo], async ({ getRaces }) => {
    const row = (await getRaces("user-1", true)).active[0];
    assert.equal(row.myTeam, null);
    assert.equal(row.myForfeited, false);
    assert.equal(row.teams ?? null, null, "no teams block on individual races");
  });
});

test("TR-702 the teams block is never sent to clients without the token", async () => {
  await withMockedRaces([teamRace()], async ({ getRaces }) => {
    const result = await getRaces("user-1", false);
    assert.equal(result.active.length, 0, "team race filtered out entirely");
  });
});

// ── GET /races/public (Q6) ──────────────────────────────────────────────────
test("Q6 public browser carries per-side memberCount via the teams block", async () => {
  const race = teamRace({
    id: "team-pub",
    status: "PENDING",
    isPublic: true,
    participants: [
      member("user-1", "TEAM_A"),
      member("user-3", "TEAM_B"),
      member("user-9", "TEAM_B", { status: "INVITED" }), // must not count
    ],
  });
  const getPublicRaces = buildGetPublicRaces({
    Race: { async findPublicPending() { return [race]; } },
  });
  const [card] = await getPublicRaces({
    userId: "viewer",
    supportsTeamRaces: true,
  });
  assert.equal(card.teams.teamA.memberCount, 1);
  assert.equal(card.teams.teamB.memberCount, 1, "INVITED rows never occupy a slot");
  assert.equal(card.teams.teamA.name, "Swift Capys");
  // Existing open-slot fields stay for the "1 slot left on Blue" line.
  assert.equal(card.teamAOpenSlots, 1);
  assert.equal(card.teamBOpenSlots, 1);
});

// ── GET /home/race-card (Q5) ────────────────────────────────────────────────
const ME_ID = "user-1";

function homePrisma({ myActiveParticipation }) {
  return {
    raceParticipant: {
      async findMany() { return []; },
      async findFirst({ where }) {
        if (where.userId === ME_ID && where.status === "ACCEPTED") {
          return myActiveParticipation;
        }
        return null;
      },
    },
    friendship: { async findMany() { return []; } },
    race: { async findMany() { return []; }, async findFirst() { return null; } },
  };
}

function homeUser(id, name) {
  return { id, displayName: name, profilePhotoUrl: null, equippedAccessories: [] };
}

test("Q5 Home race-card carries the teams block + myTeam for a team race", async () => {
  const race = teamRace({
    participants: [
      { ...member("user-1", "TEAM_A", { totalSteps: 7000 }), user: homeUser("user-1", "Alice") },
      { ...member("user-2", "TEAM_A", { totalSteps: 5340 }), user: homeUser("user-2", "Bob") },
      { ...member("user-3", "TEAM_B", { totalSteps: 6900 }), user: homeUser("user-3", "Carol") },
      { ...member("user-4", "TEAM_B", { totalSteps: 5000 }), user: homeUser("user-4", "Dave") },
    ],
  });
  const getHomeRaceCard = buildGetHomeRaceCard({
    prisma: homePrisma({ myActiveParticipation: { race } }),
    now: () => new Date("2026-07-12T12:00:00Z"),
  });
  const card = await getHomeRaceCard({ userId: ME_ID, supportsTeamRaces: true });
  assert.equal(card.state, "ACTIVE_RACE");
  assert.equal(card.data.isTeamRace, true);
  assert.equal(card.data.myTeam, "TEAM_A");
  assert.equal(card.data.teams.teamA.totalSteps, 12340);
  assert.equal(card.data.teams.teamB.totalSteps, 11900);
  assert.equal(card.data.teams.teamA.name, "Swift Capys");
});

test("Q5/TR-702 Home race-card hides a team race from clients without the token", async () => {
  const race = teamRace({
    participants: [
      { ...member("user-1", "TEAM_A", { totalSteps: 7000 }), user: homeUser("user-1", "Alice") },
      { ...member("user-3", "TEAM_B", { totalSteps: 6900 }), user: homeUser("user-3", "Carol") },
    ],
  });
  const getHomeRaceCard = buildGetHomeRaceCard({
    prisma: homePrisma({ myActiveParticipation: { race } }),
    now: () => new Date("2026-07-12T12:00:00Z"),
  });
  const card = await getHomeRaceCard({ userId: ME_ID, supportsTeamRaces: false });
  assert.notEqual(
    card.state,
    "ACTIVE_RACE",
    "an old client must not get a team race rendered as an individual one"
  );
});

test("Q5 Home race-card for an individual race is unchanged (no team keys)", async () => {
  const race = teamRace({
    isTeamRace: false,
    teamSize: null,
    teamAName: null,
    teamBName: null,
    participants: [
      { ...member("user-1", null, { totalSteps: 7000 }), user: homeUser("user-1", "Alice") },
      { ...member("user-3", null, { totalSteps: 6900 }), user: homeUser("user-3", "Carol") },
    ],
  });
  const getHomeRaceCard = buildGetHomeRaceCard({
    prisma: homePrisma({ myActiveParticipation: { race } }),
    now: () => new Date("2026-07-12T12:00:00Z"),
  });
  const card = await getHomeRaceCard({ userId: ME_ID, supportsTeamRaces: true });
  assert.equal(card.state, "ACTIVE_RACE");
  assert.equal(card.data.isTeamRace ?? false, false);
  assert.equal(card.data.teams ?? null, null);
  assert.ok(card.data.leader, "individual card shape intact");
});
