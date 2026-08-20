const assert = require("node:assert/strict");
const test = require("node:test");

const { buildInviteToRace } = require("../../src/modules/races/commands/inviteToRace");

function makeDeps({ race, users = {}, existingParticipants = [] } = {}) {
  const state = { createdRecords: null };
  return {
    state,
    deps: {
      Race: {
        async findById() {
          return race;
        },
      },
      RaceParticipant: {
        async findByRace() {
          return existingParticipants;
        },
        async createMany(records) {
          state.createdRecords = records;
          return { count: records.length };
        },
      },
      Friendship: {
        async findBetweenUsers() {
          return { status: "ACCEPTED" };
        },
      },
      User: {
        async findById(id) {
          return users[id] || { id, displayName: id, clientFeatures: [] };
        },
      },
      eventBus: { emit() {} },
    },
  };
}

function teamRace(overrides = {}) {
  return {
    id: "race-1",
    creatorId: "creator",
    name: "Team Battle",
    status: "PENDING",
    isTeamRace: true,
    teamSize: 2,
    maxParticipants: 4,
    participants: [],
    ...overrides,
  };
}

const eligibleUser = (id, name) => ({
  id,
  displayName: name,
  clientFeatures: ["team_races", "characters"],
});
const staleUser = (id, name) => ({
  id,
  displayName: name,
  clientFeatures: ["characters"],
});

// ── TR-207: over-inviting allowed on team races ─────────────────────────────
test("TR-207 inviting 6 friends to a 2v2 succeeds (over-invite allowed)", async () => {
  const users = {};
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const id = `friend-${i}`;
    users[id] = eligibleUser(id, `Friend${i}`);
    ids.push(id);
  }
  const ctx = makeDeps({
    race: teamRace(),
    users,
    existingParticipants: [{ userId: "creator", status: "ACCEPTED" }],
  });
  const inviteToRace = buildInviteToRace(ctx.deps);
  await inviteToRace({ userId: "creator", raceId: "race-1", inviteeIds: ids });
  assert.equal(ctx.state.createdRecords.length, 6);
});

test("individual races keep the maxParticipants invite cap", async () => {
  const users = {};
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const id = `friend-${i}`;
    users[id] = eligibleUser(id, `Friend${i}`);
    ids.push(id);
  }
  const ctx = makeDeps({
    race: teamRace({ isTeamRace: false, teamSize: null, maxParticipants: 4 }),
    users,
    existingParticipants: [{ userId: "creator", status: "ACCEPTED" }],
  });
  const inviteToRace = buildInviteToRace(ctx.deps);
  await assert.rejects(
    () =>
      inviteToRace({ userId: "creator", raceId: "race-1", inviteeIds: ids }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

// ── TR-707: invite-time eligibility block ───────────────────────────────────
test("TR-707 inviting an old-client friend to a team race -> 400 INVITEE_NEEDS_UPDATE naming the friend", async () => {
  const ctx = makeDeps({
    race: teamRace(),
    users: {
      "friend-1": eligibleUser("friend-1", "Blake"),
      "friend-2": staleUser("friend-2", "Alex"),
    },
    existingParticipants: [{ userId: "creator", status: "ACCEPTED" }],
  });
  const inviteToRace = buildInviteToRace(ctx.deps);
  await assert.rejects(
    () =>
      inviteToRace({
        userId: "creator",
        raceId: "race-1",
        inviteeIds: ["friend-1", "friend-2"],
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "INVITEE_NEEDS_UPDATE");
      assert.match(err.message, /Alex/);
      return true;
    }
  );
});

test("TR-706 a friend with NO recorded client features is ineligible (pessimistic default)", async () => {
  const ctx = makeDeps({
    race: teamRace(),
    users: {
      "friend-1": { id: "friend-1", displayName: "Casey", clientFeatures: [] },
    },
    existingParticipants: [{ userId: "creator", status: "ACCEPTED" }],
  });
  const inviteToRace = buildInviteToRace(ctx.deps);
  await assert.rejects(
    () =>
      inviteToRace({
        userId: "creator",
        raceId: "race-1",
        inviteeIds: ["friend-1"],
      }),
    (err) => {
      assert.equal(err.code, "INVITEE_NEEDS_UPDATE");
      return true;
    }
  );
});

test("TR-707 individual-race invites are unaffected by invitee eligibility", async () => {
  const ctx = makeDeps({
    race: teamRace({ isTeamRace: false, teamSize: null, maxParticipants: 10 }),
    users: {
      "friend-2": staleUser("friend-2", "Alex"),
    },
    existingParticipants: [{ userId: "creator", status: "ACCEPTED" }],
  });
  const inviteToRace = buildInviteToRace(ctx.deps);
  await inviteToRace({
    userId: "creator",
    raceId: "race-1",
    inviteeIds: ["friend-2"],
  });
  assert.equal(ctx.state.createdRecords.length, 1);
});

test("TR-707 eligible invitees to a team race are invited normally", async () => {
  const ctx = makeDeps({
    race: teamRace(),
    users: { "friend-1": eligibleUser("friend-1", "Blake") },
    existingParticipants: [{ userId: "creator", status: "ACCEPTED" }],
  });
  const inviteToRace = buildInviteToRace(ctx.deps);
  await inviteToRace({
    userId: "creator",
    raceId: "race-1",
    inviteeIds: ["friend-1"],
  });
  assert.equal(ctx.state.createdRecords.length, 1);
  assert.equal(ctx.state.createdRecords[0].status, "INVITED");
});

test("production invite creation is fenced C0 then competition row", async () => {
  const calls = [];
  const race = teamRace({ isTeamRace: false, teamSize: null });
  const tx = {
    async $queryRawUnsafe() { calls.push("competition"); return [{ id: race.id }]; },
    race: { async findUnique() { return race; } },
    raceParticipant: {
      async findMany() { return [{ userId: "creator", status: "ACCEPTED" }]; },
      async createMany() { calls.push("create"); return { count: 1 }; },
    },
  };
  const invite = buildInviteToRace({
    Race: { async findById() { return race; } },
    RaceParticipant: { async findByRace() { return race.participants; } },
    Friendship: { async findBetweenUsers() { return { status: "ACCEPTED" }; } },
    User: { async findById(id) { return { id, clientFeatures: [] }; } },
    eventBus: { emit() {} },
    prisma: { async $transaction(callback) { calls.push("tx"); return callback(tx); } },
    async acquireRaceWriteFence() { calls.push("c0"); },
  });

  await invite({ userId: "creator", raceId: race.id, inviteeIds: ["friend"] });
  assert.deepEqual(calls.slice(0, 4), ["tx", "c0", "competition", "create"]);
});
