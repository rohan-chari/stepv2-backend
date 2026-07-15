const assert = require("node:assert/strict");
const test = require("node:test");

const {
  registerNotificationHandlers,
} = require("../../src/handlers/notificationHandlers");

function createMockEventBus() {
  const handlers = new Map();
  return {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    async emit(event, data) {
      const fns = handlers.get(event) || [];
      for (const fn of fns) {
        await fn(data);
      }
    },
  };
}

function makeHarness({ race = null, now } = {}) {
  const eventBus = createMockEventBus();
  const sent = [];
  const recorded = [];
  registerNotificationHandlers({
    eventBus,
    User: {
      async findById(id) {
        return { id, displayName: `Name-${id}` };
      },
    },
    DeviceToken: {
      async findByUserId(userId) {
        return [{ token: `token-${userId}`, platform: "ios" }];
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendNotification(args) {
        sent.push(args);
        return { success: true };
      },
      async sendSilentNotification(args) {
        return { success: true };
      },
    },
    Notification: {
      async create(row) {
        recorded.push(row);
        return row;
      },
    },
    Race: {
      async findUnique() {
        return race;
      },
      async findById() {
        return race;
      },
    },
    logger: { warn() {}, error() {} },
    now,
  });
  return { eventBus, sent, recorded };
}

// ── TR-681: team lead change push ───────────────────────────────────────────
test("TR-681 TEAM_LEAD_CHANGED pushes team-framed copy to every member", async () => {
  const { eventBus, sent } = makeHarness();
  await eventBus.emit("TEAM_LEAD_CHANGED", {
    raceId: "race-1",
    raceName: "Team Battle",
    leadingTeam: "TEAM_A",
    leadingTeamName: "Swift Capys",
    trailingTeamName: "Turbo Beavers",
    leadingTotal: 10000,
    trailingTotal: 9000,
    memberUserIds: ["a1", "a2", "b1", "b2"],
    memberTeams: { a1: "TEAM_A", a2: "TEAM_A", b1: "TEAM_B", b2: "TEAM_B" },
  });
  assert.equal(sent.length, 4, "all members of both teams");
  assert.match(sent[0].body, /Swift Capys/);
  assert.match(sent[0].body, /lead/i);
  assert.equal(sent[0].payload.type, "TEAM_LEAD_CHANGED");
  assert.equal(sent[0].payload.params.raceId, "race-1");
});

test("TR-681 lead-change pushes are throttled per race (overtake-nudge window)", async () => {
  const { eventBus, sent } = makeHarness();
  const payload = {
    raceId: "race-throttle",
    raceName: "Team Battle",
    leadingTeam: "TEAM_A",
    leadingTeamName: "Swift Capys",
    trailingTeamName: "Turbo Beavers",
    leadingTotal: 10000,
    trailingTotal: 9000,
    memberUserIds: ["a1", "b1"],
    memberTeams: { a1: "TEAM_A", b1: "TEAM_B" },
  };
  await eventBus.emit("TEAM_LEAD_CHANGED", payload);
  await eventBus.emit("TEAM_LEAD_CHANGED", {
    ...payload,
    leadingTeam: "TEAM_B",
    leadingTeamName: "Turbo Beavers",
    trailingTeamName: "Swift Capys",
  });
  assert.equal(sent.length, 2, "second flip within the window is throttled");
});

// ── TR-682: final-stretch team push, leading + trailing variants ────────────
test("TR-682 TEAM_FINAL_STRETCH sends trailing and leading variants", async () => {
  const { eventBus, sent } = makeHarness();
  await eventBus.emit("TEAM_FINAL_STRETCH", {
    raceId: "race-1",
    raceName: "Team Battle",
    teamAName: "Swift Capys",
    teamBName: "Turbo Beavers",
    teamATotal: 12000,
    teamBTotal: 8600,
    endsAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
    memberUserIds: ["a1", "b1"],
    memberTeams: { a1: "TEAM_A", b1: "TEAM_B" },
  });
  assert.equal(sent.length, 2);
  const toLeader = sent.find((s) => s.deviceToken === "token-a1");
  const toTrailer = sent.find((s) => s.deviceToken === "token-b1");
  assert.match(toLeader.body, /up 3,400|up 3400/i);
  assert.match(toLeader.body, /hold/i);
  assert.match(toTrailer.body, /down 3,400|down 3400/i);
});

test("TR-682 final-stretch push respects the 30-min throttle per race+member", async () => {
  const { eventBus, sent } = makeHarness();
  const payload = {
    raceId: "race-2",
    raceName: "Team Battle",
    teamAName: "Swift Capys",
    teamBName: "Turbo Beavers",
    teamATotal: 12000,
    teamBTotal: 8600,
    endsAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
    memberUserIds: ["a1"],
    memberTeams: { a1: "TEAM_A" },
  };
  await eventBus.emit("TEAM_FINAL_STRETCH", payload);
  await eventBus.emit("TEAM_FINAL_STRETCH", payload);
  assert.equal(sent.length, 1);
});

// ── TR-683: slacker nudge copy ──────────────────────────────────────────────
test("TR-683 TEAM_SLACKER_NUDGE sends one playful push to the member", async () => {
  const { eventBus, sent, recorded } = makeHarness();
  await eventBus.emit("TEAM_SLACKER_NUDGE", {
    raceId: "race-1",
    raceName: "Team Battle",
    userId: "a3",
    teamName: "Swift Capys",
    totalSteps: 100,
    teamAverage: 6000,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].deviceToken, "token-a3");
  assert.match(sent[0].body, /Swift Capys/);
  assert.equal(sent[0].payload.type, "TEAM_SLACKER_NUDGE");
  // Recorded so the job's once-per-race dedup holds across restarts.
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].type, "TEAM_SLACKER_NUDGE");
  assert.equal(recorded[0].raceId, "race-1");
});

