const assert = require("node:assert/strict");
const test = require("node:test");

const { buildStartRace } = require("../../src/commands/startRace");

function participant(userId, team, status = "ACCEPTED") {
  return {
    id: `rp-${userId}`,
    userId,
    status,
    team,
    buyInAmount: 0,
    buyInStatus: "NONE",
  };
}

function makeDeps({ race }) {
  const state = { flipped: null, updates: [] };
  const accepted = () =>
    race.participants.filter((p) => p.status === "ACCEPTED");
  return {
    state,
    deps: {
      Race: {
        async findById() {
          return race;
        },
        async updateIfPending(id, fields) {
          state.flipped = fields;
          race.status = "ACTIVE";
          return { count: 1 };
        },
      },
      RaceParticipant: {
        async countAccepted() {
          return accepted().length;
        },
        async findAcceptedByRace() {
          return accepted();
        },
        async update(id, fields) {
          state.updates.push({ id, fields });
          return {};
        },
      },
      Steps: {
        async findByUserIdAndDate() {
          return null;
        },
      },
      RacePowerupEvent: {
        async create() {
          return {};
        },
      },
      eventBus: { emit() {} },
    },
  };
}

function teamRace(participants, overrides = {}) {
  return {
    id: "race-1",
    creatorId: "creator",
    name: "Team Battle",
    status: "PENDING",
    isTeamRace: true,
    teamSize: 3,
    maxDurationDays: 7,
    potCoins: 0,
    payoutPreset: "WINNER_TAKES_ALL",
    powerupsEnabled: false,
    participants,
    ...overrides,
  };
}

// ── TR-301: equal-size, nonzero gate ────────────────────────────────────────
test("TR-301 uneven teams -> 409 TEAMS_UNEVEN", async () => {
  const race = teamRace([
    participant("creator", "TEAM_A"),
    participant("u2", "TEAM_A"),
    participant("u3", "TEAM_B"),
  ]);
  const ctx = makeDeps({ race });
  const startRace = buildStartRace(ctx.deps);
  await assert.rejects(
    () => startRace({ userId: "creator", raceId: "race-1" }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "TEAMS_UNEVEN");
      return true;
    }
  );
});

test("TR-301 an empty side -> 409 TEAMS_UNEVEN even with equal-looking count", async () => {
  const race = teamRace([
    participant("creator", "TEAM_A"),
    participant("u2", "TEAM_A"),
  ]);
  const ctx = makeDeps({ race });
  const startRace = buildStartRace(ctx.deps);
  await assert.rejects(
    () => startRace({ userId: "creator", raceId: "race-1" }),
    (err) => {
      assert.equal(err.code, "TEAMS_UNEVEN");
      return true;
    }
  );
});

// ── TR-302: configured size is a cap, not a minimum ─────────────────────────
test("TR-302 a 3v3-configured race starts 2v2", async () => {
  const race = teamRace([
    participant("creator", "TEAM_A"),
    participant("u2", "TEAM_A"),
    participant("u3", "TEAM_B"),
    participant("u4", "TEAM_B"),
  ]);
  const ctx = makeDeps({ race });
  const startRace = buildStartRace(ctx.deps);
  await startRace({ userId: "creator", raceId: "race-1" });
  assert.equal(ctx.state.flipped.status, "ACTIVE");
});

test("TR-302 1v1 team race (2 accepted) starts", async () => {
  const race = teamRace(
    [participant("creator", "TEAM_A"), participant("u2", "TEAM_B")],
    { teamSize: 1 }
  );
  const ctx = makeDeps({ race });
  const startRace = buildStartRace(ctx.deps);
  await startRace({ userId: "creator", raceId: "race-1" });
  assert.equal(ctx.state.flipped.status, "ACTIVE");
});

// ── TR-303: INVITED rows don't count toward team sizes ──────────────────────
test("TR-303 INVITED participants don't count toward evenness", async () => {
  const race = teamRace([
    participant("creator", "TEAM_A"),
    participant("u2", "TEAM_B"),
    participant("u3", "TEAM_A", "INVITED"),
    participant("u4", null, "INVITED"),
  ]);
  const ctx = makeDeps({ race });
  const startRace = buildStartRace(ctx.deps);
  await startRace({ userId: "creator", raceId: "race-1" });
  assert.equal(ctx.state.flipped.status, "ACTIVE");
});

// individual races: unchanged behavior
test("individual race start ignores team gates", async () => {
  const race = teamRace(
    [participant("creator", null), participant("u2", null)],
    { isTeamRace: false, teamSize: null }
  );
  const ctx = makeDeps({ race });
  const startRace = buildStartRace(ctx.deps);
  await startRace({ userId: "creator", raceId: "race-1" });
  assert.equal(ctx.state.flipped.status, "ACTIVE");
});
