const assert = require("node:assert/strict");
const test = require("node:test");

const { buildJoinRaceCore } = require("../../src/modules/races/commands/joinRaceCore");
const {
  buildRespondToRaceInvite,
} = require("../../src/modules/races/commands/respondToRaceInvite");
const { buildSwitchRaceTeam } = require("../../src/modules/races/commands/switchRaceTeam");
const { buildLeaveRace } = require("../../src/modules/races/commands/leaveRace");

const teamClient = new Set(["team_races"]);

function makeTeamRace(overrides = {}) {
  return {
    id: "race-1",
    creatorId: "creator",
    name: "Team Battle",
    status: "PENDING",
    isTeamRace: true,
    teamSize: 2,
    teamAName: "Swift Capys",
    teamBName: "Turbo Beavers",
    buyInAmount: 0,
    maxParticipants: 4,
    powerupsEnabled: false,
    participants: [],
    ...overrides,
  };
}

function participant(userId, team, status = "ACCEPTED", extra = {}) {
  return {
    id: `rp-${userId}`,
    userId,
    raceId: "race-1",
    status,
    team,
    buyInAmount: 0,
    buyInStatus: "NONE",
    ...extra,
  };
}

function makeJoinDeps({ existing = null } = {}) {
  const created = [];
  return {
    created,
    deps: {
      RaceParticipant: {
        async findByRaceAndUser() {
          return existing;
        },
        async create(payload) {
          created.push(payload);
          return { id: "rp-new", ...payload };
        },
        async countAccepted(raceId, race) {
          return 0;
        },
      },
      User: {
        async findById(id) {
          return { id, coins: 500 };
        },
      },
      awardCoins: async () => ({}),
      eventBus: { emit() {} },
      prisma: {},
      hashAppleSub: () => null,
    },
  };
}

// ── Issue 3a: a team-less join auto-assigns instead of erroring ─────────────
test("3a team-less public join auto-assigns to the smaller side; both full -> TEAM_FULL", async () => {
  // Creator already on TEAM_A -> smaller side is TEAM_B.
  const ctx1 = makeJoinDeps();
  const join1 = buildJoinRaceCore(ctx1.deps);
  const p1 = await join1({
    race: makeTeamRace({ participants: [participant("creator", "TEAM_A")] }),
    userId: "user-9",
    clientFeatures: teamClient,
  });
  assert.equal(p1.team, "TEAM_B");
  assert.equal(ctx1.created[0].team, "TEAM_B");

  // Empty lobby -> tie -> TEAM_A.
  const ctx2 = makeJoinDeps();
  const join2 = buildJoinRaceCore(ctx2.deps);
  const p2 = await join2({
    race: makeTeamRace(),
    userId: "user-9",
    clientFeatures: teamClient,
  });
  assert.equal(p2.team, "TEAM_A");

  // Both sides full -> 409 TEAM_FULL.
  const ctx3 = makeJoinDeps();
  const join3 = buildJoinRaceCore(ctx3.deps);
  await assert.rejects(
    () =>
      join3({
        race: makeTeamRace({
          teamSize: 1,
          participants: [
            participant("creator", "TEAM_A"),
            participant("u2", "TEAM_B"),
          ],
        }),
        userId: "user-9",
        clientFeatures: teamClient,
      }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "TEAM_FULL");
      return true;
    }
  );
});

test("TR-201 public join with a side creates participant on that side", async () => {
  const ctx = makeJoinDeps();
  const joinRaceCore = buildJoinRaceCore(ctx.deps);
  const p = await joinRaceCore({
    race: makeTeamRace(),
    userId: "user-9",
    team: "TEAM_B",
    clientFeatures: teamClient,
  });
  assert.equal(p.team, "TEAM_B");
  assert.equal(ctx.created[0].team, "TEAM_B");
});

test("TR-201 individual race join ignores team param (stays null)", async () => {
  const ctx = makeJoinDeps();
  const joinRaceCore = buildJoinRaceCore(ctx.deps);
  await joinRaceCore({
    race: makeTeamRace({ isTeamRace: false, teamSize: null }),
    userId: "user-9",
    team: "TEAM_B",
    clientFeatures: teamClient,
  });
  assert.equal(ctx.created[0].team ?? null, null);
});

