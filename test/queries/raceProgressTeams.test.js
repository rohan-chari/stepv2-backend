const assert = require("node:assert/strict");
const test = require("node:test");

const { buildGetRaceProgress } = require("../../src/modules/races/queries/getRaceProgress");

// TR-401 (team totals from effective steps), TR-656/658 (stealth/imposter mask
// individual planks only — team totals stay honest), TR-601 (forfeited members
// frozen but still counted in the team total).

function makeParticipant(id, userId, displayName, team, overrides = {}) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    totalSteps: 0,
    bonusSteps: 0,
    maxBonusSteps: 0,
    finishedAt: null,
    forfeitedAt: null,
    team,
    joinedAt: new Date("2026-07-10T00:00:00Z"),
    user: { displayName, profilePhotoUrl: null, equippedAccessories: [] },
    ...overrides,
  };
}

function makeDeps({ race, stealthTargets = [] }) {
  return {
    Race: {
      async findById() {
        return race;
      },
    },
    RaceParticipant: {
      // Mechanical (2026-08-09): production writes participant totals through
      // updateStepTotals({ totalSteps, rawSteps }); delegate so this fake keeps
      // recording exactly what it recorded before.
      async updateStepTotals(id, fields = {}) { return this.updateTotalSteps(id, fields.totalSteps); },
      async updateTotalSteps(id, total) {
        const p = race.participants.find((x) => x.id === id);
        if (p) p.totalSteps = total;
      },
      async findById(id) {
        return race.participants.find((x) => x.id === id) || null;
      },
    },
    Steps: {
      async findByUserIdAndDate(userId) {
        // Every non-forfeited member "walked" a fixed daily total on day 1.
        const walked = { "user-1": 5000, "user-2": 3000, "user-3": 4000, "user-4": 2000 };
        return { steps: walked[userId] ?? 0 };
      },
      async findByUserIdAndDateRange() {
        return []; // no steps on subsequent days
      },
    },
    StepSample: {
      async sumStepsInWindow() {
        return 0;
      },
      async findByUserIdAndTimeRange() {
        return [];
      },
    },
    RaceActiveEffect: {
      async findEffectsForRaceByType() {
        return [];
      },
      async findActiveForRace() {
        return stealthTargets.map((targetUserId, i) => ({
          id: `eff-${i}`,
          type: "STEALTH_MODE",
          targetUserId,
          status: "ACTIVE",
        }));
      },
      async findActiveByTypeForParticipant() {
        return null;
      },
    },
    GlobalStepEvent: {
      async findActiveInRange() {
        return [];
      },
    },
    expireEffects: async () => {},
    syncRacePowerupState: async () => ({ newMysteryBoxes: [] }),
    now: () => new Date("2026-07-12T12:00:00Z"),
  };
}

function teamRace(participants, overrides = {}) {
  return {
    id: "race-1",
    status: "ACTIVE",
    isTeamRace: true,
    teamSize: 2,
    teamAName: "Swift Capys",
    teamBName: "Turbo Beavers",
    winnerTeam: null,
    targetSteps: 0,
    timeBased: true,
    maxDurationDays: 7,
    startedAt: new Date("2026-07-10T00:00:00Z"),
    endsAt: new Date("2026-07-20T00:00:00Z"),
    powerupsEnabled: false,
    timezone: "UTC",
    participants,
    ...overrides,
  };
}

test("TR-401 progress exposes honest team totals summed from member effective steps", async () => {
  // A: user-1 5000 + user-2 3000 = 8000; B: user-3 4000 + user-4 2000 = 6000.
  const race = teamRace([
    makeParticipant("rp-1", "user-1", "Alice", "TEAM_A"),
    makeParticipant("rp-2", "user-2", "Bob", "TEAM_A"),
    makeParticipant("rp-3", "user-3", "Carol", "TEAM_B"),
    makeParticipant("rp-4", "user-4", "Dave", "TEAM_B"),
  ]);
  const getRaceProgress = buildGetRaceProgress(makeDeps({ race }));
  const progress = await getRaceProgress("user-1", "race-1", "UTC");

  assert.ok(progress.teams, "teams block present");
  assert.equal(progress.teams.teamA.name, "Swift Capys");
  assert.equal(progress.teams.teamA.totalSteps, 8000);
  assert.equal(progress.teams.teamB.totalSteps, 6000);
  assert.equal(progress.teams.teamA.memberCount, 2);
  const row = progress.participants.find((p) => p.userId === "user-3");
  assert.equal(row.team, "TEAM_B", "participants carry their side");
});

test("TR-656/658 stealthed member's plank is masked but the team total still includes them", async () => {
  const race = teamRace(
    [
      makeParticipant("rp-1", "user-1", "Alice", "TEAM_A"),
      makeParticipant("rp-2", "user-2", "Bob", "TEAM_A"),
      makeParticipant("rp-3", "user-3", "Carol", "TEAM_B"),
      makeParticipant("rp-4", "user-4", "Dave", "TEAM_B"),
    ],
    { powerupsEnabled: true, powerupStepInterval: null }
  );
  const getRaceProgress = buildGetRaceProgress(
    makeDeps({ race, stealthTargets: ["user-3"] })
  );
  const progress = await getRaceProgress("user-1", "race-1", "UTC");

  const carolRow = progress.participants.find((p) => p.userId === "user-3");
  assert.equal(carolRow.stealthed, true);
  assert.equal(carolRow.totalSteps, null, "individual plank masked");
  assert.equal(
    progress.teams.teamB.totalSteps,
    6000,
    "team total is honest and includes the stealthed member"
  );
});

test("TR-601 forfeited member is frozen at their snapshot but counts in the team total", async () => {
  const race = teamRace([
    makeParticipant("rp-1", "user-1", "Alice", "TEAM_A"),
    makeParticipant("rp-2", "user-2", "Bob", "TEAM_A", {
      forfeitedAt: new Date("2026-07-11T00:00:00Z"),
      totalSteps: 1111, // frozen — daily rows say 3000 but must NOT be recomputed
    }),
    makeParticipant("rp-3", "user-3", "Carol", "TEAM_B"),
    makeParticipant("rp-4", "user-4", "Dave", "TEAM_B"),
  ]);
  const getRaceProgress = buildGetRaceProgress(makeDeps({ race }));
  const progress = await getRaceProgress("user-1", "race-1", "UTC");

  const bobRow = progress.participants.find((p) => p.userId === "user-2");
  assert.equal(bobRow.totalSteps, 1111, "frozen, not recomputed to 3000");
  assert.ok(bobRow.forfeitedAt, "forfeitedAt exposed");
  assert.equal(progress.teams.teamA.totalSteps, 5000 + 1111);
});

test("PENDING team race progress exposes sides for the lobby", async () => {
  const race = teamRace(
    [
      makeParticipant("rp-1", "user-1", "Alice", "TEAM_A"),
      makeParticipant("rp-3", "user-3", "Carol", "TEAM_B"),
    ],
    { status: "PENDING", startedAt: null, endsAt: null }
  );
  const getRaceProgress = buildGetRaceProgress(makeDeps({ race }));
  const progress = await getRaceProgress("user-1", "race-1", "UTC");
  assert.equal(progress.teams.teamA.name, "Swift Capys");
  const row = progress.participants.find((p) => p.userId === "user-3");
  assert.equal(row.team, "TEAM_B");
});
