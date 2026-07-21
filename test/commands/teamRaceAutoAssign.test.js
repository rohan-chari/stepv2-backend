const assert = require("node:assert/strict");
const test = require("node:test");

const { buildJoinRaceCore } = require("../../src/modules/races/commands/joinRaceCore");
const {
  buildJoinPublicRace,
} = require("../../src/modules/races/commands/joinPublicRace");
const {
  buildRespondToRaceInvite,
} = require("../../src/modules/races/commands/respondToRaceInvite");

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

// ── Join core auto-assign (Issue 3a) ────────────────────────────────────────
function makeJoinDeps({ race, existing = null } = {}) {
  const created = [];
  return {
    created,
    deps: {
      Race: {
        async findById() {
          return race;
        },
      },
      RaceParticipant: {
        async findByRaceAndUser() {
          return existing;
        },
        async create(payload) {
          created.push(payload);
          return { id: "rp-new", ...payload };
        },
        async countAccepted() {
          return (race.participants || []).filter(
            (p) => p.status === "ACCEPTED"
          ).length;
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

test("3a join: team-less join assigns to the smaller side (creator on A -> B)", async () => {
  const race = makeTeamRace({ participants: [participant("creator", "TEAM_A")] });
  const ctx = makeJoinDeps({ race });
  const joinRaceCore = buildJoinRaceCore(ctx.deps);
  const p = await joinRaceCore({
    race,
    userId: "user-9",
    clientFeatures: teamClient,
  });
  assert.equal(p.team, "TEAM_B");
  assert.equal(ctx.created[0].team, "TEAM_B");
});

test("3a join: team-less join on a tie assigns TEAM_A", async () => {
  const race = makeTeamRace({
    participants: [participant("creator", "TEAM_A"), participant("u2", "TEAM_B")],
  });
  const ctx = makeJoinDeps({ race });
  const joinRaceCore = buildJoinRaceCore(ctx.deps);
  const p = await joinRaceCore({
    race,
    userId: "user-9",
    clientFeatures: teamClient,
  });
  assert.equal(p.team, "TEAM_A");
});

test("3a join: team-less join skips a full side (A full -> B)", async () => {
  const race = makeTeamRace({
    participants: [participant("c", "TEAM_A"), participant("u2", "TEAM_A")],
  });
  const ctx = makeJoinDeps({ race });
  const joinRaceCore = buildJoinRaceCore(ctx.deps);
  const p = await joinRaceCore({
    race,
    userId: "user-9",
    clientFeatures: teamClient,
  });
  assert.equal(p.team, "TEAM_B");
});

test("3a join: team-less join with both sides full -> 409 TEAM_FULL", async () => {
  const race = makeTeamRace({
    teamSize: 1,
    participants: [participant("c", "TEAM_A"), participant("u2", "TEAM_B")],
  });
  const ctx = makeJoinDeps({ race });
  const joinRaceCore = buildJoinRaceCore(ctx.deps);
  await assert.rejects(
    () => joinRaceCore({ race, userId: "user-9", clientFeatures: teamClient }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "TEAM_FULL");
      return true;
    }
  );
});

test("3a join: explicit team is still honored", async () => {
  const race = makeTeamRace({ participants: [participant("creator", "TEAM_A")] });
  const ctx = makeJoinDeps({ race });
  const joinRaceCore = buildJoinRaceCore(ctx.deps);
  const p = await joinRaceCore({
    race,
    userId: "user-9",
    team: "TEAM_A",
    clientFeatures: teamClient,
  });
  assert.equal(p.team, "TEAM_A");
});

// ── Respond auto-assign (Issue 3a) ──────────────────────────────────────────
function makeRespondDeps({ race, invited, coins = 500 }) {
  const state = { updated: null, potUpdate: null, awards: [] };
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
          return { id, coins };
        },
      },
      awardCoins: async (payload) => {
        state.awards.push(payload);
        return {};
      },
      eventBus: { emit() {} },
    },
  };
}