// ── TR-202: full side rejects with TEAM_FULL, other side open ───────────────
test("TR-202 join on a full side -> 409 TEAM_FULL", async () => {
  const ctx = makeJoinDeps();
  const joinRaceCore = buildJoinRaceCore(ctx.deps);
  const race = makeTeamRace({
    participants: [participant("u1", "TEAM_A"), participant("u2", "TEAM_A")],
  });
  await assert.rejects(
    () =>
      joinRaceCore({
        race,
        userId: "user-9",
        team: "TEAM_A",
        clientFeatures: teamClient,
      }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "TEAM_FULL");
      return true;
    }
  );
});

test("TR-202 the other side is still joinable when one side is full", async () => {
  const ctx = makeJoinDeps();
  const joinRaceCore = buildJoinRaceCore(ctx.deps);
  const race = makeTeamRace({
    participants: [participant("u1", "TEAM_A"), participant("u2", "TEAM_A")],
  });
  const p = await joinRaceCore({
    race,
    userId: "user-9",
    team: "TEAM_B",
    clientFeatures: teamClient,
  });
  assert.equal(p.team, "TEAM_B");
});

test("TR-202 INVITED rows do not count toward a side's cap", async () => {
  const ctx = makeJoinDeps();
  const joinRaceCore = buildJoinRaceCore(ctx.deps);
  const race = makeTeamRace({
    participants: [
      participant("u1", "TEAM_A"),
      participant("u2", "TEAM_A", "INVITED"),
    ],
  });
  const p = await joinRaceCore({
    race,
    userId: "user-9",
    team: "TEAM_A",
    clientFeatures: teamClient,
  });
  assert.equal(p.team, "TEAM_A");
});

// ── TR-204: no joining an ACTIVE team race ──────────────────────────────────
test("TR-204 join on ACTIVE team race -> 409 RACE_ALREADY_STARTED", async () => {
  const ctx = makeJoinDeps();
  const joinRaceCore = buildJoinRaceCore(ctx.deps);
  await assert.rejects(
    () =>
      joinRaceCore({
        race: makeTeamRace({ status: "ACTIVE" }),
        userId: "user-9",
        team: "TEAM_A",
        clientFeatures: teamClient,
      }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "RACE_ALREADY_STARTED");
      return true;
    }
  );
});

// ── TR-703: old client cannot join a team race ──────────────────────────────
test("TR-703 join on a team race without the token -> 400 UPDATE_REQUIRED", async () => {
  const ctx = makeJoinDeps();
  const joinRaceCore = buildJoinRaceCore(ctx.deps);
  await assert.rejects(
    () =>
      joinRaceCore({
        race: makeTeamRace(),
        userId: "user-9",
        team: "TEAM_A",
        clientFeatures: new Set(),
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "UPDATE_REQUIRED");
      return true;
    }
  );
});

// ── Invite accept (TR-201/202/204/207) ──────────────────────────────────────
function makeRespondDeps({ race, invited }) {
  const state = { updated: null, potUpdate: null };
  return {
    state,
    deps: {
      Race: {
        async findById() {
          return race;
        },
        async update(id, fields) {
          state.potUpdate = fields;
          return race;
        },
      },
      RaceParticipant: {
        async findByRaceAndUser() {
          return invited;
        },
        async update(id, fields) {
          state.updated = fields;
          return { ...invited, ...fields };
        },
      },
      Steps: {
        async findByUserIdAndDate() {
          return null;
        },
      },
      User: {
        async findById(id) {
          return { id, coins: 500 };
        },
      },
      awardCoins: async () => ({}),
      eventBus: { emit() {} },
    },
  };
}

