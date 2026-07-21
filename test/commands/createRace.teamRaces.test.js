const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCreateRace,
  RaceCreationError,
} = require("../../src/modules/races/commands/createRace");

function makeDeps(overrides = {}) {
  const events = [];
  let createdParticipant = null;
  const participants = [];
  const awards = [];
  let createdRace = null;

  return {
    events,
    awards,
    participants,
    get createdRace() {
      return createdRace;
    },
    get createdParticipant() {
      return createdParticipant;
    },
    deps: {
      Race: {
        async create(payload) {
          createdRace = payload;
          return { id: "race-1", ...payload };
        },
        async findById(id) {
          return { id, creatorId: "user-1", name: "Test", participants: [] };
        },
        ...overrides.Race,
      },
      RaceParticipant: {
        async create(payload) {
          createdParticipant = payload;
          participants.push(payload);
          return { id: `rp-${participants.length}`, ...payload };
        },
        ...overrides.RaceParticipant,
      },
      User: {
        async findById(id) {
          return { id, coins: 500 };
        },
        ...overrides.User,
      },
      awardCoins: async (payload) => {
        awards.push(payload);
        return { awarded: true, coins: 0 };
      },
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
      // Kill switch defaults ON unless overridden.
      appSettings: {
        async getFlag(key) {
          if (key === "teamRacesEnabled") return overrides.teamRacesEnabled ?? true;
          return undefined;
        },
      },
      // Deterministic name pair for assertions.
      generateTeamNamePair:
        overrides.generateTeamNamePair ||
        (() => ["Swift Capys", "Turbo Beavers"]),
    },
  };
}

const teamClient = ["team_races"];

// ── TR-902 / TR-903 / TR-904: target-steps sanitization ─────────────────────
// Every race is time-based now; nothing completes on reaching a step target.
test("TR-902 createRace forces timeBased=true on every new race", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);
  await createRace({ userId: "user-1", name: "FFA Race" });
  assert.equal(ctx.createdRace.timeBased, true);
});

test("TR-401 team races ARE created time-based (they settle only at endsAt)", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);
  await createRace({
    userId: "user-1",
    name: "Team Battle",
    isTeamRace: true,
    teamSize: 2,
    clientFeatures: teamClient,
  });
  assert.equal(ctx.createdRace.timeBased, true);
});

test("TR-903/904 old-client payload with targetSteps succeeds and yields a time-based race", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);
  await createRace({ userId: "user-1", name: "Legacy", targetSteps: 12000 });
  // TR-903: targetSteps is accepted and preserved for legacy UI display...
  assert.equal(ctx.createdRace.targetSteps, 12000);
  // ...but TR-904: the race is time-based and never finishes on that target.
  assert.equal(ctx.createdRace.timeBased, true);
});

// ── TR-101: team-race creation stores fields ────────────────────────────────
test("TR-101 creating a 2v2 stores isTeamRace, teamSize, maxParticipants=2*size", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);
  await createRace({
    userId: "user-1",
    name: "Team Battle",
    isTeamRace: true,
    teamSize: 2,
    clientFeatures: teamClient,
  });
  assert.equal(ctx.createdRace.isTeamRace, true);
  assert.equal(ctx.createdRace.teamSize, 2);
  assert.equal(ctx.createdRace.maxParticipants, 4);
});

// ── TR-102: payoutPreset ignored, stored WINNER_TAKES_ALL ───────────────────
test("TR-102 team race stores WINNER_TAKES_ALL regardless of sent payoutPreset", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);
  await createRace({
    userId: "user-1",
    name: "Team Battle",
    isTeamRace: true,
    teamSize: 3,
    payoutPreset: "TOP3_70_20_10",
    clientFeatures: teamClient,
  });
  assert.equal(ctx.createdRace.payoutPreset, "WINNER_TAKES_ALL");
});

// ── TR-103: two distinct generated names ────────────────────────────────────
test("TR-103 team race auto-generates two distinct team names", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);
  await createRace({
    userId: "user-1",
    name: "Team Battle",
    isTeamRace: true,
    teamSize: 1,
    clientFeatures: teamClient,
  });
  assert.equal(ctx.createdRace.teamAName, "Swift Capys");
  assert.equal(ctx.createdRace.teamBName, "Turbo Beavers");
});

test("TR-103 creator can override a team name (trimmed, <=24)", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);
  await createRace({
    userId: "user-1",
    name: "Team Battle",
    isTeamRace: true,
    teamSize: 1,
    teamAName: "  Red Rockets  ",
    clientFeatures: teamClient,
  });
  assert.equal(ctx.createdRace.teamAName, "Red Rockets");
  assert.equal(ctx.createdRace.teamBName, "Turbo Beavers");
});

