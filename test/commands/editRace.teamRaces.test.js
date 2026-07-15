const assert = require("node:assert/strict");
const test = require("node:test");

const { buildEditRace } = require("../../src/commands/editRace");

// Minimal fake models around a mutable race row + participant list.
function makeDeps({ race, participants = [] } = {}) {
  const state = {
    race: {
      id: "race-1",
      creatorId: "user-1",
      status: "PENDING",
      name: "Team Battle",
      maxDurationDays: 7,
      powerupsEnabled: false,
      powerupStepInterval: null,
      isPublic: false,
      maxParticipants: 4,
      buyInAmount: 0,
      payoutPreset: "WINNER_TAKES_ALL",
      isTeamRace: true,
      teamSize: 2,
      teamAName: "Swift Capys",
      teamBName: "Turbo Beavers",
      participants,
      ...race,
    },
    updates: null,
  };

  const deps = {
    Race: {
      async findById() {
        return state.race;
      },
      async update(id, fields) {
        state.updates = fields;
        state.race = { ...state.race, ...fields };
        return state.race;
      },
    },
    RaceParticipant: {
      async countAccepted() {
        return state.race.participants.filter((p) => p.status === "ACCEPTED")
          .length;
      },
      async findChargedByRace() {
        return [];
      },
      async findAcceptedByRace() {
        return state.race.participants.filter((p) => p.status === "ACCEPTED");
      },
    },
    eventBus: { emit() {} },
  };

  return { state, deps };
}

function member(team, userId) {
  return { id: `rp-${userId}`, userId, status: "ACCEPTED", team };
}

// ── TR-105: team names editable while PENDING ───────────────────────────────
test("TR-105 PATCH can rename team names while PENDING", async () => {
  const { state, deps } = makeDeps();
  const editRace = buildEditRace(deps);
  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { teamAName: "Red Rockets", teamBName: "Blue Bandits" },
  });
  assert.equal(state.race.teamAName, "Red Rockets");
  assert.equal(state.race.teamBName, "Blue Bandits");
});

test("TR-105 PATCH renaming to empty fails 400", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);
  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { teamAName: "   " },
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("TR-105 PATCH renaming one side equal to the other -> TEAM_NAMES_IDENTICAL", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);
  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { teamAName: "turbo beavers" },
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "TEAM_NAMES_IDENTICAL");
      return true;
    }
  );
});

// TR-103: renames go through the same reject-on-write profanity filter as
// creation — a PENDING rename must not become a back door for a profane name.
test("TR-103 PATCH with a profane teamAName is rejected 400 naming Team A", async () => {
  const { state, deps } = makeDeps();
  const editRace = buildEditRace(deps);
  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { teamAName: "Shitty Capys" },
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /Team A name/);
      assert.match(err.message, /inappropriate/i);
      return true;
    }
  );
  assert.equal(state.updates, null, "nothing is written on rejection");
  assert.equal(state.race.teamAName, "Swift Capys", "stored name untouched");
});

test("TR-103 PATCH with a profane teamBName is rejected 400 naming Team B", async () => {
  const { state, deps } = makeDeps();
  const editRace = buildEditRace(deps);
  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { teamBName: "fucking legends" },
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /Team B name/);
      return true;
    }
  );
  assert.equal(state.race.teamBName, "Turbo Beavers", "stored name untouched");
});

test("TR-103 PATCH profanity check is independent of the identical-names check", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);
  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { teamAName: "Team Ass", teamBName: "Bold Bison" },
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /inappropriate/i);
      assert.notEqual(err.code, "TEAM_NAMES_IDENTICAL");
      return true;
    }
  );
});