test("3a respond: team-less accept assigns to the smaller side (creator on A -> B)", async () => {
  const race = makeTeamRace({ participants: [participant("creator", "TEAM_A")] });
  const invited = participant("user-9", null, "INVITED");
  const ctx = makeRespondDeps({ race, invited });
  const respond = buildRespondToRaceInvite(ctx.deps);
  await respond({
    userId: "user-9",
    raceId: "race-1",
    accept: true,
    clientFeatures: teamClient,
  });
  assert.equal(ctx.state.updated.team, "TEAM_B");
  assert.equal(ctx.state.updated.status, "ACCEPTED");
});

test("3a respond: team-less accept on a tie assigns TEAM_A", async () => {
  const race = makeTeamRace({
    participants: [participant("creator", "TEAM_A"), participant("u2", "TEAM_B")],
  });
  const invited = participant("user-9", null, "INVITED");
  const ctx = makeRespondDeps({ race, invited });
  const respond = buildRespondToRaceInvite(ctx.deps);
  await respond({
    userId: "user-9",
    raceId: "race-1",
    accept: true,
    clientFeatures: teamClient,
  });
  assert.equal(ctx.state.updated.team, "TEAM_A");
});

test("3a respond: team-less accept with both sides full -> 409 TEAM_FULL, stays INVITED", async () => {
  const race = makeTeamRace({
    teamSize: 1,
    participants: [participant("c", "TEAM_A"), participant("u2", "TEAM_B")],
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
        clientFeatures: teamClient,
      }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "TEAM_FULL");
      return true;
    }
  );
  assert.equal(ctx.state.updated, null);
});

test("3a respond: explicit team is still honored", async () => {
  const race = makeTeamRace({ participants: [participant("creator", "TEAM_A")] });
  const invited = participant("user-9", null, "INVITED");
  const ctx = makeRespondDeps({ race, invited });
  const respond = buildRespondToRaceInvite(ctx.deps);
  await respond({
    userId: "user-9",
    raceId: "race-1",
    accept: true,
    team: "TEAM_A",
    clientFeatures: teamClient,
  });
  assert.equal(ctx.state.updated.team, "TEAM_A");
});

test("3a respond: team-less accept on an individual race is unaffected (no team)", async () => {
  const race = makeTeamRace({ isTeamRace: false, teamSize: null, participants: [] });
  const invited = participant("user-9", null, "INVITED");
  const ctx = makeRespondDeps({ race, invited });
  const respond = buildRespondToRaceInvite(ctx.deps);
  await respond({ userId: "user-9", raceId: "race-1", accept: true });
  assert.equal(ctx.state.updated.status, "ACCEPTED");
  assert.equal(ctx.state.updated.team, undefined);
});

// ── Stable error codes (Issue 3b) ───────────────────────────────────────────
test("3b respond: race not found -> 404 RACE_NOT_FOUND", async () => {
  const ctx = makeRespondDeps({ race: null, invited: null });
  ctx.deps.Race.findById = async () => null;
  const respond = buildRespondToRaceInvite(ctx.deps);
  await assert.rejects(
    () => respond({ userId: "u", raceId: "race-1", accept: true }),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, "RACE_NOT_FOUND");
      return true;
    }
  );
});

test("3b respond: completed race -> 400 RACE_NOT_ACCEPTING", async () => {
  const race = makeTeamRace({ isTeamRace: false, status: "COMPLETED" });
  const invited = participant("u", null, "INVITED");
  const ctx = makeRespondDeps({ race, invited });
  const respond = buildRespondToRaceInvite(ctx.deps);
  await assert.rejects(
    () => respond({ userId: "u", raceId: "race-1", accept: true }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "RACE_NOT_ACCEPTING");
      return true;
    }
  );
});