test("TR-103 override with empty name is rejected 400", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);
  await assert.rejects(
    () =>
      createRace({
        userId: "user-1",
        name: "Team Battle",
        isTeamRace: true,
        teamSize: 1,
        teamAName: "   ",
        clientFeatures: teamClient,
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("TR-103 override longer than 24 chars is rejected 400", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);
  await assert.rejects(
    () =>
      createRace({
        userId: "user-1",
        name: "Team Battle",
        isTeamRace: true,
        teamSize: 1,
        teamAName: "This Team Name Is Way Too Long To Fit",
        clientFeatures: teamClient,
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

// TR-103: creator-supplied team names run through the SAME reject-on-write
// profanity filter as race names — team names are surfaced on the lobby board,
// H2H banner, list cards and every team push, so nothing profane may be stored.
test("TR-103 profane teamAName override is rejected 400 naming Team A", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);
  await assert.rejects(
    () =>
      createRace({
        userId: "user-1",
        name: "Team Battle",
        isTeamRace: true,
        teamSize: 2,
        teamAName: "Shitty Capys",
        clientFeatures: teamClient,
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /Team A name/);
      assert.match(err.message, /inappropriate/i);
      return true;
    }
  );
  assert.equal(ctx.createdRace, null, "no race row is created");
});

test("TR-103 profane teamBName override is rejected 400 naming Team B", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);
  await assert.rejects(
    () =>
      createRace({
        userId: "user-1",
        name: "Team Battle",
        isTeamRace: true,
        teamSize: 2,
        teamBName: "fucking legends",
        clientFeatures: teamClient,
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /Team B name/);
      assert.match(err.message, /inappropriate/i);
      return true;
    }
  );
});

// The profanity check and the identical-names check are INDEPENDENT: a profane
// name is rejected even when the two names are perfectly distinct.
test("TR-103 a profane name is rejected even when both names differ", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);
  await assert.rejects(
    () =>
      createRace({
        userId: "user-1",
        name: "Team Battle",
        isTeamRace: true,
        teamSize: 2,
        teamAName: "Team Ass",
        teamBName: "Turbo Beavers",
        clientFeatures: teamClient,
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /inappropriate/i);
      assert.notEqual(err.code, "TEAM_NAMES_IDENTICAL");
      return true;
    }
  );
});

// Guard against an over-eager filter: legitimate names containing an embedded
// substring (the Scunthorpe problem) must still be accepted.
test("TR-103 a clean name with an embedded substring is NOT false-positived", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);
  await createRace({
    userId: "user-1",
    name: "Team Battle",
    isTeamRace: true,
    teamSize: 2,
    teamAName: "Scunthorpe United",
    clientFeatures: teamClient,
  });
  assert.equal(ctx.createdRace.teamAName, "Scunthorpe United");
});

test("TR-103 identical team names (case-insensitive) rejected TEAM_NAMES_IDENTICAL", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);
  await assert.rejects(
    () =>
      createRace({
        userId: "user-1",
        name: "Team Battle",
        isTeamRace: true,
        teamSize: 1,
        teamAName: "Red Rockets",
        teamBName: "RED ROCKETS",
        clientFeatures: teamClient,
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "TEAM_NAMES_IDENTICAL");
      return true;
    }
  );
});

// ── TR-104: creator picks side, default TEAM_A ──────────────────────────────
test("TR-104 creator joins as TEAM_A by default", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);
  await createRace({
    userId: "user-1",
    name: "Team Battle",
    isTeamRace: true,
    teamSize: 2,
    clientFeatures: teamClient,
  });
  assert.equal(ctx.createdParticipant.team, "TEAM_A");
});

test("TR-104 creator can pick TEAM_B", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);
  await createRace({
    userId: "user-1",
    name: "Team Battle",
    isTeamRace: true,
    teamSize: 2,
    team: "TEAM_B",
    clientFeatures: teamClient,
  });
  assert.equal(ctx.createdParticipant.team, "TEAM_B");
});

// ── TR-106: validation ──────────────────────────────────────────────────────
test("TR-106 teamSize outside 1-5 rejected 400", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);
  for (const bad of [0, 6, -1, 2.5]) {
    await assert.rejects(
      () =>
        createRace({
          userId: "user-1",
          name: "Team Battle",
          isTeamRace: true,
          teamSize: bad,
          clientFeatures: teamClient,
        }),
      (err) => {
        assert.equal(err.statusCode, 400);
        return true;
      },
      `teamSize ${bad} should reject`
    );
  }
});

test("TR-106 team race from client without team_races token -> 400 UPDATE_REQUIRED", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);
  await assert.rejects(
    () =>
      createRace({
        userId: "user-1",
        name: "Team Battle",
        isTeamRace: true,
        teamSize: 2,
        clientFeatures: [], // old client
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "UPDATE_REQUIRED");
      return true;
    }
  );
});

// ── TR-107: kill switch ─────────────────────────────────────────────────────
test("TR-107 team race creation rejected 403 FEATURE_DISABLED when kill switch off", async () => {
  const ctx = makeDeps({ teamRacesEnabled: false });
  const createRace = buildCreateRace(ctx.deps);
  await assert.rejects(
    () =>
      createRace({
        userId: "user-1",
        name: "Team Battle",
        isTeamRace: true,
        teamSize: 2,
        clientFeatures: teamClient,
      }),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, "FEATURE_DISABLED");
      return true;
    }
  );
});

test("TR-107 kill switch off does NOT block individual-race creation", async () => {
  const ctx = makeDeps({ teamRacesEnabled: false });
  const createRace = buildCreateRace(ctx.deps);
  await createRace({ userId: "user-1", name: "FFA" });
  assert.equal(ctx.createdRace.isTeamRace, false);
});