// A PATCH that omits a team name must not re-validate or clobber the stored
// one — only supplied fields are touched (hasField gating).
test("TR-105 PATCH omitting a team name leaves the stored name untouched", async () => {
  const { state, deps } = makeDeps();
  const editRace = buildEditRace(deps);
  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { teamAName: "Red Rockets" }, // teamBName omitted
  });
  assert.equal(state.race.teamAName, "Red Rockets");
  assert.equal(state.race.teamBName, "Turbo Beavers", "untouched");
  assert.ok(
    !("teamBName" in state.updates),
    "omitted name is not written back"
  );
});

// Defensive: even if a legacy/imported row somehow holds a profane stored name,
// renaming the OTHER side must not be blocked by it (only supplied names are
// validated). Pins that the filter runs on input, not on stored state.
test("TR-105 a profane STORED name does not block renaming the other side", async () => {
  const { state, deps } = makeDeps({ race: { teamBName: "Shitty Beavers" } });
  const editRace = buildEditRace(deps);
  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { teamAName: "Red Rockets" },
  });
  assert.equal(state.race.teamAName, "Red Rockets");
});

// ── TR-105: team size edits ─────────────────────────────────────────────────
test("TR-105 growing teamSize updates maxParticipants to 2x", async () => {
  const { state, deps } = makeDeps();
  const editRace = buildEditRace(deps);
  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { teamSize: 4 },
  });
  assert.equal(state.race.teamSize, 4);
  assert.equal(state.race.maxParticipants, 8);
});

test("TR-105 shrinking teamSize below a side's member count -> TEAM_SIZE_TOO_SMALL", async () => {
  const { deps } = makeDeps({
    participants: [
      member("TEAM_A", "user-1"),
      member("TEAM_A", "user-2"),
      member("TEAM_B", "user-3"),
    ],
  });
  const editRace = buildEditRace(deps);
  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { teamSize: 1 },
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "TEAM_SIZE_TOO_SMALL");
      return true;
    }
  );
});

test("TR-105 shrinking teamSize to exactly the max side count is allowed", async () => {
  const { state, deps } = makeDeps({
    race: { teamSize: 4, maxParticipants: 8 },
    participants: [
      member("TEAM_A", "user-1"),
      member("TEAM_A", "user-2"),
      member("TEAM_B", "user-3"),
    ],
  });
  const editRace = buildEditRace(deps);
  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { teamSize: 2 },
  });
  assert.equal(state.race.teamSize, 2);
  assert.equal(state.race.maxParticipants, 4);
});

test("TR-106 PATCH teamSize outside 1-5 fails 400", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);
  await assert.rejects(
    () =>
      editRace({ userId: "user-1", raceId: "race-1", updates: { teamSize: 6 } }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

// ── TR-105: isTeamRace immutable ────────────────────────────────────────────
test("TR-105 PATCH cannot flip isTeamRace off -> IMMUTABLE_FIELD", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);
  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { isTeamRace: false },
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "IMMUTABLE_FIELD");
      return true;
    }
  );
});

test("TR-105 PATCH cannot convert an individual race to a team race -> IMMUTABLE_FIELD", async () => {
  const { deps } = makeDeps({
    race: { isTeamRace: false, teamSize: null, teamAName: null, teamBName: null },
  });
  const editRace = buildEditRace(deps);
  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { isTeamRace: true, teamSize: 2 },
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "IMMUTABLE_FIELD");
      return true;
    }
  );
});

test("TR-105 PATCH sending isTeamRace equal to the stored value is a no-op, not an error", async () => {
  const { state, deps } = makeDeps();
  const editRace = buildEditRace(deps);
  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { isTeamRace: true, teamAName: "Red Rockets" },
  });
  assert.equal(state.race.teamAName, "Red Rockets");
});

// ── TR-105: team fields rejected on individual races ────────────────────────
test("TR-105 team name edits on an individual race fail 400", async () => {
  const { deps } = makeDeps({
    race: { isTeamRace: false, teamSize: null, teamAName: null, teamBName: null },
  });
  const editRace = buildEditRace(deps);
  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { teamAName: "Red Rockets" },
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});
