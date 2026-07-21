const assert = require("node:assert/strict");
const test = require("node:test");

const { buildGetPublicRaces } = require("../../src/modules/races/queries/getPublicRaces");

// ── getRaces (my races list) — TR-702 filtering + TR-806 team fields ────────
// getRaces imports the Race + RacePowerup models directly; mock the modules and
// re-require (same pattern as getRacesResultsSeen.test.js).
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

function baseRace(overrides = {}) {
  return {
    id: overrides.id || "race-1",
    name: "Race",
    status: "PENDING",
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
    participants: [
      {
        userId: "user-1",
        status: "ACCEPTED",
        totalSteps: 0,
        buyInAmount: 0,
        buyInStatus: "NONE",
        team: null,
      },
    ],
    ...overrides,
  };
}

function teamRace(overrides = {}) {
  return baseRace({
    id: overrides.id || "team-race-1",
    isTeamRace: true,
    teamSize: 2,
    teamAName: "Swift Capys",
    teamBName: "Turbo Beavers",
    winnerTeam: null,
    participants: [
      { userId: "user-1", status: "ACCEPTED", totalSteps: 100, team: "TEAM_A", buyInAmount: 0, buyInStatus: "NONE" },
      { userId: "user-2", status: "ACCEPTED", totalSteps: 40, team: "TEAM_B", buyInAmount: 0, buyInStatus: "NONE" },
    ],
    ...overrides,
  });
}

test("TR-702 getRaces hides team races from clients without the token", async () => {
  await withMockedRaces([teamRace(), baseRace({ id: "solo-1" })], async ({ getRaces }) => {
    const result = await getRaces("user-1", false);
    const ids = [...result.active, ...result.pending, ...result.completed].map(
      (r) => r.id
    );
    assert.deepEqual(ids, ["solo-1"]);
  });
});

test("TR-702 getRaces includes team races (with team fields) for token clients", async () => {
  await withMockedRaces([teamRace()], async ({ getRaces }) => {
    const result = await getRaces("user-1", true);
    assert.equal(result.pending.length, 1);
    const summary = result.pending[0];
    assert.equal(summary.isTeamRace, true);
    assert.equal(summary.teamSize, 2);
    assert.equal(summary.teamAName, "Swift Capys");
    assert.equal(summary.teamBName, "Turbo Beavers");
    assert.equal(summary.myTeam, "TEAM_A");
    assert.equal(summary.teamATotalSteps, 100);
    assert.equal(summary.teamBTotalSteps, 40);
  });
});

test("individual race summaries stay shape-compatible (isTeamRace false)", async () => {
  await withMockedRaces([baseRace({ id: "solo-1" })], async ({ getRaces }) => {
    const result = await getRaces("user-1", true);
    assert.equal(result.pending[0].isTeamRace, false);
    assert.equal(result.pending[0].teamAName ?? null, null);
  });
});

// ── getPublicRaces — TR-702 + TR-204 + TR-206 ───────────────────────────────
function publicDeps(races) {
  return {
    Race: {
      async findPublicPending() {
        return races;
      },
    },
  };
}

test("TR-702 public browser hides team races from old clients", async () => {
  const races = [
    teamRace({ id: "team-pub", isPublic: true }),
    baseRace({ id: "solo-pub", isPublic: true }),
  ];
  const getPublicRaces = buildGetPublicRaces(publicDeps(races));
  const result = await getPublicRaces({ userId: "viewer", supportsTeamRaces: false });
  assert.deepEqual(result.map((r) => r.id), ["solo-pub"]);
});

test("TR-204 public browser lists team races only while PENDING", async () => {
  const races = [
    teamRace({ id: "team-pending", isPublic: true }),
    teamRace({ id: "team-active", isPublic: true, status: "ACTIVE" }),
  ];
  const getPublicRaces = buildGetPublicRaces(publicDeps(races));
  const result = await getPublicRaces({ userId: "viewer", supportsTeamRaces: true });
  assert.deepEqual(result.map((r) => r.id), ["team-pending"]);
});

test("TR-206 public team race card exposes format + per-side open slots", async () => {
  const races = [teamRace({ id: "team-pub", isPublic: true })];
  const getPublicRaces = buildGetPublicRaces(publicDeps(races));
  const [card] = await getPublicRaces({ userId: "viewer", supportsTeamRaces: true });
  assert.equal(card.isTeamRace, true);
  assert.equal(card.teamSize, 2);
  assert.equal(card.teamAName, "Swift Capys");
  assert.equal(card.teamBName, "Turbo Beavers");
  assert.equal(card.teamAOpenSlots, 1);
  assert.equal(card.teamBOpenSlots, 1);
});