test("TR-201/3a invite accept stores an explicit side; team-less accept auto-assigns", async () => {
  const race = makeTeamRace({
    participants: [participant("creator", "TEAM_A")],
  });
  const invited = participant("user-9", null, "INVITED");

  // An explicit side is honored and stored (TR-201, unchanged).
  const ctx = makeRespondDeps({ race, invited });
  const respond = buildRespondToRaceInvite(ctx.deps);
  await respond({
    userId: "user-9",
    raceId: "race-1",
    accept: true,
    team: "TEAM_B",
    clientFeatures: teamClient,
  });
  assert.equal(ctx.state.updated.team, "TEAM_B");
  assert.equal(ctx.state.updated.status, "ACCEPTED");

  // Issue 3a: a team-less accept auto-assigns to the smaller side (creator on
  // TEAM_A -> the invitee lands on TEAM_B) instead of erroring.
  const ctx2 = makeRespondDeps({ race, invited });
  const respond2 = buildRespondToRaceInvite(ctx2.deps);
  await respond2({
    userId: "user-9",
    raceId: "race-1",
    accept: true,
    clientFeatures: teamClient,
  });
  assert.equal(ctx2.state.updated.team, "TEAM_B");
  assert.equal(ctx2.state.updated.status, "ACCEPTED");
});

test("TR-207 accepting when the chosen side is at cap -> 409 TEAM_FULL and stays INVITED", async () => {
  const race = makeTeamRace({
    participants: [
      participant("creator", "TEAM_A"),
      participant("u2", "TEAM_A"),
    ],
  });
  const invited = participant("user-9", null, "INVITED");
  const ctx = makeRespondDeps({ race, invited });
  const respond = buildRespondToRaceInvite(ctx.deps);

  await assert.rejects(
    () =>
      respond({
        userId: "user-9",
        raceId: "race-1",
        accept: true,
        team: "TEAM_A",
        clientFeatures: teamClient,
      }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "TEAM_FULL");
      return true;
    }
  );
  assert.equal(ctx.state.updated, null, "participant row must not be updated");
});

test("TR-204 accepting an invite on an ACTIVE team race -> 409 RACE_ALREADY_STARTED", async () => {
  const race = makeTeamRace({
    status: "ACTIVE",
    participants: [participant("creator", "TEAM_A")],
  });
  const invited = participant("user-9", null, "INVITED");
  const ctx = makeRespondDeps({ race, invited });
  const respond = buildRespondToRaceInvite(ctx.deps);

  await assert.rejects(
    () =>
      respond({
        userId: "user-9",
        raceId: "race-1",
        accept: true,
        team: "TEAM_A",
        clientFeatures: teamClient,
      }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "RACE_ALREADY_STARTED");
      return true;
    }
  );
});

test("TR-703 accepting a team-race invite without the token -> 400 UPDATE_REQUIRED", async () => {
  const race = makeTeamRace({
    participants: [participant("creator", "TEAM_A")],
  });
  const invited = participant("user-9", null, "INVITED");
  const ctx = makeRespondDeps({ race, invited });
  const respond = buildRespondToRaceInvite(ctx.deps);

  await assert.rejects(
    () =>
      respond({
        userId: "user-9",
        raceId: "race-1",
        accept: true,
        team: "TEAM_A",
        clientFeatures: new Set(),
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "UPDATE_REQUIRED");
      return true;
    }
  );
});

test("declining a team-race invite needs no team and no token", async () => {
  const race = makeTeamRace({
    participants: [participant("creator", "TEAM_A")],
  });
  const invited = participant("user-9", null, "INVITED");
  const ctx = makeRespondDeps({ race, invited });
  const respond = buildRespondToRaceInvite(ctx.deps);

  await respond({ userId: "user-9", raceId: "race-1", accept: false });
  assert.equal(ctx.state.updated.status, "DECLINED");
});

// ── TR-203: switch sides while PENDING ──────────────────────────────────────
function makeSwitchDeps({ race, me }) {
  const state = { updated: null };
  return {
    state,
    deps: {
      Race: {
        async findById() {
          return race;
        },
      },
      RaceParticipant: {
        async findByRaceAndUser() {
          return me;
        },
        async update(id, fields) {
          state.updated = fields;
          return { ...me, ...fields };
        },
      },
      eventBus: { emit() {} },
    },
  };
}