test("3b respond: not invited -> 403 NOT_INVITED", async () => {
  const race = makeTeamRace({ isTeamRace: false });
  const ctx = makeRespondDeps({ race, invited: null });
  const respond = buildRespondToRaceInvite(ctx.deps);
  await assert.rejects(
    () => respond({ userId: "stranger", raceId: "race-1", accept: true }),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, "NOT_INVITED");
      return true;
    }
  );
});

test("3b respond: already responded -> 400 ALREADY_RESPONDED", async () => {
  const race = makeTeamRace({ isTeamRace: false });
  const invited = participant("u", null, "ACCEPTED");
  const ctx = makeRespondDeps({ race, invited });
  const respond = buildRespondToRaceInvite(ctx.deps);
  await assert.rejects(
    () => respond({ userId: "u", raceId: "race-1", accept: true }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "ALREADY_RESPONDED");
      return true;
    }
  );
});

test("3b respond: paid race after someone finished -> 400 PAID_RACE_LOCKED", async () => {
  const race = makeTeamRace({
    isTeamRace: false,
    status: "ACTIVE",
    buyInAmount: 50,
    participants: [participant("other", null, "ACCEPTED", { finishedAt: new Date() })],
  });
  const invited = participant("u", null, "INVITED");
  const ctx = makeRespondDeps({ race, invited });
  const respond = buildRespondToRaceInvite(ctx.deps);
  await assert.rejects(
    () => respond({ userId: "u", raceId: "race-1", accept: true }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "PAID_RACE_LOCKED");
      return true;
    }
  );
});

test("3b respond: cannot afford buy-in -> 400 INSUFFICIENT_COINS", async () => {
  const race = makeTeamRace({ isTeamRace: false, buyInAmount: 100 });
  const invited = participant("u", null, "INVITED");
  const ctx = makeRespondDeps({ race, invited, coins: 10 });
  const respond = buildRespondToRaceInvite(ctx.deps);
  await assert.rejects(
    () => respond({ userId: "u", raceId: "race-1", accept: true }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "INSUFFICIENT_COINS");
      return true;
    }
  );
});

test("3b join core: completed race -> 400 RACE_NOT_ACCEPTING", async () => {
  const race = makeTeamRace({ isTeamRace: false, status: "COMPLETED" });
  const ctx = makeJoinDeps({ race });
  const joinRaceCore = buildJoinRaceCore(ctx.deps);
  await assert.rejects(
    () => joinRaceCore({ race, userId: "u" }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "RACE_NOT_ACCEPTING");
      return true;
    }
  );
});

test("3b join core: already in race -> 400 ALREADY_RESPONDED", async () => {
  const race = makeTeamRace({ isTeamRace: false });
  const ctx = makeJoinDeps({ race, existing: participant("u", null, "ACCEPTED") });
  const joinRaceCore = buildJoinRaceCore(ctx.deps);
  await assert.rejects(
    () => joinRaceCore({ race, userId: "u" }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "ALREADY_RESPONDED");
      return true;
    }
  );
});

test("3b join core: cannot afford buy-in -> 400 INSUFFICIENT_COINS", async () => {
  const race = makeTeamRace({ isTeamRace: false, buyInAmount: 100 });
  const ctx = makeJoinDeps({ race });
  ctx.deps.User.findById = async (id) => ({ id, coins: 5 });
  const joinRaceCore = buildJoinRaceCore(ctx.deps);
  await assert.rejects(
    () => joinRaceCore({ race, userId: "u" }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "INSUFFICIENT_COINS");
      return true;
    }
  );
});

test("3b joinPublicRace: race not found -> 404 RACE_NOT_FOUND", async () => {
  const deps = {
    Race: { async findById() { return null; } },
    withRaceJoinLock: async (_id, cb) => cb(),
  };
  const joinPublicRace = buildJoinPublicRace(deps);
  await assert.rejects(
    () => joinPublicRace({ userId: "u", raceId: "missing" }),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, "RACE_NOT_FOUND");
      return true;
    }
  );
});