// ── TR-684: team-framed start/complete ──────────────────────────────────────
test("TR-684 RACE_STARTED uses team-framed copy for team races", async () => {
  const { eventBus, sent } = makeHarness();
  await eventBus.emit("RACE_STARTED", {
    raceId: "race-1",
    raceName: "Team Battle",
    creatorUserId: "a1",
    participantUserIds: ["a1", "b1"],
    isTeamRace: true,
    teamAName: "Swift Capys",
    teamBName: "Turbo Beavers",
  });
  // creator excluded (existing behavior) -> one push to b1
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /Swift Capys/);
  assert.match(sent[0].body, /Turbo Beavers/);
});

test("TR-684 RACE_COMPLETED frames win/loss by team name", async () => {
  const { eventBus, sent } = makeHarness();
  await eventBus.emit("RACE_COMPLETED", {
    raceId: "race-1",
    winnerUserId: null,
    winnerTeam: "TEAM_A",
    tie: false,
    winnerTeamName: "Swift Capys",
    loserTeamName: "Turbo Beavers",
    memberTeams: { a1: "TEAM_A", b1: "TEAM_B" },
    participantUserIds: ["a1", "b1"],
  });
  assert.equal(sent.length, 2);
  const toWinner = sent.find((s) => s.deviceToken === "token-a1");
  const toLoser = sent.find((s) => s.deviceToken === "token-b1");
  assert.match(toWinner.body, /Swift Capys/);
  assert.match(toWinner.body, /win|won/i);
  assert.match(toLoser.body, /Swift Capys|Turbo Beavers/);
});

test("TR-404 RACE_COMPLETED tie push says buy-ins refunded", async () => {
  const { eventBus, sent } = makeHarness();
  await eventBus.emit("RACE_COMPLETED", {
    raceId: "race-1",
    winnerUserId: null,
    winnerTeam: null,
    tie: true,
    winnerTeamName: null,
    loserTeamName: null,
    memberTeams: { a1: "TEAM_A", b1: "TEAM_B" },
    participantUserIds: ["a1", "b1"],
  });
  assert.equal(sent.length, 2);
  assert.match(sent[0].body, /tie/i);
  assert.match(sent[0].body, /refunded/i);
});

test("RACE_COMPLETED keeps the individual copy for non-team races", async () => {
  const { eventBus, sent } = makeHarness();
  await eventBus.emit("RACE_COMPLETED", {
    raceId: "race-1",
    winnerUserId: "u1",
    participantUserIds: ["u1", "u2"],
  });
  assert.equal(sent.length, 2);
  assert.match(sent[0].body, /Name-u1 won the race!/);
});