test("TR-203 switching sides while PENDING succeeds", async () => {
  const me = participant("user-9", "TEAM_A");
  const race = makeTeamRace({
    participants: [participant("creator", "TEAM_A"), me],
  });
  const ctx = makeSwitchDeps({ race, me });
  const switchRaceTeam = buildSwitchRaceTeam(ctx.deps);
  const updated = await switchRaceTeam({
    userId: "user-9",
    raceId: "race-1",
    team: "TEAM_B",
  });
  assert.equal(updated.team, "TEAM_B");
});

test("TR-203 switching to a full side -> 409 TEAM_FULL", async () => {
  const me = participant("user-9", "TEAM_A");
  const race = makeTeamRace({
    participants: [
      participant("creator", "TEAM_B"),
      participant("u2", "TEAM_B"),
      me,
    ],
  });
  const ctx = makeSwitchDeps({ race, me });
  const switchRaceTeam = buildSwitchRaceTeam(ctx.deps);
  await assert.rejects(
    () => switchRaceTeam({ userId: "user-9", raceId: "race-1", team: "TEAM_B" }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "TEAM_FULL");
      return true;
    }
  );
});

test("TR-203 switching sides on an ACTIVE race -> 409 RACE_ALREADY_STARTED", async () => {
  const me = participant("user-9", "TEAM_A");
  const race = makeTeamRace({
    status: "ACTIVE",
    participants: [participant("creator", "TEAM_B"), me],
  });
  const ctx = makeSwitchDeps({ race, me });
  const switchRaceTeam = buildSwitchRaceTeam(ctx.deps);
  await assert.rejects(
    () => switchRaceTeam({ userId: "user-9", raceId: "race-1", team: "TEAM_B" }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "RACE_ALREADY_STARTED");
      return true;
    }
  );
});

// ── TR-205 / TR-208: leave while PENDING ────────────────────────────────────
function makeLeaveDeps({ race, me }) {
  const state = { deleted: null, refunds: [] };
  return {
    state,
    deps: {
      Race: {
        async findById() {
          return race;
        },
      },
      RaceParticipant: {
        async findByRaceAndUser() {
          return me;
        },
        async delete(id) {
          state.deleted = id;
        },
      },
      awardCoins: async (payload) => {
        state.refunds.push(payload);
        return {};
      },
      eventBus: { emit() {} },
    },
  };
}

test("TR-205 leaving a PENDING team race deletes the row and refunds a HELD buy-in", async () => {
  const me = participant("user-9", "TEAM_A", "ACCEPTED", {
    buyInAmount: 30,
    buyInStatus: "HELD",
  });
  const race = makeTeamRace({
    buyInAmount: 30,
    participants: [participant("creator", "TEAM_A"), me],
  });
  const ctx = makeLeaveDeps({ race, me });
  const leaveRace = buildLeaveRace(ctx.deps);
  await leaveRace({ userId: "user-9", raceId: "race-1" });
  assert.equal(ctx.state.deleted, me.id);
  assert.equal(ctx.state.refunds.length, 1);
  assert.equal(ctx.state.refunds[0].amount, 30);
});

test("TR-208 creator cannot leave their own lobby", async () => {
  const me = participant("creator", "TEAM_A");
  const race = makeTeamRace({ participants: [me] });
  const ctx = makeLeaveDeps({ race, me });
  const leaveRace = buildLeaveRace(ctx.deps);
  await assert.rejects(
    () => leaveRace({ userId: "creator", raceId: "race-1" }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("TR-205 leaving an ACTIVE team race -> 409 RACE_ALREADY_STARTED", async () => {
  const me = participant("user-9", "TEAM_A");
  const race = makeTeamRace({
    status: "ACTIVE",
    participants: [participant("creator", "TEAM_B"), me],
  });
  const ctx = makeLeaveDeps({ race, me });
  const leaveRace = buildLeaveRace(ctx.deps);
  await assert.rejects(
    () => leaveRace({ userId: "user-9", raceId: "race-1" }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "RACE_ALREADY_STARTED");
      return true;
    }
  );
});
